'use strict';

/**
 * controllers/billingController.js — langganan jadibot.
 *
 * DUA opsi bayar, dipilih user:
 *   1. manual  — tampil QRIS statis, user scan sendiri, admin yang konfirmasi.
 *   2. gateway — Alpay bikin tagihan; status masuk sendiri lewat webhook.
 *
 * Status TIDAK di-polling. Sumber kebenaran = webhook (gateway) atau konfirmasi
 * admin (manual). Tersedia satu tombol "Cek status" yang dijatah 15 detik per
 * transaksi (config/alpay.js).
 *
 * Idempotensi: penerapan paket hanya jalan saat status berpindah dari 'pending'.
 * UPDATE ... WHERE status = 'pending' + affectedRows === 1 — webhook ganda,
 * klik dobel, atau admin yang tidak sabar tidak akan menambah masa 2x.
 */
const crypto = require('crypto');
const { pool } = require('../config/database');
const pricingStore = require('../config/pricingStore');
const { TRIAL } = require('../config/plan');
const alpay = require('../config/alpay');

function sendError(res, status, message) {
  return res.status(status).json({ ok: false, message });
}

const rupiah = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');

/** ID order yang gampang dibaca & tidak bisa ditebak. */
const buatOrderId = () =>
  'JD' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();

/**
 * Terapkan paket ke user. Masa aktif DITAMBAH dari sisa yang masih jalan,
 * jadi upgrade di tengah periode tidak menghanguskan sisa hari.
 *
 * Pencocokan paket EKSAK — sengaja TIDAK lewat `pricingStore.getPlan()`.
 *
 * `getPlan()` fallback ke `DEFAULT_PLANS[0]` untuk id yang tidak dikenal, dan
 * itu paket Gratis: `{ id:'user', price:0, days:0, daily_limit:10 }`. Jadi id
 * yang salah ketik — atau order top up yang lolos ke sini — tidak melempar,
 * tapi DIAM-DIAM:
 *   - `days || plan.days` jadi 0  -> plan_expired_at = sekarang (paket HABIS)
 *   - daily_limit bot turun ke 10 -> kuota user dirampas
 *   - stop_reason dibersihkan     -> bot dinyalakan dengan paket Gratis
 * User bayar, saldo masuk, paketnya rusak, dan tidak ada satu baris error pun.
 *
 * Karena itu id yang tidak dikenal GAGAL BERISIK di sini. Pemanggilnya jalur
 * uang, jadi lebih baik kelihatan daripada jalan diam-diam.
 *
 * ── `conn` (OPSIONAL) ────────────────────────────────────────────────────────
 * Tanpa `conn`, fungsinya pakai `pool` dan MENJALANKAN efek sampingnya sendiri
 * — perilaku lama, dipakai jalur QRIS (webhook / Cek Status / konfirmasi admin).
 *
 * Dengan `conn`, tiga UPDATE-nya ikut transaksi milik pemanggil, dan efek
 * sampingnya TIDAK dijalankan: dikembalikan sebagai `efekSamping` supaya
 * pemanggil menjalankannya SETELAH commit. Dipakai `perpanjangDariSaldo`, yang
 * harus bisa rollback saldo kalau paketnya gagal.
 *
 * Kenapa harus begitu, bukan sekadar "panggil efek samping di dalam transaksi":
 *   - `engineBus.start` menyalakan WhatsApp, ~14 detik, dan menembak jaringan.
 *     Di dalam transaksi itu menahan lock `users` selama belasan detik.
 *   - Kalau transaksinya ternyata rollback, botnya sudah terlanjur menyala
 *     padahal paket tidak diberikan.
 *   - `notify` juga jalur jaringan; kegagalannya tidak boleh membatalkan uang.
 *
 * URUTAN KUNCI (bebas deadlock): `SELECT ... FOR UPDATE` di users DULU (dilakukan
 * pemanggil), lalu di sini UPDATE bots, lalu UPDATE users. Satu jalur, urut
 * users -> bots, jadi tidak ada siklus. Query `UPDATE bots` pakai idx_user,
 * bukan full scan.
 */
