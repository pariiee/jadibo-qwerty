'use strict';

/**
 * controllers/walletController.js — dompet: top up, perpanjang dari saldo,
 * auto-perpanjang.
 *
 * Ruang lingkupnya SENGAJA sempit: saldo cuma buat top up dan memperpanjang
 * paket. Tidak ada tarik saldo, tidak ada transfer antar user, dan tidak
 * menyentuh `bot_sewa`.
 *
 * ATURAN YANG MEMEGANG FILE INI:
 *   1. Setiap perubahan `users.saldo` WAJIB disertai satu baris `wallet_ledger`
 *      di transaksi yang SAMA. Kalau tidak, SUM(jumlah) != saldo dan riwayatnya
 *      berhenti bisa dipercaya. Ada endpoint admin yang membuktikannya.
 *   2. `ref` ledger menentukan idempotensi (UNIK di DB — lihat schema.sql).
 *   3. Saldo TIDAK PERNAH boleh minus. Dijaga `FOR UPDATE` + cek, bukan cuma
 *      karena kolomnya BIGINT SIGNED.
 *   4. Perpanjang dari saldo TIDAK PERNAH membuat baris `orders`. Uangnya sudah
 *      dihitung sebagai pendapatan waktu top up; bikin order baru berarti
 *      menghitung uang yang sama dua kali.
 *
 * ── URUTAN KUNCI (bebas deadlock) ────────────────────────────────────────────
 * `SELECT saldo FROM users WHERE id = ? FOR UPDATE` DULU, baru `terapkanPaket`
 * menyentuh `bots`. Satu jalur, urut users -> bots: tidak ada siklus, jadi dua
 * perpanjang bersamaan (atau perpanjang bareng cron) berbaris rapi, bukan
 * saling tunggu.
 */

const crypto = require('crypto');
const { pool } = require('../config/database');
const pricingStore = require('../config/pricingStore');
const topup = require('../config/topup');
const qrisku = require('../config/qrisku');

const rupiah = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');

function sendError(res, status, message) {
  return res.status(status).json({ ok: false, message });
}

/** ID order yang gampang dibaca & tidak bisa ditebak. Bentuknya sama dengan billing. */
const buatOrderId = () =>
  'TP' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();

/**
 * Paket yang BOLEH dibeli dari saldo. Pencocokan EKSAK, `price <= 0` ditolak.
 *
 * Alasannya sama dengan gerbang di `terapkanPaket`: `pricingStore.getPlan()`
 * fallback ke paket Gratis, jadi id yang salah TIDAK melempar — dia diam-diam
 * "membeli" paket Gratis dan menghabiskan paket user. Dan paket harga 0
 * (Gratis/Trial) memang bukan barang: memperpanjangnya tidak berarti apa-apa,
 * tapi saldo tetap terpotong kalau lolos.
 */
function paketBisaDibeli(planId) {
  const plan = pricingStore.plans().find((p) => p.id === planId);
  if (!plan) return { ok: false, message: 'Paket tidak dikenal' };
  if (Number(plan.price) <= 0) return { ok: false, message: 'Paket ini tidak bisa dibeli dengan saldo' };
  if (Number(plan.days) <= 0) return { ok: false, message: 'Paket ini tidak punya masa aktif' };
  return { ok: true, plan };
}

// ─── Top up ───────────────────────────────────────────────────────────────────

/**
 * Kredit saldo untuk satu order top up yang sudah dinyatakan lunas.
 *
 * DIPANGGIL DARI `billingController.tandaiLunas` (bukan memanggil balik ke
 * sana) — jadi webhook, tombol "Cek status", dan konfirmasi admin SEMUANYA
 * lewat satu fungsi ini. Tiga jalur, satu implementasi: itu yang bikin
 * "ketiganya bersamaan -> saldo bertambah sekali" benar secara struktur, bukan
 * secara kebetulan.
 *
 * IDEMPOTEN lewat dua lapis, dan urutannya penting:
 *   1. `UPDATE orders ... WHERE status IN ('pending','expired')` +
 *      affectedRows === 1. Ini penjaga UTAMA: hanya satu pemanggil yang boleh
 *      melanjutkan. Status 'expired' ikut diterima karena QRISku bisa
 *      menyatakan paid setelah QR lewat 5 menit — pembayarannya nyata.
 *   2. `ref = 'topup:<orderId>'` yang UNIK di wallet_ledger. Sabuk kedua kalau
 *      ada pemanggil yang entah bagaimana lolos penjaga pertama; INSERT
 *      keduanya ditolak MySQL (ER_DUP_ENTRY), jadi saldo tidak mungkin dobel.
 *
 * Kedua lapis memang kelihatan berlebihan sampai ada webhook ganda. QRISku
 * mengirim ulang sampai 4x (immediate, 1s, 5s, 15s) dan setiap pengiriman itu
 * membawa event_id berbeda dengan status paid — tanpa penjaga, user top up
 * Rp50.000 empat kali.
 *
 * YANG DIKREDIT ADALAH `orders.amount`, BUKAN nominal dari payload gateway.
 * Payload cuma dipakai MEMVERIFIKASI. Nominal dari luar itu angka yang
 * dikendalikan pihak lain; kalau dipercaya, siapa pun bisa mengirim webhook
 * "paid 1.000.000" untuk order 10.000.
 *
 * @param {{user_id:number, order_id:string, amount:number, plan:string, status:string}} order
 * @param {object} data  payload gateway (opsional; konfirmasi admin tidak punya)
 */
