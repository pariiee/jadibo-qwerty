'use strict';

/**
 * controllers/billingController.js — langganan jadibot.
 *
 * DUA opsi bayar, dipilih user:
 *   1. manual  — tampil QRIS statis, user scan sendiri, admin yang konfirmasi.
 *   2. gateway — QRISku bikin tagihan; status masuk sendiri lewat webhook.
 *
 * Status TIDAK di-polling. Sumber kebenaran = webhook (gateway) atau konfirmasi
 * admin (manual). Tersedia satu tombol "Cek status" yang dijatah 20 detik per
 * transaksi (config/qrisku.js) supaya akun QRISku tidak kena ban.
 *
 * Idempotensi: penerapan paket hanya jalan saat status berpindah dari 'pending'.
 * UPDATE ... WHERE status = 'pending' + affectedRows === 1 — webhook ganda,
 * klik dobel, atau admin yang tidak sabar tidak akan menambah masa 2x.
 */
const crypto = require('crypto');
const { pool } = require('../config/database');
const pricingStore = require('../config/pricingStore');
const { TRIAL } = require('../config/plan');
const qrisku = require('../config/qrisku');

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
 */
async function terapkanPaket(userId, planId, days) {
  const plan = pricingStore.getPlan(planId);
  const [rows] = await pool.execute(
    'SELECT plan_expired_at FROM users WHERE id = ?',
    [userId]
  );
  const sisa = rows[0]?.plan_expired_at ? new Date(rows[0].plan_expired_at) : null;
  const dasar = sisa && sisa > new Date() ? sisa : new Date();
  const akhir = new Date(dasar.getTime() + (days || plan.days) * 86400000);

  // Dua efek: masa aktif ditambah, DAN kuota pesan bot miliknya disesuaikan
  // dengan paket baru. Tanpa baris terakhir, user bayar tapi kuotanya tetap
  // yang lama sampai worker restart.
  const kuota = plan.daily_limit;
  // `receive_limit` di-set ulang dari paket + hitungannya di-reset ke 0: beli
  // paket = kuota terima pesan penuh lagi. Kalau hitungannya tidak direset,
  // pelanggan lama langsung mentok begitu paket barunya masuk.
  await pool.execute(
    'UPDATE bots SET daily_limit = ?, receive_limit = ?, received_count = 0 WHERE user_id = ?',
    [kuota, plan.receive_limit || 0, userId]
  );

  // `plan_slots` tidak diisi dari paket — jatah dibaca dari paket saat dipakai,
  // jadi kalau admin mengubah jatah per harga, semua user langsung ikut.
  // Kolom itu disisakan untuk override manual per user.
  await pool.execute(
    'UPDATE users SET plan = ?, plan_expired_at = ? WHERE id = ?',
    [plan.id, akhir, userId]
  );

  // Paket baru = jatah fitur & kuota baru. Cache di gatePaket cuma 60 detik,
  // tapi segarkan() memangkasnya jadi nol — user nggak perlu nunggu semenit
  // buat fitur yang barusan dia bayar.
  require('../engine/gatePaket').segarkan(null);

  // Peringatan kuota disimpan di memori per bot (`engine/kuota.js`). Paket baru =
  // ambang baru, jadi penandanya harus dilupakan — kalau tidak, peringatan 80%
  // pada langganan KEDUA tidak akan pernah terkirim. Dilupakan PER BOT, bukan
  // semua bot: melupakan punya bot lain bikin mereka dapat peringatan dobel.
  //
  // SELURUH blok di bawah ini dibungkus try/catch dengan sengaja: paketnya SUDAH
  // diberikan di atas. Kalau query efek-samping ini gagal (DB hiccup), jangan
  // sampai `terapkanPaket` melempar — pemanggilnya jalur pembayaran, dan user
  // yang sudah bayar tidak boleh menerima error karena urusan sampingan.
  try {
    const [botKu] = await pool.execute('SELECT id FROM bots WHERE user_id = ?', [userId]);
    const kuotaMod = require('../engine/kuota');
    for (const b of botKu) kuotaMod.lupakanPeringatan(b.id);

    // Nyalakan kembali bot yang MATI karena paket habis. Tanpa ini user bayar
    // Rp85.000 lalu botnya tetap diam sampai dia sadar sendiri dan klik Start —
    // dan notifikasi "pembayaran diterima" di bawah pun tidak terkirim, karena
    // `notify.js` mengirim LEWAT bot user sendiri, yang sedang mati.
    //
    // SENGAJA TIDAK di-await, sejajar dengan notifikasi: start WA butuh ~14 detik
    // dan webhook QRIS yang lambat dibalas = QRISku mengirim ulang = paket dobel.
    const [matiKarenaPaket] = await pool.execute(
      "SELECT id FROM bots WHERE user_id = ? AND is_running = 0 AND stop_reason = 'expired'",
      [userId]
    );
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
      `Limit harian bot kamu sekarang ${plan.daily_limit} pesan.\n\n` +
      `_Cek di halaman Riwayat: /billing_`)
    .catch(() => { /* nggak ada bot online — bukan alasan bikin checkout gagal */ });

  return { plan: plan.id, sampai: akhir, kuota };
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
    trial: { days: s.trial_days || TRIAL.days, slots: TRIAL.slots },
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
    const { ALL_COMMANDS } = require('../plugins/01-info');
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

    // Gateway QRISku
    const tagihan = await qrisku.buatTagihan({ amount: plan.price, method: 'shoppee' });
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

    if (!qrisku.bolehCek(orderId))
      return res.json({ ok: true, status: order.status, message: 'Baru saja dicek. Tunggu sebentar lagi.' });

    const data = await qrisku.status(order.gateway_ref);
    if (String(data.status).toLowerCase() === 'paid') {
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
 * UPDATE ... WHERE status = 'pending'. affectedRows 0 = sudah pernah diproses.
 */
async function tandaiLunas(orderId, data) {
  const [upd] = await pool.execute(
    "UPDATE orders SET status = 'paid', paid_at = NOW(), note = ? WHERE order_id = ? AND status = 'pending'",
    [data?.payment_reference_id ? String(data.payment_reference_id).slice(0, 250) : null, orderId]
  );
  if (upd.affectedRows !== 1) return { status: 'paid', sudah: true };

  const [rows] = await pool.execute(
    'SELECT user_id, plan FROM orders WHERE order_id = ?',
    [orderId]
  );
  const hasil = await terapkanPaket(rows[0].user_id, rows[0].plan);
  console.log(`[Billing] ${orderId} lunas → user ${rows[0].user_id} paket ${hasil.plan}`);
  return hasil;
}

// ─── POST /api/payment/webhook (QRISku) ───────────────────────────────────────
// Badan mentah wajib utuh: tanda tangan dihitung dari byte asli, bukan JSON
// yang sudah diparse ulang. Raw body dipasang di server.js (express.raw).

async function webhook(req, res) {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    if (!qrisku.tandaTanganValid(raw, req.get('x-webhook-signature'))) {
      console.warn('[Billing] webhook: tanda tangan tidak cocok');
      return res.status(401).json({ ok: false, message: 'invalid signature' });
    }

    const p = JSON.parse(raw.toString('utf8'));
    const d = p.data || p;                       // bentuk payload: { event, data } atau datar
    const ref = d.id || d.payment_id || d.trxid || d.transaction_id;
    const status = String(d.status || p.event || '').toLowerCase();

    if (!ref) return res.json({ ok: true, ignored: 'tanpa id tagihan' });
    if (!['paid', 'settlement', 'success', 'payment.paid', 'payment.success'].includes(status))
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
    // 200 supaya QRISku tidak mengulang terus; masalahnya sudah tercatat di log.
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
    trial_days: s.trial_days,
    qris_static_url: s.qris_static_url,
    pay_mode: s.pay_mode,
    gateway_enabled: s.gateway_enabled,
    pengumuman: s.pengumuman || null,
    gateway_configured: !!process.env.QRISKU_API_KEY && !!process.env.QRISKU_WEBHOOK_SECRET,
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

/** PUT /api/admin/billing/settings — QRIS manual & mode bayar. */
async function adminSetSettings(req, res) {
  try {
    const { qris_static_url, pay_mode, gateway_enabled, trial_days, pengumuman } = req.body || {};
    if (qris_static_url !== undefined) {
      const url = String(qris_static_url).trim();
      // Cuma http(s) — biar tidak ada yang menempelkan javascript: di <img src>.
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

module.exports = {
  daftarPaket, checkout, daftarOrder, cekOrder, webhook, kuota, pengumuman,
  adminOrders, adminKonfirmasi, adminTolak, adminSettings, adminSetPlans, adminSetSettings,
  adminTopupKuota, adminResetKuota,
  klaimTrial, klaimTrialSendiri, terapkanPaket, tandaiLunas,
};