async function terapkanPaket(userId, planId, days, conn = null) {
  const plan = pricingStore.plans().find((p) => p.id === planId);
  if (!plan) {
    throw Object.assign(new Error(`Paket tidak dikenal: ${planId}`), { kode: 'PAKET_TIDAK_DIKENAL' });
  }
  // `days` yang DIKIRIM EKSPLISIT dipakai apa adanya — termasuk kalau 0 atau
  // negatif, dan itu ditolak di bawah. Dulu bentuknya `days || plan.days`, dan
  // karena 0 itu falsy, `days: 0` DIAM-DIAM jadi 30 hari. Pemanggil yang
  // bermaksud "jangan kasih masa aktif" dapat sebulan penuh tanpa peringatan.
  // undefined/null = memang tidak mengirim, baru jatuh ke jatah paket.
  const masa = days === undefined || days === null ? Number(plan.days) || 0 : Number(days) || 0;
  if (masa <= 0) {
    throw Object.assign(
      new Error(`Masa aktif paket ${plan.id} tidak valid (${masa} hari)`),
      { kode: 'PAKET_MASA_NOL' }
    );
  }

  // Satu baris, bukan abstraksi: semua query di bawah lewat `q`. Dengan `conn`
  // mereka jadi bagian transaksi pemanggil; tanpa `conn` sama seperti dulu.
  const q = conn || pool;

  const [rows] = await q.execute(
    'SELECT plan_expired_at FROM users WHERE id = ?',
    [userId]
  );
  const sisa = rows[0]?.plan_expired_at ? new Date(rows[0].plan_expired_at) : null;
  const dasar = sisa && sisa > new Date() ? sisa : new Date();
  const akhir = new Date(dasar.getTime() + masa * 86400000);

  // Dua efek: masa aktif ditambah, DAN kuota pesan bot miliknya disesuaikan
  // dengan paket baru. Tanpa baris terakhir, user bayar tapi kuotanya tetap
  // yang lama sampai worker restart.
  const kuota = plan.daily_limit;
  // `receive_limit` di-set ulang dari paket + hitungannya di-reset ke 0: beli
  // paket = kuota terima pesan penuh lagi. Kalau hitungannya tidak direset,
  // pelanggan lama langsung mentok begitu paket barunya masuk.
  await q.execute(
    'UPDATE bots SET daily_limit = ?, receive_limit = ?, received_count = 0 WHERE user_id = ?',
    [kuota, plan.receive_limit || 0, userId]
  );

  // `plan_slots` tidak diisi dari paket — jatah dibaca dari paket saat dipakai,
  // jadi kalau admin mengubah jatah per harga, semua user langsung ikut.
  // Kolom itu disisakan untuk override manual per user.
  await q.execute(
    'UPDATE users SET plan = ?, plan_expired_at = ? WHERE id = ?',
    [plan.id, akhir, userId]
  );

  // Bot yang MATI karena paket habis. Dibaca di dalam transaksi supaya daftarnya
  // konsisten dengan perubahan di atas.
  //
  // DIBUNGKUS try/catch DENGAN SENGAJA, dan ini bukan kehati-hatian berlebihan:
  // blok ini dulunya ada di bagian efek-samping yang tidak boleh menggagalkan
  // pembayaran, dan paketnya SUDAH diberikan di dua UPDATE di atas. Kalau query
  // ini melempar (DB hiccup) dan dibiarkan naik, pemanggilnya jalur uang —
  // webhook membalas error padahal ordernya sudah diproses, dan user yang sudah
  // bayar melihat "gagal".
  //
  // Reset `stop_reason` DULU, baru start. Tanpa reset, kalau `engineBus.start`
  // gagal (QR timeout / zapo error) dan user restart server, `autoStartBots`
  // akan skip bot ini karena filter `stop_reason <> 'expired'`. Padahal
  // paketnya SUDAH aktif dan botnya harusnya jalan. startBot sendiri juga sudah
  // reset stop_reason (engine/whatsappEngine.js:319), tapi kita tidak boleh
  // andalkan startBot untuk ini: kalau proses startBot crash di tengah,
  // stop_reason kembali ke 'expired' dan boot berikutnya skip.
  const matiKarenaPaket = [];
  try {
    const [rowsMati] = await q.execute(
      "SELECT id FROM bots WHERE user_id = ? AND is_running = 0 AND stop_reason = 'expired'",
      [userId]
    );
    matiKarenaPaket.push(...rowsMati);
    if (matiKarenaPaket.length) {
      await q.execute(
        "UPDATE bots SET stop_reason = NULL WHERE user_id = ? AND stop_reason = 'expired'",
        [userId]
      );
    }
  } catch (e) {
    console.error('[Billing] Gagal siapkan bot yang dimatikan sistem (paket TETAP diberikan):', e.message);
  }

  const hasil = { plan: plan.id, sampai: akhir, kuota };

  // Dengan transaksi milik pemanggil: JANGAN jalankan efek samping, kembalikan.
  if (conn) return { ...hasil, efekSamping: { userId, plan, akhir, kuota, matiKarenaPaket } };

  // Di-await seperti kode lama (dulu query `SELECT id FROM bots` juga awaited di
  // titik ini). Isi efek sampingnya sendiri tetap fire-and-forget: start WA dan
  // notif TIDAK ditunggu, karena webhook yang lambat dibalas = QRISku kirim
  // ulang = paket dobel.
  await jalankanEfekSamping({ userId, plan, akhir, kuota, matiKarenaPaket });
  return hasil;
}

/**
 * Semua yang BUKAN tulis-DB dari penerapan paket: segarkan cache, lupakan
 * peringatan kuota, nyalakan bot yang mati karena paket habis, kirim notif.
 *
 * Dipisah supaya pemanggil bertransaksi bisa menundanya sampai SETELAH commit.
 * SELURUHNYA dibungkus try/catch dengan sengaja: paketnya SUDAH diberikan, dan
 * user yang sudah bayar tidak boleh menerima error karena urusan sampingan.
 */