async function terapkanTopup(order, data) {
  if (!order) return { status: 'unknown', sudah: false, error: 'order kosong' };
  // Sabuk pengaman: fungsi ini cuma buat order top up. Salah kirim dari jalur
  // paket akan mengkredit saldo dari order paket — jadi ditolak, bukan diproses.
  if (order.plan !== 'topup') {
    console.error(`[Wallet] terapkanTopup dipanggil untuk plan '${order.plan}' — DITOLAK`);
    return { status: order.status, sudah: false, error: 'bukan order topup' };
  }

  const jumlah = Number(order.amount);
  if (!Number.isInteger(jumlah) || jumlah <= 0) {
    console.error(`[Wallet] order ${order.order_id} nominal tidak valid: ${order.amount}`);
    return { status: order.status, sudah: false, error: 'nominal order tidak valid' };
  }

  // ── Verifikasi nominal dari gateway (kalau gateway mengirimnya) ─────────────
  // QRISku TIDAK menambah kode unik dan kita tidak pernah mengirim `fee`, jadi
  // yang dibayar seharusnya sama persis dengan yang diorder. Tapi kalau gateway
  // suatu saat menambah biaya, atau webhook dikirim untuk order lain, selisihnya
  // harus KETAHUAN — bukan diam-diam dikredit.
  //
  // Tidak dikredit, dan webhook tetap dibalas OK (biar gateway berhenti mengirim
  // ulang): ordernya ditinggal pending supaya admin memutuskan lewat konfirmasi
  // manual, dan alasannya ditulis ke `orders.note` — kolom yang sudah tampil di
  // tab order admin. Kalau nominalnya memang beda secara sah, admin bisa
  // menyelesaikannya lewat POST /api/admin/wallet/users/:userId/adjust.
  const nominalGateway = Number(data?.amount ?? data?.base_amount ?? NaN);
  if (Number.isFinite(nominalGateway) && nominalGateway !== jumlah) {
    const pesan = `nominal gateway ${nominalGateway} != order ${jumlah}`;
    console.error(`[Wallet] ${order.order_id} NOMINAL TIDAK COCOK: ${pesan} — TIDAK dikredit`);
    try {
      await pool.execute(
        "UPDATE orders SET note = ? WHERE order_id = ? AND status IN ('pending','expired')",
        [`NOMINAL TIDAK COCOK: ${pesan}`.slice(0, 250), order.order_id]
      );
    } catch (e) {
      console.error(`[Wallet] gagal catat mismatch ${order.order_id}: ${e.message}`);
    }
    return { status: order.status, sudah: false, error: pesan, mismatch: true };
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Penjaga utama. `expired` ikut: pembayaran telat tetap sah.
    const [upd] = await conn.execute(
      "UPDATE orders SET status = 'paid', paid_at = NOW(), note = ? WHERE order_id = ? AND status IN ('pending','expired')",
      [data?.payment_reference_id ? String(data.payment_reference_id).slice(0, 250) : null, order.order_id]
    );
    if (upd.affectedRows !== 1) {
      await conn.rollback();
      return { status: 'paid', sudah: true };
    }

    // Kunci baris user: dua top up bersamaan untuk user yang sama harus
    // berurutan, supaya `saldo_sesudah` di ledger tidak salah satu.
    const [rows] = await conn.execute(
      'SELECT saldo FROM users WHERE id = ? FOR UPDATE',
      [order.user_id]
    );
    if (!rows[0]) {
      await conn.rollback();
      console.error(`[Wallet] user ${order.user_id} tidak ada untuk order ${order.order_id}`);
      return { status: order.status, sudah: false, error: 'user tidak ditemukan' };
    }
    const saldoBaru = Number(rows[0].saldo) + jumlah;

    await conn.execute('UPDATE users SET saldo = ? WHERE id = ?', [saldoBaru, order.user_id]);
    await conn.execute(
      `INSERT INTO wallet_ledger (user_id, tipe, jumlah, saldo_sesudah, ref, alasan)
       VALUES (?, 'topup', ?, ?, ?, ?)`,
      [order.user_id, jumlah, saldoBaru, `topup:${order.order_id}`, data?.payment_reference_id || null]
    );

    await conn.commit();
    console.log(`[Wallet] topup ${order.order_id} → user ${order.user_id} +${rupiah(jumlah)} (saldo ${rupiah(saldoBaru)})`);
    return { status: 'paid', saldo: saldoBaru, kredit: jumlah, tipe: 'topup' };
  } catch (e) {
    try { await conn.rollback(); } catch {}
    // ER_DUP_ENTRY di ref = sabuk kedua bekerja: order ini sudah pernah
    // dikredit. Bukan kegagalan — laporkan sebagai sudah.
    if (e.code === 'ER_DUP_ENTRY') {
      console.warn(`[Wallet] topup ${order.order_id} sudah pernah dikredit (ref duplikat) — diabaikan`);
      return { status: 'paid', sudah: true };
    }
    console.error(`[Wallet] terapkanTopup ${order.order_id} GAGAL (di-rollback): ${e.message}`);
    return { status: order.status, sudah: false, error: e.message };
  } finally {
    conn.release();
  }
}

/**
 * POST /api/wallet/topup — bikin order QRIS untuk menambah saldo.
 *
 * Nominal datang dari klien TAPI selalu divalidasi ulang di sini, dan yang
 * dikirim ke gateway adalah HASIL validasi itu, bukan angka mentahnya. Kalau
 * klien bisa menentukan nominal bebas, dia bisa top up Rp1 — atau Rp1e21.
 */
