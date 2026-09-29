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
  });
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
    gateway_configured: !!process.env.QRISKU_API_KEY && !!process.env.QRISKU_WEBHOOK_SECRET,
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
      max_fitur: Math.max(0, parseInt(p.max_fitur, 10) || 0),
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
    const { qris_static_url, pay_mode, gateway_enabled, trial_days } = req.body || {};
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
    return adminSettings(req, res);
  } catch (err) {
    console.error('[Billing] adminSetSettings error:', err.message);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

module.exports = {
  daftarPaket, checkout, daftarOrder, cekOrder, webhook,
  adminOrders, adminKonfirmasi, adminTolak, adminSettings, adminSetPlans, adminSetSettings,
  klaimTrial, klaimTrialSendiri, terapkanPaket, tandaiLunas,
};