async function jalankanEfekSamping({ userId, plan, akhir, kuota, matiKarenaPaket = [] }) {
  try {
    // Paket baru = jatah fitur & kuota baru. Cache di gatePaket cuma 60 detik,
    // tapi segarkan() memangkasnya jadi nol — user nggak perlu nunggu semenit
    // buat fitur yang barusan dia bayar.
    require('../engine/gatePaket').segarkan(null);

    // Peringatan kuota disimpan di memori per bot (`engine/kuota.js`). Paket
    // baru = ambang baru, jadi penandanya harus dilupakan — kalau tidak,
    // peringatan 80% pada langganan KEDUA tidak akan pernah terkirim.
    //
    // Dilupakan untuk SEMUA bot milik user ini, bukan cuma yang mati karena
    // paket: bot yang distop user sendiri pun kuotanya direset oleh paket baru,
    // jadi penanda lamanya ikut basi. Daftarnya dibaca di sini (bukan di dalam
    // transaksi) dan dibungkus try/catch — ini efek samping, gagal membacanya
    // tidak boleh menggagalkan paket yang sudah diberikan.
    try {
      const [botKu] = await pool.execute('SELECT id FROM bots WHERE user_id = ?', [userId]);
      const kuotaMod = require('../engine/kuota');
      for (const b of botKu) kuotaMod.lupakanPeringatan(b.id);
    } catch (e) {
      console.error('[Billing] Gagal melupakan peringatan kuota (paket TETAP aktif):', e.message);
    }

    // SENGAJA TIDAK di-await, sejajar dengan notifikasi: start WA butuh ~14
    // detik dan webhook QRIS yang lambat dibalas = QRISku mengirim ulang =
    // paket dobel.
    for (const b of matiKarenaPaket) {
      require('../config/engineBus').start(b.id)
        .then(() => console.log(`[Billing] Bot ${b.id} dinyalakan kembali — paket ${plan.id} aktif`))
        .catch((e) => console.error(`[Billing] Gagal nyalakan bot ${b.id}:`, e.message));
    }
  } catch (e) {
    console.error('[Billing] Efek samping paket gagal (paket TETAP aktif):', e.message);
  }

  // Kabari pemiliknya lewat WA — SATU titik, jadi jalur webhook, "Cek Status",
  // dan konfirmasi admin semuanya dapat kabar.
  //
  // SENGAJA TIDAK di-await: ini dipanggil dari webhook QRIS, dan webhook yang
  // lambat dibalas = QRISku mengirim ulang = paket dobel. Notifikasi itu bonus,
  // pembayaran yang utama.
  const tgl = akhir.toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });
  require('../engine/notify')
    .kirimKeOwner(userId,
      `✅ *Pembayaran diterima!*\n\n` +
      `Paket *${plan.name}* sudah aktif sampai *${tgl}*.\n` +
      `Limit harian bot kamu sekarang ${kuota} pesan.\n\n` +
      `_Cek di halaman Riwayat: /billing_`)
    .catch(() => { /* nggak ada bot online — bukan alasan bikin checkout gagal */ });
}

/**
 * Trial 5 hari — SEKALI per akun. Dijaga `trial_used_at`, bukan status paket,
 * jadi menghapus paket tidak menghidupkan trial lagi. Dipanggil dari register
 * dan dari /api/auth/me (biar akun lama pun kebagian sekali, tanpa skrip migrasi).
 */
async function klaimTrial(userId) {
  const [rows] = await pool.execute(
    'SELECT trial_used_at FROM users WHERE id = ?',
    [userId]
  );
  if (!rows[0] || rows[0].trial_used_at) return null;

  // Tandai DULU (syarat balapan: dua request bersamaan tetap cuma dapat satu).
  const [upd] = await pool.execute(
    'UPDATE users SET trial_used_at = NOW() WHERE id = ? AND trial_used_at IS NULL',
    [userId]
  );
  if (upd.affectedRows !== 1) return null;

  const days = pricingStore.all().trial_days || TRIAL.days;
  const akhir = new Date(Date.now() + days * 86400000);
  // `plan_slots` sengaja TIDAK diisi: jatah trial dibaca dari TRIAL di
  // config/plan.js. Kalau disimpan ke kolom, nilainya jadi sisa yang tidak
  // ikut terhapus saat trial habis.
  await pool.execute(
    'UPDATE users SET plan = ?, plan_expired_at = ? WHERE id = ?',
    [TRIAL.id, akhir, userId]
  );
  return { plan: TRIAL.id, days, sampai: akhir };
}