async function buatOrderTopup(req, res) {
  try {
    const v = topup.validasiNominal(req.body?.nominal);
    if (!v.ok) return sendError(res, 400, v.message);
    const nominal = v.nominal;

    // Batas order menggantung. Dihitung HANYA dari order yang belum lewat masa
    // berlaku QRIS (5 menit): order yang sudah mati tidak boleh mengunci user
    // dari top up lagi. Tanpa syarat itu, user yang QR-nya kedaluwarsa tiga kali
    // tidak bisa mencoba lagi sama sekali — padahal tidak ada uang yang nyangkut.
    const [pending] = await pool.execute(
      `SELECT COUNT(*) AS c FROM orders
        WHERE user_id = ? AND plan = 'topup' AND status = 'pending'
          AND (expired_at > UTC_TIMESTAMP()
               OR (expired_at IS NULL AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? SECOND)))`,
      [req.user.id, Math.floor(topup.MASA_QRIS_MS / 1000)]
    );
    if (Number(pending[0].c) >= topup.TOPUP_MAKS_PENDING) {
      return sendError(res, 429,
        `Kamu masih punya ${topup.TOPUP_MAKS_PENDING} order yang belum dibayar. ` +
        'Selesaikan, atau tunggu QR-nya kedaluwarsa (5 menit).');
    }

    const orderId = buatOrderId();
    const tagihan = await qrisku.buatTagihan({ amount: nominal, method: 'shoppee' });
    const kedaluwarsa = tagihan.expired_at
      ? new Date(tagihan.expired_at * 1000)
      // Cadangan kalau gateway tidak mengirim `expired_at`: pakai masa QRIS dari
      // config, supaya order ini tetap bisa dinilai "masih hidup atau tidak"
      // oleh batas pending di atas.
      : new Date(Date.now() + topup.MASA_QRIS_MS);

    await pool.execute(
      `INSERT INTO orders
         (order_id, user_id, plan, amount, method, status, gateway_ref, qr_image, qr_payload, expired_at)
       VALUES (?, ?, 'topup', ?, 'gateway', 'pending', ?, ?, ?, ?)`,
      [orderId, req.user.id, nominal, tagihan.id,
       tagihan.qr_url || null, tagihan.payment_link || null, kedaluwarsa]
    );

    return res.status(201).json({
      ok: true,
      order_id: orderId,
      nominal,
      nominal_text: rupiah(nominal),
      qris_image: tagihan.qr_url || null,
      pay_url: tagihan.payment_link || null,
      expired_at: kedaluwarsa,
      // Ditegaskan ke UI: yang masuk saldo adalah NOMINAL ORDER, bukan nominal
      // yang mungkin ditambah gateway. Sekarang keduanya sama (kita tidak kirim
      // `fee`), tapi teks ini yang benar kalau nanti berubah.
      keterangan: `Saldo bertambah ${rupiah(nominal)} setelah pembayaran terkonfirmasi.`,
    });
  } catch (err) {
    console.error('[Wallet] buatOrderTopup error:', err.message);
    return sendError(res, 502, 'Gagal membuat tagihan. Coba lagi nanti.');
  }
}

// ─── Perpanjang dari saldo ────────────────────────────────────────────────────

/**
 * Potong saldo lalu perpanjang paket — SATU transaksi.
 *
 * Kalau `terapkanPaket` gagal, SEMUANYA rollback: saldo tidak terpotong dan
 * ledger tidak ditulis. Itu sebabnya efek samping paket (nyalakan bot, notif)
 * dijalankan SETELAH commit, bukan di dalam.
 *
 * HARGA TIDAK PERNAH DARI KLIEN. Klien cuma kirim `planId`; harga dan masa
 * aktif dibaca dari `pricingStore` di sini — dan `terapkanPaket` memakai
 * mekanisme yang SAMA dengan pembayaran QRIS, jadi perilakunya identik: sisa
 * masa aktif yang masih jalan DITAMBAH, bukan dihitung ulang dari sekarang.
 * Beli di tengah periode tidak menghanguskan sisa hari.
 *
 * TIDAK membuat baris `orders`: uangnya sudah dihitung pendapatan waktu top up.
 */
async function perpanjangDariSaldo(userId, planId, { tipe = 'perpanjang', ref = null, alasan = null } = {}) {
  const cek = paketBisaDibeli(planId);
  if (!cek.ok) return { ok: false, reason: 'paket_tidak_valid', message: cek.message };
  const { plan } = cek;
  const harga = Number(plan.price);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Kunci DULU, baru hitung. Tanpa FOR UPDATE, 50 klik bersamaan membaca
    // saldo yang sama, semuanya lolos cek "cukup", dan saldo jadi minus 49x.
    const [rows] = await conn.execute(
      'SELECT saldo FROM users WHERE id = ? FOR UPDATE',
      [userId]
    );
    if (!rows[0]) {
      await conn.rollback();
      return { ok: false, reason: 'user_tidak_ada', message: 'User tidak ditemukan' };
    }
    const saldo = Number(rows[0].saldo);
    if (saldo < harga) {
      await conn.rollback();
      return {
        ok: false, reason: 'saldo_kurang',
        message: `Saldo kamu ${rupiah(saldo)}, butuh ${rupiah(harga)}`,
        saldo, butuh: harga,
      };
    }

    const saldoBaru = saldo - harga;
    // Ref perpanjang MANUAL: resolusi milidetik + planId.
    //
    // Sengaja bukan angka acak: dobel-klik pada tombol yang sama dalam
    // milidetik yang sama akan menghasilkan ref yang SAMA, jadi yang kedua
    // ditolak DB (ER_DUP_ENTRY) dan user tidak tercharge dua kali. Dengan ref
    // acak, dobel-klik justru lolos dua-duanya.
    //
    // ponytail: kunci idempotensi manual = (user, paket, milidetik). Dua
    // pembelian SENGAJA dalam milidetik yang sama akan ditolak — praktis tidak
    // mungkin dari UI, dan menolaknya lebih baik daripada mencharge dobel.
    // Kalau nanti butuh tombol "beli 2x sekaligus", kirim idempotency key dari
    // klien, jangan longgarkan ref ini.
    const refLedger = ref || `perpanjang:${userId}:${plan.id}:${Date.now()}`;

    // ── LEDGER DULU, PAKET BELAKANGAN — dan urutan ini yang penting ──────────
    //
    // `ref` yang UNIK di wallet_ledger adalah penjaga idempotensinya. Kalau
    // baris ledger ditulis SESUDAH `terapkanPaket`, percobaan kedua (ref sama)
    // sempat menjalankan `UPDATE users SET plan_expired_at = ...` lebih dulu —
    // masa aktifnya BERTAMBAH sebulan sebelum barisnya ditolak ER_DUP_ENTRY.
    // Saldonya memang utuh (transaksinya rollback), tapi paketnya bertambah
    // gratis: 5 percobaan duplikat = +152 hari padahal cuma bayar sekali.
    //
    // Ditaruh di depan, percobaan kedua gagal di baris ini dan TIDAK PERNAH
    // sampai menyentuh users/bots. Rollback tetap aman: UPDATE saldo di atas dan
    // baris ledger ini dibatalkan bersama-sama kalau ada yang gagal setelahnya.
    await conn.execute('UPDATE users SET saldo = ? WHERE id = ?', [saldoBaru, userId]);
    await conn.execute(
      `INSERT INTO wallet_ledger (user_id, tipe, jumlah, saldo_sesudah, ref, alasan)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, tipe, -harga, saldoBaru, refLedger, alasan || `Perpanjang paket ${plan.name}`]
    );

    // Ikut transaksi ini. Efek sampingnya DITUNDA — lihat `terapkanPaket`.
    const hasil = await require('./billingController').terapkanPaket(userId, plan.id, null, conn);

    // COMMIT DI DALAM SINI, bukan diserahkan ke `terapkanPaket`.
    //
    // Sebelumnya `terapkanPaket(conn)` yang memanggil `conn.commit()`, dan itu
    // rapuh: kalau ada pemanggil lain yang lupa, uangnya tidak tersimpan — atau
    // lebih buruk, commit terjadi lalu ada yang gagal SESUDAH commit sehingga
    // tidak bisa di-rollback lagi. Satu fungsi, satu tanggung jawab: `terapkanPaket`
    // menulis, pemilik transaksi yang commit/rollback.
    await conn.commit();

    // Baru sekarang: nyalakan bot & kabari. Gagalnya tidak membatalkan apa pun
    // (sudah dibungkus try/catch di dalam sana).
    Promise.resolve()
      .then(() => require('./billingController').jalankanEfekSamping(hasil.efekSamping))
      .catch(() => {});

    console.log(`[Wallet] ${tipe} user ${userId} paket ${plan.id} -${rupiah(harga)} (saldo ${rupiah(saldoBaru)})`);
    return {
      ok: true, plan: plan.id, plan_name: plan.name, harga,
      saldo: saldoBaru, sampai: hasil.sampai, tipe,
    };
  } catch (e) {
    try { await conn.rollback(); } catch {}
    // ER_DUP_ENTRY di ref = periode ini sudah pernah diperpanjang (cron jalan
    // dua kali). Bukan kegagalan — jangan lapor sebagai error.
    if (e.code === 'ER_DUP_ENTRY') {
      return { ok: false, reason: 'sudah_diperpanjang', message: 'Periode ini sudah diperpanjang' };
    }
    console.error(`[Wallet] perpanjangDariSaldo user ${userId} GAGAL (di-rollback): ${e.message}`);
    return { ok: false, reason: 'gagal', message: 'Gagal memperpanjang paket' };
  } finally {
    conn.release();
  }
}

/**
 * POST /api/wallet/perpanjang — { plan: 'basic', idempotency_key?: '<uuid>' }.
 *
 * Harga & masa dari server; klien cuma menentukan paket mana.
 *
 * TIGA lapis terhadap dobel-klik / request ganda, dari yang paling luar:
 *
 *  1. JEDA 30 DETIK per (user, paket). Menangkap dobel-klik yang ref-nya BEDA
 *     (klien tanpa idempotency_key, dua klik di milidetik berbeda) — kasus yang
 *     tidak bisa ditangkap `ref` karena ref-nya memang berbeda.
 *  2. `idempotency_key` dari klien dipakai sebagai `ref` ledger: request yang
 *     terkirim dua kali dengan kunci SAMA ditolak ER_DUP_ENTRY.
 *  3. Tanpa kunci klien, `ref` = (user, paket, milidetik) — dobel-klik di
 *     milidetik yang sama tetap tertangkap.
 *
 * Lapis 1 dan 2/3 saling melengkapi: 1 menahan sebelum menyentuh DB, 2/3 menahan
 * di level DB (tahan terhadap dua proses/worker).
 */
async function perpanjang(req, res) {
  try {
    const planId = String(req.body?.plan || '').trim();

    // Kunci dari klien divalidasi bentuknya sebelum dipakai jadi `ref`:
    // panjang dibatasi (kolomnya VARCHAR(120)) dan karakter dibatasi supaya
    // tidak ada yang menyelipkan sesuatu yang aneh ke jurnal.
    let ref = null;
    const kunci = req.body?.idempotency_key;
    if (kunci !== undefined && kunci !== null && kunci !== '') {
      const k = String(kunci).trim();
      if (!/^[A-Za-z0-9._:-]{8,80}$/.test(k)) {
        return sendError(res, 400, 'idempotency_key tidak valid');
      }
      ref = `perpanjang:${req.user.id}:k:${k}`;
    }

    // Lapis 1: jeda. Ditaruh SEBELUM validasi paket supaya percobaan beruntun
    // tidak menghabiskan jatah limiter maupun menyentuh DB.
    //
    // Kalau ada idempotency_key, jeda TIDAK diterapkan: kuncinya sudah menjamin
    // idempotensi, dan user yang sengaja membeli dua kali (mis. memperpanjang
    // sampai 2 tahun) harus bisa. Jeda ini khusus untuk request yang TIDAK
    // membawa kunci — di situ tidak ada cara membedakan "dobel-klik" dari
    // "memang mau dua kali", jadi jeda yang dipilih.
    if (!ref && masihJeda(req.user.id, planId)) {
      return res.status(429).json({
        ok: false,
        reason: 'terlalu_cepat',
        message: 'Permintaan perpanjang baru saja diproses. Tunggu sebentar sebelum mengulang.',
      });
    }

    const hasil = await perpanjangDariSaldo(req.user.id, planId, { ref });
    if (!hasil.ok) {
      // 402 Payment Required untuk saldo kurang — beda dari 400 (permintaan
      // salah). Yang perlu dilakukan user adalah top up, bukan memperbaiki
      // isian form.
      if (hasil.reason === 'sudah_diperpanjang') {
        // 200 + ok:true: bagi user ini BUKAN kegagalan — permintaannya memang
        // sudah terpenuhi (barusan, oleh request yang sama).
        return res.json({ ok: true, sudah: true, message: 'Permintaan ini sudah diproses sebelumnya.' });
      }
      const kode = hasil.reason === 'saldo_kurang' ? 402 : 400;
      return res.status(kode).json({ ok: false, message: hasil.message, saldo: hasil.saldo, reason: hasil.reason });
    }
    return res.json({
      ok: true,
      message: `Paket ${hasil.plan_name} diperpanjang. Saldo sekarang ${rupiah(hasil.saldo)}.`,
      ...hasil,
    });
  } catch (err) {
    console.error('[Wallet] perpanjang error:', err.message);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// Jeda anti-dobel-klik untuk perpanjang manual tanpa idempotency_key.
//
// ponytail: map di memori, per PROSES. Cukup karena app ini satu proses; kalau
// nanti di-scale ke beberapa worker, ganti ke kunci di DB (baris per user) —
// penjaga `ref` ledger sudah tahan lintas-proses, ini cuma lapis pertama.
const KUNCI_PER_ID = new Map();
const JEDA_PERPANJANG_MS = 30_000;

/** true = masih dalam jeda (tolak). false = boleh, dan jedanya dibuka. */
function masihJeda(userId, planId) {
  const k = `${userId}:${planId}`;
  const t = KUNCI_PER_ID.get(k) || 0;
  if (Date.now() - t < JEDA_PERPANJANG_MS) return true;
  KUNCI_PER_ID.set(k, Date.now());
  // Bersihkan yang sudah lewat supaya map-nya tidak tumbuh selamanya.
  if (KUNCI_PER_ID.size > 5000) {
    const batas = Date.now() - JEDA_PERPANJANG_MS;
    for (const [kk, v] of KUNCI_PER_ID) if (v < batas) KUNCI_PER_ID.delete(kk);
  }
  return false;
}

/**
 * Cron auto-perpanjang. Dijalankan TIAP JAM dari `server.js`.
 *
 * SATU basis waktu: SQL pakai `UTC_TIMESTAMP()` (pool-nya di-set '+00:00').
 * Jangan campur `CURDATE()`/`NOW()` lokal dengan kolom UTC — campur begitu bikin
 * jendela 24 jamnya meleset 7 jam di WIB, dan paket habis tanpa diperpanjang.
 *
 * IDEMPOTEN lewat `ref = 'auto:<userId>:<plan_expired_at>'`. Tanggal kedaluwarsa
 * adalah bagian dari kunci, jadi:
 *   - cron jalan dua kali untuk periode yang sama -> INSERT kedua ditolak
 *     (ER_DUP_ENTRY), saldo terpotong SEKALI
 *   - periode BERIKUTNYA (tanggalnya sudah bergeser) -> ref berbeda, boleh lagi
 * Tanpa tanggal di ref, perpanjangan bulan depan akan dianggap duplikat dan
 * paket user diam-diam berhenti diperpanjang.
 *
 * SALDO KURANG: tidak memotong sebagian, tidak memperpanjang, user dikabari.
 * Diam di sini = paket habis tanpa penjelasan.
 */
async function autoRenew() {
  const jendela = 24;
  let diproses = 0, sukses = 0, kurang = 0, gagal = 0;

  // Kandidat: auto_renew hidup, paketnya berakhir dalam 24 jam ke depan DAN
  // belum lewat. Yang sudah lewat sengaja di luar jendela: memperpanjang
  // otomatis setelah paket mati berarti menagih user tanpa dia sempat tahu.
  const [kandidat] = await pool.execute(
    `SELECT id, username, plan, plan_expired_at, saldo
       FROM users
      WHERE auto_renew = 1
        AND plan_expired_at IS NOT NULL
        AND plan_expired_at > UTC_TIMESTAMP()
        AND plan_expired_at <= DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR)`,
    [jendela]
  );

  for (const u of kandidat) {
    diproses++;
    const cek = paketBisaDibeli(u.plan);
    if (!cek.ok) {
      // Paket Gratis/Trial/tak dikenal tidak bisa diperpanjang dengan saldo.
      gagal++;
      await tandaiStatus(u.id, 'paket_tidak_bisa_diperpanjang');
      console.warn(`[Wallet] auto-renew user ${u.id} dilewati: ${cek.message} (plan ${u.plan})`);
      continue;
    }

    if (Number(u.saldo) < Number(cek.plan.price)) {
      kurang++;
      await tandaiStatus(u.id, 'saldo_kurang');
      console.warn(`[Wallet] auto-renew user ${u.id} saldo kurang: ${u.saldo} < ${cek.plan.price}`);
      kabariSaldoKurang(u, cek.plan);
      continue;
    }

    const tanggalExpired = tanggalRef(u.plan_expired_at);
    const hasil = await perpanjangDariSaldo(u.id, u.plan, {
      tipe: 'auto',
      ref: `auto:${u.id}:${tanggalExpired}`,
      alasan: `Auto-perpanjang ${cek.plan.name} (berakhir ${tanggalExpired})`,
    });

    if (hasil.ok) {
      sukses++;
      await tandaiStatus(u.id, 'sukses');
      console.log(`[Wallet] auto-renew user ${u.id} OK → sampai ${hasil.sampai.toISOString()}`);
    } else if (hasil.reason === 'sudah_diperpanjang') {
      // Cron jalan dua kali. Bukan masalah — justru bukti penjaganya bekerja.
      console.log(`[Wallet] auto-renew user ${u.id} periode ini sudah diproses — dilewati`);
    } else if (hasil.reason === 'saldo_kurang') {
      kurang++;
      await tandaiStatus(u.id, 'saldo_kurang');
      kabariSaldoKurang(u, cek.plan);
    } else {
      gagal++;
      await tandaiStatus(u.id, hasil.reason || 'gagal');
      console.error(`[Wallet] auto-renew user ${u.id} gagal: ${hasil.message}`);
    }
  }

  if (diproses) {
    console.log(`[Wallet] auto-renew: ${diproses} kandidat, ${sukses} sukses, ${kurang} saldo kurang, ${gagal} gagal`);
  }
  return { diproses, sukses, kurang, gagal };
}

/** `YYYY-MM-DD HH:MM:SS` UTC — dipakai sebagai bagian dari ref idempotensi. */
function tanggalRef(d) {
  const t = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ` +
         `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

/**
 * Simpan hasil percobaan terakhir. Ini yang dibaca /saldo & dashboard buat
 * banner, jadi user tahu KENAPA paketnya tidak diperpanjang — bukan cuma
 * menemukan paketnya habis tanpa penjelasan.
 */
async function tandaiStatus(userId, status) {
  try {
    await pool.execute(
      'UPDATE users SET auto_renew_status = ?, auto_renew_status_at = UTC_TIMESTAMP() WHERE id = ?',
      [String(status).slice(0, 32), userId]
    );
  } catch (e) {
    console.error(`[Wallet] gagal simpan status auto-renew user ${userId}: ${e.message}`);
  }
}

/**
 * Kabari user saldo kurang.
 *
 * Lewat `engine/notify.kirimKeOwner`, dan itu penting: fungsinya mencoba WA
 * (nomor owner) -> nomor HP user -> EMAIL. Dua jalur pertama dikirim LEWAT BOT
 * MILIK USER, jadi justru di kasus inilah — paket mau habis, botnya bisa mati —
 * keduanya ikut mati. Email tidak lewat bot, jadi kabarnya tetap sampai.
 *
 * Tidak di-await: notifikasi itu bonus, cron-nya jangan ikut tertahan.
 */
function kabariSaldoKurang(u, plan) {
  const pesan =
    `⚠️ *Auto-perpanjang gagal — saldo kurang.*\n\n` +
    `Paket *${plan.name}* berakhir ${new Date(u.plan_expired_at).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' })}.\n` +
    `Saldo kamu *${rupiah(u.saldo)}*, butuh *${rupiah(plan.price)}*.\n\n` +
    `Top up dulu, lalu perpanjang manual di /saldo. Paket TIDAK dipotong sebagian.`;
  try {
    require('../engine/notify').kirimKeOwner(u.id, pesan).catch(() => {});
  } catch (e) {
    console.error(`[Wallet] notif saldo kurang user ${u.id} gagal: ${e.message}`);
  }
}

// ─── Baca: saldo, riwayat, toggle ─────────────────────────────────────────────

/** GET /api/wallet — saldo + status auto-renew + daftar paket (harga dari server). */
async function ringkasan(req, res) {
  try {
    const [rows] = await pool.execute(
      `SELECT saldo, plan, plan_expired_at, auto_renew, auto_renew_status, auto_renew_status_at
         FROM users WHERE id = ?`,
      [req.user.id]
    );
    if (!rows[0]) return sendError(res, 404, 'User tidak ditemukan');
    const u = rows[0];
    return res.json({
      ok: true,
      saldo: Number(u.saldo),
      saldo_text: rupiah(u.saldo),
      paket: u.plan,
      paket_aktif: !!u.plan_expired_at && new Date(u.plan_expired_at) > new Date(),
      plan_expired_at: u.plan_expired_at,
      auto_renew: !!u.auto_renew,
      // Banner dibaca dari sini. `harga_paket_ini` disertakan supaya pesan
      // "saldo kurang" bisa menyebut angka butuhnya tanpa UI menebak.
      auto_renew_status: u.auto_renew_status || null,
      auto_renew_status_at: u.auto_renew_status_at || null,
      harga_paket_ini: Number((pricingStore.plans().find((p) => p.id === u.plan) || {}).price) || 0,
      topup: {
        min: topup.TOPUP_MIN, max: topup.TOPUP_MAX,
        kelipatan: topup.TOPUP_KELIPATAN, cepat: topup.TOPUP_CEPAT,
        maks_pending: topup.TOPUP_MAKS_PENDING,
      },
      // Paket yang BOLEH dibeli dari saldo. Harga dari server — UI tidak
      // menghitung sendiri, biar tidak ada dua sumber angka.
      plans: pricingStore.plans()
        .filter((p) => p.id !== 'user' && Number(p.price) > 0 && Number(p.days) > 0)
        .map((p) => ({ id: p.id, name: p.name, price: p.price, price_text: rupiah(p.price), days: p.days })),
    });
  } catch (err) {
    console.error('[Wallet] ringkasan error:', err.message);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

/**
 * GET /api/wallet/ledger — riwayat dompet.
 *
 * Riwayat dibaca dari LEDGER, bukan dari `orders`: perpanjang dari saldo tidak
 * membuat order, jadi riwayat berbasis order akan menghilangkan setiap
 * perpanjangan — justru transaksi yang paling ingin dilihat user.
 *
 * limit/offset DISISIPKAN setelah divalidasi jadi integer (bukan sebagai
 * parameter), karena `LIMIT ?` di prepared statement bikin MySQL menolak
 * parameternya sebagai string di sebagian versi.
 */
async function riwayat(req, res) {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const [rows] = await pool.execute(
      `SELECT tipe, jumlah, saldo_sesudah, ref, alasan, created_at
         FROM wallet_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`,
      [req.user.id]
    );
    return res.json({
      ok: true,
      ledger: rows.map((r) => ({ ...r, jumlah: Number(r.jumlah), saldo_sesudah: Number(r.saldo_sesudah) })),
      limit, offset,
    });
  } catch (err) {
    console.error('[Wallet] riwayat error:', err.message);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

/** POST /api/wallet/auto-renew — { aktif: true|false }. Default mati. */
async function setAutoRenew(req, res) {
  try {
    const aktif = req.body?.aktif;
    if (typeof aktif !== 'boolean') return sendError(res, 400, 'Nilai harus true atau false');
    await pool.execute(
      // Status lama dibersihkan saat dimatikan: banner "saldo kurang" dari
      // percobaan sebelumnya jadi menyesatkan kalau fiturnya sudah tidak aktif.
      'UPDATE users SET auto_renew = ?, auto_renew_status = NULL, auto_renew_status_at = NULL WHERE id = ?',
      [aktif ? 1 : 0, req.user.id]
    );
    return res.json({
      ok: true,
      auto_renew: aktif,
      message: aktif
        ? 'Auto-perpanjang aktif. Paket diperpanjang otomatis dari saldo 24 jam sebelum habis.'
        : 'Auto-perpanjang dimatikan.',
    });
  } catch (err) {
    console.error('[Wallet] setAutoRenew error:', err.message);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── Admin ────────────────────────────────────────────────────────────────────

/** GET /api/admin/wallet/users — saldo + paket + ringkas jurnal. */
async function adminUsers(req, res) {
  try {
    const cari = String(req.query.q || '').trim();
    const [rows] = await pool.execute(
      `SELECT u.id, u.username, u.saldo, u.plan, u.plan_expired_at,
              u.auto_renew, u.auto_renew_status, u.auto_renew_status_at,
              COALESCE(l.total, 0) AS jurnal_total, COALESCE(l.n, 0) AS jurnal_baris
         FROM users u
         LEFT JOIN (SELECT user_id, SUM(jumlah) AS total, COUNT(*) AS n
                      FROM wallet_ledger GROUP BY user_id) l ON l.user_id = u.id
        ${cari ? 'WHERE u.username LIKE ?' : ''}
        ORDER BY u.saldo DESC, u.id LIMIT 200`,
      cari ? [`%${cari}%`] : []
    );
    return res.json({
      ok: true,
      users: rows.map((u) => ({
        ...u,
        saldo: Number(u.saldo),
        jurnal_total: Number(u.jurnal_total),
        jurnal_baris: Number(u.jurnal_baris),
        // Selisih != 0 berarti ada yang menyentuh saldo tanpa lewat jurnal.
        selisih: Number(u.saldo) - Number(u.jurnal_total),
      })),
    });
  } catch (err) {
    console.error('[Wallet] adminUsers error:', err.message);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

/** GET /api/admin/wallet/users/:userId/ledger */
async function adminLedger(req, res) {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (!Number.isInteger(userId)) return sendError(res, 400, 'ID user tidak valid');
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const [u] = await pool.execute('SELECT username, saldo FROM users WHERE id = ?', [userId]);
    if (!u[0]) return sendError(res, 404, 'User tidak ditemukan');
    const [rows] = await pool.execute(
      `SELECT id, tipe, jumlah, saldo_sesudah, ref, alasan, created_at
         FROM wallet_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ${limit}`,
      [userId]
    );
    return res.json({
      ok: true,
      username: u[0].username,
      saldo: Number(u[0].saldo),
      ledger: rows.map((r) => ({ ...r, jumlah: Number(r.jumlah), saldo_sesudah: Number(r.saldo_sesudah) })),
    });
  } catch (err) {
    console.error('[Wallet] adminLedger error:', err.message);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

/**
 * POST /api/admin/wallet/users/:userId/adjust — koreksi saldo manual.
 *
 * ALASAN WAJIB. Tanpa itu, penyesuaian manual jadi uang yang muncul dari
 * nowhere dan tidak ada yang bisa menjelaskan asalnya — jurnalnya cuma bilang
 * "+50000" tanpa sebab.
 *
 * Boleh negatif (koreksi kelebihan), TAPI hasilnya tidak boleh minus: saldo
 * minus bikin user tidak bisa top up lagi (dia "berutang") dan bikin semua
 * perhitungan berikutnya aneh.
 */
async function adminAdjust(req, res) {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (!Number.isInteger(userId)) return sendError(res, 400, 'ID user tidak valid');

    const jumlah = Number(req.body?.jumlah);
    if (!Number.isInteger(jumlah) || jumlah === 0) {
      return sendError(res, 400, 'Jumlah harus bilangan bulat dan tidak nol');
    }
    const alasan = String(req.body?.alasan || '').trim();
    if (!alasan) return sendError(res, 400, 'Alasan wajib diisi');
    if (alasan.length > 200) return sendError(res, 400, 'Alasan maksimal 200 karakter');

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute('SELECT saldo FROM users WHERE id = ? FOR UPDATE', [userId]);
      if (!rows[0]) { await conn.rollback(); return sendError(res, 404, 'User tidak ditemukan'); }

      const saldoBaru = Number(rows[0].saldo) + jumlah;
      if (saldoBaru < 0) {
        await conn.rollback();
        return sendError(res, 400,
          `Saldo tidak boleh minus (saldo sekarang ${rupiah(rows[0].saldo)}, penyesuaian ${rupiah(jumlah)})`);
      }

      await conn.execute('UPDATE users SET saldo = ? WHERE id = ?', [saldoBaru, userId]);
      await conn.execute(
        `INSERT INTO wallet_ledger (user_id, tipe, jumlah, saldo_sesudah, ref, alasan)
         VALUES (?, 'adjust', ?, ?, ?, ?)`,
        [userId, jumlah, saldoBaru, `adjust:${userId}:${Date.now()}:${crypto.randomBytes(3).toString('hex')}`,
         `Diubah oleh ${req.user.username}: ${alasan}`.slice(0, 255)]
      );
      await conn.commit();

      console.log(`[Wallet] adjust user ${userId} ${jumlah > 0 ? '+' : ''}${jumlah} oleh ${req.user.username}: ${alasan}`);
      return res.json({
        ok: true, saldo: saldoBaru,
        message: `Saldo disesuaikan ${jumlah > 0 ? '+' : ''}${rupiah(jumlah)} → ${rupiah(saldoBaru)}`,
      });
    } catch (e) {
      try { await conn.rollback(); } catch {}
      throw e;
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('[Wallet] adminAdjust error:', err.message);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

/**
 * GET /api/admin/wallet/konsistensi — `SUM(ledger.jumlah)` vs `users.saldo`.
 *
 * Invarian yang dijaga seluruh fitur ini: setiap perubahan saldo meninggalkan
 * satu baris jurnal. Kalau daftar `menyimpang` tidak kosong, ada kode (atau
 * tangan) yang menyentuh `users.saldo` tanpa lewat ledger — dan angka saldo
 * berhenti bisa dipercaya. Ini cara menemukannya SEBELUM user mengeluh.
 */
async function adminKonsistensi(req, res) {
  try {
    const [rows] = await pool.execute(
      `SELECT u.id, u.username, u.saldo, COALESCE(l.total, 0) AS jurnal_total,
              COALESCE(l.n, 0) AS jurnal_baris
         FROM users u
         LEFT JOIN (SELECT user_id, SUM(jumlah) AS total, COUNT(*) AS n
                      FROM wallet_ledger GROUP BY user_id) l ON l.user_id = u.id
        HAVING u.saldo <> jurnal_total
        ORDER BY ABS(u.saldo - jurnal_total) DESC
        LIMIT 200`
    );
    const [total] = await pool.execute('SELECT COALESCE(SUM(saldo), 0) AS beredar FROM users');
    return res.json({
      ok: true,
      konsisten: rows.length === 0,
      // "Saldo beredar" = kewajiban platform ke seluruh user. BUKAN pendapatan:
      // uangnya sudah masuk waktu top up, dan sebagian masih akan dipakai
      // perpanjang.
      saldo_beredar: Number(total[0].beredar),
      saldo_beredar_text: rupiah(total[0].beredar),
      menyimpang: rows.map((r) => ({
        ...r,
        saldo: Number(r.saldo),
        jurnal_total: Number(r.jurnal_total),
        jurnal_baris: Number(r.jurnal_baris),
        selisih: Number(r.saldo) - Number(r.jurnal_total),
      })),
    });
  } catch (err) {
    console.error('[Wallet] adminKonsistensi error:', err.message);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

/**
 * GET /api/admin/wallet/pendapatan — pecahan pendapatan: top up vs paket langsung.
 *
 * SENGAJA TIDAK mengubah rumus di `sistemController.pendapatan`
 * (SUM(orders.amount) WHERE status='paid') — itu sudah benar sebagai pendapatan
 * TUNAI. Perpanjang dari saldo tidak membuat baris `orders`, jadi tidak ada
 * dobel hitung: uangnya sudah dihitung waktu top up-nya masuk.
 *
 * Yang ditambahkan di sini cuma PEMECAHAN + saldo beredar, supaya kelihatan
 * berapa yang datang dari top up, berapa dari bayar paket langsung, dan berapa
 * kewajiban yang masih menggantung sebagai saldo.
 */
async function adminPendapatan(req, res) {
  try {
    const [rows] = await pool.execute(
      `SELECT CASE WHEN plan = 'topup' THEN 'topup' ELSE 'paket_langsung' END AS jenis,
              COUNT(*) AS jumlah, COALESCE(SUM(amount), 0) AS total
         FROM orders WHERE status = 'paid' GROUP BY jenis`
    );
    const [perpanjang] = await pool.execute(
      `SELECT tipe, COUNT(*) AS jumlah, COALESCE(SUM(-jumlah), 0) AS total
         FROM wallet_ledger WHERE tipe IN ('perpanjang','auto') GROUP BY tipe`
    );
    const [beredar] = await pool.execute('SELECT COALESCE(SUM(saldo), 0) AS n FROM users');
    const ambil = (j) => rows.find((r) => r.jenis === j) || { jumlah: 0, total: 0 };
    const topupRow = ambil('topup'), langsungRow = ambil('paket_langsung');
    return res.json({
      ok: true,
      topup: { jumlah: Number(topupRow.jumlah), total: Number(topupRow.total) },
      paket_langsung: { jumlah: Number(langsungRow.jumlah), total: Number(langsungRow.total) },
      // Pemakaian saldo: BUKAN pendapatan baru. Berguna buat melihat berapa
      // banyak saldo yang sudah terpakai.
      saldo_terpakai: perpanjang.map((p) => ({ tipe: p.tipe, jumlah: Number(p.jumlah), total: Number(p.total) })),
      saldo_beredar: Number(beredar[0].n),
      catatan: 'Pendapatan tunai = total orders paid. Pemakaian saldo TIDAK dihitung pendapatan baru.',
    });
  } catch (err) {
    console.error('[Wallet] adminPendapatan error:', err.message);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

/** Map jeda, diekspor buat TES. Jangan dipakai produksi. */
function mapJedaInternal() { return KUNCI_PER_ID; }

module.exports = {
  terapkanTopup, buatOrderTopup,
  perpanjangDariSaldo, perpanjang, autoRenew,
  ringkasan, riwayat, setAutoRenew,
  adminUsers, adminLedger, adminAdjust, adminKonsistensi, adminPendapatan,
  // Diekspor buat tes (murni, tanpa DB).
  paketBisaDibeli, tanggalRef, masihJeda, mapJedaInternal,
};