/** POST /api/billing/trial — klaim trial 5 hari (sekali per akun). */
async function klaimTrialSendiri(req, res) {
  try {
    const hasil = await klaimTrial(req.user.id);
    if (!hasil) return sendError(res, 400, 'Trial sudah pernah dipakai di akun ini');
    return res.json({ ok: true, hari: hasil.days, message: `Trial ${hasil.days} hari aktif` });
  } catch (err) {
    console.error('[Billing] klaimTrialSendiri error:', err.message);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── GET /api/plans (publik) ──────────────────────────────────────────────────

async function daftarPaket(req, res) {
  const s = pricingStore.all();
  return res.json({
    ok: true,
    plans: pricingStore.plans().filter((p) => p.id !== 'user' && p.price > 0),
    trial: { days: s.trial_days || TRIAL.days, slots: TRIAL.slots || 1, owner_max: TRIAL.owner_max || 1, receive_limit: TRIAL.receive_limit || 5000 },
    pay_mode: s.pay_mode,
    qris_static_url: s.qris_static_url || null,
    // Jumlah command yang tersedia — buat kartu paket. Ikut di sini karena
    // landing `/` belum login dan nggak boleh nyentuh `/api/command`.
    // Paket TIDAK membatasi fitur, jadi angkanya sama untuk tiap paket.
    fitur: jumlahCommand(),
  });
}

/** Total command yang beredar. Gagal baca = 0, jangan bikin endpointnya mati. */
function jumlahCommand() {
  try {
    const { ALL_COMMANDS } = require('../plugins/whatsapp/01-info');
    return ALL_COMMANDS ? ALL_COMMANDS.length : 0;
  } catch {
    return 0;
  }
}

// ─── POST /api/billing/checkout ───────────────────────────────────────────────

async function checkout(req, res) {
  try {
    const { plan: planId, method = 'gateway' } = req.body || {};
    const plan = pricingStore.getPlan(planId);
    if (!plan || plan.id !== planId || plan.price <= 0)
      return sendError(res, 400, 'Paket tidak dikenal');

    const s = pricingStore.all();
    if (s.pay_mode === 'manual' && method === 'gateway')
      return sendError(res, 400, 'Pembayaran otomatis sedang dimatikan. Pakai QRIS manual.');
    if (s.pay_mode === 'gateway' && method === 'manual')
      return sendError(res, 400, 'Pembayaran manual sedang dimatikan. Pakai tombol bayar.');

    const orderId = buatOrderId();

    if (method === 'manual') {
      if (!s.qris_static_url)
        return sendError(res, 400, 'QRIS manual belum diatur admin. Hubungi admin.');

      await pool.execute(
        `INSERT INTO orders (order_id, user_id, plan, amount, method, status, qr_image)
         VALUES (?, ?, ?, ?, 'manual', 'pending', ?)`,
        [orderId, req.user.id, plan.id, plan.price, s.qris_static_url]
      );

      return res.status(201).json({
        ok: true,
        order_id: orderId,
        method: 'manual',
        amount: plan.price,
        amount_text: rupiah(plan.price),
        plan: plan.id,
        plan_name: plan.name,
        qris_image: s.qris_static_url,
        instruksi: [
          `Scan QRIS di atas, bayar ${rupiah(plan.price)} (nominal harus PERSIS).`,
          `Simpan bukti bayar, lalu kirim ke admin.`,
          `Sertakan kode order: ${orderId}`,
          'Paket aktif setelah admin mengonfirmasi.',
        ],
      });
    }

    // Gateway Alpay QRIS Dinamis
    const tagihan = await alpay.buatTagihan({
      amount: plan.price,
      customer_name: req.user.username,
      note: 'Paket ' + plan.name,
    });
    const kedaluwarsa = tagihan.expired_at ? new Date(tagihan.expired_at * 1000) : null;

    await pool.execute(
      `INSERT INTO orders
         (order_id, user_id, plan, amount, method, status, gateway_ref, qr_image, qr_payload, expired_at)
       VALUES (?, ?, ?, ?, 'gateway', 'pending', ?, ?, ?, ?)`,
      [orderId, req.user.id, plan.id, plan.price, tagihan.id,
       tagihan.qr_url || null, tagihan.payment_link || null, kedaluwarsa]
    );

    return res.status(201).json({
      ok: true,
      order_id: orderId,
      method: 'gateway',
      amount: plan.price,
      amount_text: rupiah(plan.price),
      plan: plan.id,
      plan_name: plan.name,
      qris_image: tagihan.qr_url || null,
      pay_url: tagihan.payment_link || null,
      expired_at: kedaluwarsa,
    });
  } catch (err) {
    console.error('[Billing] checkout error:', err.message);
    return sendError(res, 502, 'Gagal membuat tagihan. Coba lagi atau pakai QRIS manual.');
  }
}

// ─── GET /api/billing/orders (milik sendiri) ─────────────────────────────────

async function daftarOrder(req, res) {
  const [rows] = await pool.execute(
    `SELECT order_id, plan, amount, method, status, qr_image, expired_at, paid_at, created_at
     FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 20`,
    [req.user.id]
  );
  return res.json({ ok: true, orders: rows });
}

// ─── GET /api/billing/orders/:orderId (detail order milik sendiri) ───────────

async function detailOrder(req, res) {
  try {
    const { orderId } = req.params;
    const [rows] = await pool.execute(
      `SELECT order_id, plan, amount, method, status, qr_image, proof_url AS pay_url, expired_at, paid_at, created_at
       FROM orders WHERE order_id = ? AND user_id = ?`,
      [orderId, req.user.id]
    );
    if (rows.length === 0) return sendError(res, 404, 'Order tidak ditemukan');
    return res.json({ ok: true, order: rows[0] });
  } catch (err) {
    console.error('[Billing] detailOrder error:', err.message);
    return sendError(res, 500, 'Gagal mengambil detail order');
  }
}

// ─── POST /api/billing/orders/:orderId/check ──────────────────────────────────
// Satu permintaan ke QRISku, dijatah 20 detik per order. Dipakai kalau user
// tidak sabar menunggu webhook — BUKAN polling berkala.

async function cekOrder(req, res) {
  try {
    const { orderId } = req.params;
    const [rows] = await pool.execute(
      'SELECT * FROM orders WHERE order_id = ? AND user_id = ?',
      [orderId, req.user.id]
    );
    if (rows.length === 0) return sendError(res, 404, 'Order tidak ditemukan');
    const order = rows[0];

    if (order.status === 'paid')
      return res.json({ ok: true, status: 'paid', message: 'Sudah lunas' });
    if (order.method !== 'gateway' || !order.gateway_ref)
      return res.json({ ok: true, status: order.status, message: 'Menunggu konfirmasi admin' });

    if (!alpay.bolehCek(orderId))
      return res.json({ ok: true, status: order.status, message: 'Baru saja dicek. Tunggu sebentar lagi.' });

    const data = await alpay.status(order.gateway_ref);
    if (String(data.status).toLowerCase() === 'paid' || data.paid) {
      const hasil = await tandaiLunas(order.order_id, data);
      return res.json({ ok: true, status: 'paid', message: 'Pembayaran diterima', ...hasil });
    }
    return res.json({ ok: true, status: order.status, message: `Status: ${data.status}` });
  } catch (err) {
    console.error('[Billing] cekOrder error:', err.message);
    return sendError(res, 502, 'Gagal memeriksa status. Coba lagi nanti.');
  }
}

/**
 * Tandai lunas + terapkan paket — hanya sekali. Penjaganya perpindahan status:
 * UPDATE ... WHERE status IN ('pending','expired'). affectedRows 0 = sudah
 * pernah diproses.
 *
 * DUA hal yang sengaja diperiksa SEBELUM status diubah:
 *
 * 1. Order dibaca dulu, bukan sesudah. Kalau `terapkanPaket` dipanggil dan
 *    ternyata menolak (paket tak dikenal), ordernya sudah terlanjur 'paid' dan
 *    tidak ada cara mengembalikannya — user bayar, paket tidak dapat, dan
 *    ordernya kelihatan selesai.
 *
 * 2. Order `plan='topup'` TIDAK PERNAH lewat `terapkanPaket`. Order top up
 *    tidak menjual masa aktif — dia menambah saldo. Tanpa gerbang ini, id
 *    'topup' tidak ada di daftar paket, dan sebelum `terapkanPaket` diperketat
 *    dia jatuh ke paket Gratis: plan_expired_at di-set ke SEKARANG (paket user
 *    habis) dan daily_limit bot diturunkan ke 10. Sekarang pun tetap dijaga
 *    di sini, karena `terapkanPaket` melempar untuk id tak dikenal dan
 *    pelemparan itu tidak boleh sampai menandai order lunas.
 *
 * Status 'expired' ikut diterima: QRISku menyatakan paid tapi webhook-nya baru
 * sampai setelah QR lewat masa berlaku (5 menit). Pembayarannya nyata, jadi
 * jangan ditolak cuma karena lewat jam.
 */
async function tandaiLunas(orderId, data) {
  // Nama kolom ditulis satu per satu, bukan `SELECT *`: `terapkanTopup`
  // menerima baris ini apa adanya sebagai "order", jadi bentuknya harus tetap.
  const [rows] = await pool.execute(
    'SELECT user_id, plan, amount, order_id, status FROM orders WHERE order_id = ?',
    [orderId]
  );
  if (rows.length === 0) {
    return { status: 'unknown', sudah: false, error: 'order tidak ditemukan' };
  }
  const order = rows[0];

  // Gerbang top up. Cabang ini yang mencegah saldo diproses sebagai paket.
  if (order.plan === 'topup') {
    const wallet = require('./walletController');
    return wallet.terapkanTopup(order, data);
  }

  // Validasi paket DULU, sebelum status diubah.
  if (!pricingStore.plans().some((p) => p.id === order.plan)) {
    console.error(`[Billing] ${orderId} DITOLAK: plan '${order.plan}' tidak dikenal — order ditandai error paket`);
    await pool.execute(
      "UPDATE orders SET note = ? WHERE order_id = ?",
      [`paket gagal diterapkan: paket '${order.plan}' tidak dikenal`.slice(0, 250), orderId]
    );
    return { status: order.status, sudah: false, error: `paket '${order.plan}' tidak dikenal` };
  }

  // Jalankan penandaan lunas + terapkanPaket dalam SATU transaksi DB.
  // Jika terapkanPaket gagal -> ROLLBACK, order tetap status lama (pending),
  // sehingga retry webhook berikutnya bisa memproses ulang.
  // Jika pool tidak mendukung getConnection (mis. mock unit test), pakai fallback pool langsung.
  const conn = typeof pool.getConnection === 'function' ? await pool.getConnection() : null;
  const q = conn || pool;
  let hasilPenerapan = null;
  try {
    if (conn) await conn.beginTransaction();

    const [upd] = await q.execute(
      "UPDATE orders SET status = 'paid', paid_at = NOW(), note = ? WHERE order_id = ? AND status IN ('pending','expired')",
      [data?.payment_reference_id ? String(data.payment_reference_id).slice(0, 250) : null, orderId]
    );
    if (upd.affectedRows !== 1) {
      if (conn) await conn.rollback();
      return { status: 'paid', sudah: true };
    }

    // Terapkan paket dengan koneksi transaksi
    hasilPenerapan = await module.exports.terapkanPaket(order.user_id, order.plan, undefined, conn);

    if (conn) await conn.commit();
    console.log(`[Billing] ${orderId} lunas → user ${order.user_id} paket ${hasilPenerapan.plan}`);
  } catch (err) {
    if (conn) await conn.rollback();
    console.error(`[Billing] ${orderId} terapkanPaket GAGAL (transaksi di-rollback, order tetap pending): ${err.message}`);
    // Catat note kegagalan di orders di luar transaksi yang di-rollback agar terlihat oleh admin
    try {
      await pool.execute(
        "UPDATE orders SET note = ? WHERE order_id = ? AND status IN ('pending','expired')",
        [`paket gagal diterapkan: ${err.message}`.slice(0, 250), orderId]
      );
    } catch (_) {}
    throw err;
  } finally {
    if (conn) conn.release();
  }

  // Efek samping dijalankan SETELAH transaksi sukses commit
  if (hasilPenerapan?.efekSamping) {
    await jalankanEfekSamping(hasilPenerapan.efekSamping);
  }

  return { plan: hasilPenerapan.plan, sampai: hasilPenerapan.sampai, kuota: hasilPenerapan.kuota };
}

// ─── POST /api/payment/webhook (Alpay Gateway) ────────────────────────────────
// Badan mentah wajib utuh: tanda tangan dihitung dari byte asli, bukan JSON
// yang sudah diparse ulang. Raw body dipasang di server.js (express.raw).

async function webhook(req, res) {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    if (!alpay.tandaTanganValid(raw, req.get('x-webhook-signature'))) {
      console.warn('[Billing] webhook: tanda tangan tidak cocok');
      return res.status(401).json({ ok: false, message: 'invalid signature' });
    }

    const p = JSON.parse(raw.toString('utf8'));
    console.log('[Billing] Webhook verified:', p.event, p.data);
    const d = p.data || p;                       // bentuk payload: { event, data } atau datar
    const ref = d.id || d.payment_id || d.trxid || d.transaction_id;
    const status = String(d.status || p.event || '').toLowerCase();

    if (!ref) return res.json({ ok: true, ignored: 'tanpa id tagihan' });
    if (!['paid', 'settlement', 'success', 'payment.paid', 'payment.success'].includes(status) && !d.paid)
      return res.json({ ok: true, ignored: `event ${p.event || status}` });

    const [rows] = await pool.execute(
      'SELECT order_id FROM orders WHERE gateway_ref = ? LIMIT 1',
      [String(ref)]
    );
    if (rows.length === 0) return res.json({ ok: true, ignored: 'order tidak dikenal' });

    await tandaiLunas(rows[0].order_id, d);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[Billing] webhook error:', err.message);
    // 200 supaya gateway tidak mengulang terus; masalahnya sudah tercatat di log.
    return res.json({ ok: true });
  }
}

// ─── Admin: order & konfirmasi manual ────────────────────────────────────────

async function adminOrders(req, res) {
  const status = String(req.query.status || '').trim();
  const [rows] = await pool.execute(
    `SELECT o.*, u.username FROM orders o JOIN users u ON u.id = o.user_id
     ${status ? 'WHERE o.status = ?' : ''}
     ORDER BY o.id DESC LIMIT 100`,
    status ? [status] : []
  );
  return res.json({ ok: true, orders: rows });
}

/** POST /api/admin/billing/orders/:orderId/confirm — admin menyatakan manual lunas. */
async function adminKonfirmasi(req, res) {
  try {
    const { orderId } = req.params;
    const [rows] = await pool.execute(
      'SELECT order_id, status FROM orders WHERE order_id = ?',
      [orderId]
    );
    if (rows.length === 0) return sendError(res, 404, 'Order tidak ditemukan');
    if (rows[0].status === 'paid') return res.json({ ok: true, message: 'Sudah lunas' });

    const hasil = await tandaiLunas(orderId, { payment_reference_id: `manual:${req.user.username}` });
    return res.json({ ok: true, message: 'Pembayaran dikonfirmasi', ...hasil });
  } catch (err) {
    console.error('[Billing] adminKonfirmasi error:', err.message);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

/** POST /api/admin/billing/orders/:orderId/reject */
async function adminTolak(req, res) {
  try {
    const [upd] = await pool.execute(
      "UPDATE orders SET status = 'rejected', note = ? WHERE order_id = ? AND status = 'pending'",
      [String(req.body?.note || '').slice(0, 250) || null, req.params.orderId]
    );
    if (upd.affectedRows !== 1) return sendError(res, 400, 'Order sudah tidak pending');
    return res.json({ ok: true, message: 'Order ditolak' });
  } catch (err) {
    console.error('[Billing] adminTolak error:', err.message);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── Admin: harga & setelan bayar ────────────────────────────────────────────

/** GET /api/admin/billing/settings */
async function adminSettings(req, res) {
  const s = pricingStore.all();
  return res.json({
    ok: true,
    plans: s.plans,
    trial_days: s.trial_days || 5,
    trial_slots: s.trial_slots || 1,
    trial_owner_max: s.trial_owner_max || 1,
    trial_receive_limit: s.trial_receive_limit || 5000,
    price_per_owner: s.price_per_owner || 2500,
    price_per_1k_quota: s.price_per_1k_quota || 5000,
    qris_static_url: s.qris_static_url,
    pay_mode: s.pay_mode,
    gateway_enabled: s.gateway_enabled,
    pengumuman: s.pengumuman || null,
    gateway_configured: !!process.env.ALPAY_API_KEY,
  });
}

/**
 * GET /api/pengumuman — banner pengumuman buat semua user yang login.
 *
 * Sengaja TIDAK pakai tabel baru: `settings` sudah jadi key/value JSON dan
 * `pricingStore` sudah nge-cache + punya `set()`. Satu baris `settings` cukup.
 * Hanya yang `aktif` yang dikirim — user nggak perlu tahu ada draft.
 */
async function pengumuman(req, res) {
  const p = pricingStore.all().pengumuman;
  if (!p || !p.aktif || !String(p.isi || '').trim()) return res.json({ ok: true, pengumuman: null });
  return res.json({
    ok: true,
    pengumuman: {
      judul: String(p.judul || 'Pengumuman'),
      isi: String(p.isi),
      updated_at: p.updated_at || null,
    },
  });
}

/** PUT /api/admin/billing/plans — harga & benefit per slot. */
async function adminSetPlans(req, res) {
  try {
    const masuk = Array.isArray(req.body?.plans) ? req.body.plans : null;
    if (!masuk || masuk.length === 0) return sendError(res, 400, 'Daftar paket kosong');

    const bersih = masuk.map((p) => ({
      id: String(p.id || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, ''),
      name: String(p.name || '').trim().slice(0, 64),
      price: Math.max(0, parseInt(p.price, 10) || 0),
      // Slot minimum 0: paket Gratis memang 0 slot, jangan dipaksa jadi 1.
      slots: Math.max(0, parseInt(p.slots, 10) || 0),
      days: Math.max(0, parseInt(p.days, 10) || 0),
      daily_limit: Math.max(1, parseInt(p.daily_limit, 10) || 20),
      owner_max: Math.max(0, parseInt(p.owner_max, 10) || 0),
      receive_limit: Math.max(0, parseInt(p.receive_limit, 10) || 0),
    }));
    if (bersih.some((p) => !p.id || !p.name))
      return sendError(res, 400, 'Setiap paket butuh id dan nama');

    const lama = pricingStore.plans();
    // Paket 'user' (gratis) tidak boleh dihapus — dia titik jatuh semua akun.
    if (!bersih.some((p) => p.id === 'user')) bersih.unshift(lama.find((p) => p.id === 'user'));

    await pricingStore.set('plans', bersih);
    return res.json({ ok: true, plans: bersih });
  } catch (err) {
    console.error('[Billing] adminSetPlans error:', err.message);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

/** PUT /api/admin/billing/settings — QRIS manual, mode bayar, trial, & addon. */
async function adminSetSettings(req, res) {
  try {
    const {
      qris_static_url, pay_mode, gateway_enabled,
      trial_days, trial_slots, trial_owner_max, trial_receive_limit,
      price_per_owner, price_per_1k_quota,
      pengumuman
    } = req.body || {};
    if (qris_static_url !== undefined) {
      const url = String(qris_static_url).trim();
      if (url && !/^https?:\/\//i.test(url)) return sendError(res, 400, 'URL QRIS harus http/https');
      await pricingStore.set('qris_static_url', url);
    }
    if (pay_mode !== undefined) {
      if (!['manual', 'gateway', 'both'].includes(pay_mode))
        return sendError(res, 400, 'Mode bayar tidak dikenal');
      await pricingStore.set('pay_mode', pay_mode);
    }
    if (gateway_enabled !== undefined) await pricingStore.set('gateway_enabled', !!gateway_enabled);
    if (trial_days !== undefined) {
      const d = parseInt(trial_days, 10);
      if (!(d >= 1 && d <= 30)) return sendError(res, 400, 'Trial 1-30 hari');
      await pricingStore.set('trial_days', d);
    }
    if (trial_slots !== undefined) {
      await pricingStore.set('trial_slots', Math.max(1, parseInt(trial_slots, 10) || 1));
    }
    if (trial_owner_max !== undefined) {
      await pricingStore.set('trial_owner_max', Math.max(1, parseInt(trial_owner_max, 10) || 1));
    }
    if (trial_receive_limit !== undefined) {
      await pricingStore.set('trial_receive_limit', Math.max(100, parseInt(trial_receive_limit, 10) || 5000));
    }
    if (price_per_owner !== undefined) {
      await pricingStore.set('price_per_owner', Math.max(0, parseInt(price_per_owner, 10) || 0));
    }
    if (price_per_1k_quota !== undefined) {
      await pricingStore.set('price_per_1k_quota', Math.max(0, parseInt(price_per_1k_quota, 10) || 0));
    }
    if (pengumuman !== undefined) {
      // Tiga field saja. `isi` boleh kosong = pengumuman dimatikan, jadi admin
      // nggak perlu dua langkah (hapus isi + uncheck aktif) buat menutupnya.
      const p = pengumuman || {};
      const isi = String(p.isi || '').trim();
      if (isi.length > 2000) return sendError(res, 400, 'Isi pengumuman maksimal 2000 karakter');
      await pricingStore.set('pengumuman', {
        judul: String(p.judul || '').trim().slice(0, 120),
        isi,
        aktif: !!p.aktif && !!isi,
        updated_at: new Date().toISOString(),
      });
    }
    return adminSettings(req, res);
  } catch (err) {
    console.error('[Billing] adminSetSettings error:', err.message);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

/**
 * GET /api/kuota — sisa kuota pesan per bot milik user yang login.
 *
 * Kenapa ada: begitu kuota habis, bot berhenti membalas dan (kalau paketnya
 * lewat masa aktif) dimatikan cron. Tanpa halaman ini user nggak punya cara
 * tahu sisa kuotanya sebelum botnya diam. Angka-angkanya dari engine/kuota.js
 * supaya aturan batasnya cuma ada di SATU tempat, bukan disalin ke controller.
 */
async function kuota(req, res) {
  try {
    const [bots] = await pool.execute(
      'SELECT id, bot_name, status, is_running FROM bots WHERE user_id = ? ORDER BY id',
      [req.user.id]
    );
    const { sisaKuota } = require('../engine/kuota');
    const hasil = [];
    for (const b of bots) {
      const s = await sisaKuota(b.id);
      if (s) hasil.push({ id: b.id, nama: b.bot_name, status: b.status, jalan: !!b.is_running, ...s });
    }
    return res.json({ ok: true, bots: hasil });
  } catch (err) {
    console.error('[Billing] kuota error:', err.message);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

/**
 * POST /api/admin/bots/:id/kuota — tambah kuota pesan manual (top-up).
 *
 * Kenapa tidak menulis `bots.receive_limit`: kolom itu sengaja cuma boleh
 * MENURUNKAN jatah paket (engine/gatePaket.js `batasKuota()`), jadi menaikkannya
 * tidak berpengaruh — dan menulis 0 di situ artinya TANPA BATAS, bukan habis.
 * Top-up disimpan di tabel `kuota_tambahan` dan ditambahkan di atas paket.
 *
 * `jumlah` = TOTAL bonus yang berlaku, bukan delta, supaya angka di UI selalu
 * sama dengan yang ditegakkan dan admin bisa mengoreksi salah input dengan
 * menulis angka baru.
 */
async function adminTopupKuota(req, res) {
  try {
    const botId = parseInt(req.params.id, 10);
    const jumlah = Math.max(0, parseInt(req.body.jumlah, 10) || 0);

    const [bots] = await pool.execute('SELECT id, bot_name FROM bots WHERE id = ? LIMIT 1', [botId]);
    if (bots.length === 0) return sendError(res, 404, 'Bot tidak ditemukan');

    // UPSERT: baris pertama kali dibuat, sesudahnya angkanya diganti.
    await pool.execute(
      `INSERT INTO kuota_tambahan (bot_id, jumlah, catatan) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE jumlah = VALUES(jumlah), catatan = VALUES(catatan)`,
      [botId, jumlah, (req.body.catatan || '').slice(0, 255) || null]
    );

    // Kalau bot ini sebelumnya MATI karena kuota habis, hidupkan lagi dan
    // bersihkan penanda berhentinya — persis seperti yang dilakukan setelah
    // pembayaran berhasil. Tanpa ini admin menaikkan kuota tapi botnya tetap
    // diam, dan itu terbaca sebagai "fitur top-up nggak jalan".
    //
    // SENGAJA tidak menyentuh `received_count`: memakai `received_count = 0`
    // akan MENGHAPUS pemakaian asli user. Menaikkan batas sudah cukup membuat
    // sisa kuota bertambah.
    if (jumlah > 0) {
      try {
        await pool.execute(
          "UPDATE bots SET stop_reason = NULL WHERE id = ? AND stop_reason = 'expired'",
          [botId]
        );
      } catch { /* kolom/stop_reason tidak ada di DB lama — bukan alasan gagal */ }
    }

    const { sisaKuota } = require('../engine/kuota');
    const sesudah = await sisaKuota(botId);
    return res.json({
      ok: true,
      message: jumlah > 0
        ? `Kuota tambahan ${bots[0].bot_name} di-set ke ${jumlah} pesan`
        : `Kuota tambahan ${bots[0].bot_name} dihapus`,
      kuota: sesudah,
    });
  } catch (err) {
    console.error('[Billing] adminTopupKuota error:', err.message);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

/**
 * POST /api/admin/bots/:id/reset-kuota — nolkan pemakaian kuota pesan.
 *
 * Melepas kuota yang sudah terpakai tanpa mengubah jatah paket/bonus. Dipakai
 * admin untuk kasus: bot error dan memakan kuota user.
 *
 * `received_count` memang di-reset karena DI SINILAH pemakaian disimpan — beda
 * dengan top-up, yang justru tidak boleh menyentuhnya.
 */
async function adminResetKuota(req, res) {
  try {
    const botId = parseInt(req.params.id, 10);
    const [bots] = await pool.execute('SELECT id, received_count FROM bots WHERE id = ? LIMIT 1', [botId]);
    if (bots.length === 0) return sendError(res, 404, 'Bot tidak ditemukan');

    const sebelum = Number(bots[0].received_count) || 0;
    await pool.execute('UPDATE bots SET received_count = 0 WHERE id = ?', [botId]);

    // Peringatan kuota disimpan di MEMORI per bot. Tanpa melupakannya, user yang
    // barusan di-reset tidak akan menerima peringatan 80% lagi pada siklus ini
    // (penandanya masih dianggap sudah terkirim).
    try {
      require('../engine/kuota').lupakanPeringatan(botId);
    } catch { /* bukan alasan membatalkan reset */ }

    const { sisaKuota } = require('../engine/kuota');
    const sesudah = await sisaKuota(botId);
    return res.json({
      ok: true,
      message: `Pemakaian kuota direset (${sebelum} pesan dilepas)`,
      dilepas: sebelum,
      kuota: sesudah,
    });
  } catch (err) {
    console.error('[Billing] adminResetKuota error:', err.message);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

/**
 * POST /api/billing/addon — beli ekstra owner (+1) atau kuota (+1.000) potong saldo.
 */
async function beliAddon(req, res) {
  try {
    const { type } = req.body || {};
    if (!['owner', 'quota'].includes(type)) {
      return sendError(res, 400, 'Tipe addon tidak valid (harus owner atau quota)');
    }
    const s = pricingStore.all();
    const harga = type === 'owner' ? (Number(s.price_per_owner) || 2500) : (Number(s.price_per_1k_quota) || 5000);

    const [uRows] = await pool.execute('SELECT id, saldo, extra_owners, extra_quota FROM users WHERE id = ?', [req.user.id]);
    const u = uRows[0];
    if (!u) return sendError(res, 404, 'User tidak ditemukan');
    if (Number(u.saldo || 0) < harga) {
      return sendError(res, 400, `Saldo tidak cukup (Rp ${Number(u.saldo || 0).toLocaleString('id-ID')}). Harga Rp ${harga.toLocaleString('id-ID')}. Silakan top up di menu Saldo.`);
    }

    const deskripsi = type === 'owner' ? 'Beli Add-on +1 Owner Bot' : 'Beli Add-on +1.000 Kuota Respon';
    const tambahOwner = type === 'owner' ? 1 : 0;
    const tambahQuota = type === 'quota' ? 1000 : 0;

    await pool.execute(
      'UPDATE users SET saldo = saldo - ?, extra_owners = extra_owners + ?, extra_quota = extra_quota + ? WHERE id = ?',
      [harga, tambahOwner, tambahQuota, req.user.id]
    );

    try {
      const ref = 'addon-' + type + '-' + req.user.id + '-' + Date.now();
      await pool.execute(
        'INSERT INTO wallet_ledger (user_id, tipe, jumlah, saldo_akhir, ref, catatan) VALUES (?, ?, ?, ?, ?, ?)',
        [req.user.id, 'debit', -harga, Number(u.saldo) - harga, ref, deskripsi]
      );
    } catch { /* ledger opsional */ }

    const [updated] = await pool.execute('SELECT saldo, extra_owners, extra_quota FROM users WHERE id = ?', [req.user.id]);
    return res.json({
      ok: true,
      message: `Berhasil membeli ${deskripsi}!`,
      saldo: Number(updated[0].saldo || 0),
      extra_owners: Number(updated[0].extra_owners || 0),
      extra_quota: Number(updated[0].extra_quota || 0),
    });
  } catch (err) {
    console.error('[Billing] beliAddon error:', err.message);
    return sendError(res, 500, 'Terjadi kesalahan saat memproses pembelian addon');
  }
}

module.exports = {
  daftarPaket, checkout, beliAddon, daftarOrder, detailOrder, cekOrder, webhook, kuota, pengumuman,
  adminOrders, adminKonfirmasi, adminTolak, adminSettings, adminSetPlans, adminSetSettings,
  adminTopupKuota, adminResetKuota,
  klaimTrial, klaimTrialSendiri, terapkanPaket, tandaiLunas,
  jalankanEfekSamping,
};
