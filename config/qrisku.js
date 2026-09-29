'use strict';

/**
 * config/qrisku.js — klien tipis QRISku (https://qriskuu.web.id).
 *
 * Cuma 4 hal yang dipakai: bikin tagihan, cek status, verifikasi tanda tangan
 * webhook, dan URL bayar. Sisanya jangan ditambah sampai ada yang butuh.
 *
 * PENTING soal spam: `status()` TIDAK dipanggil berkala. Sumber kebenaran status
 * adalah webhook. `status()` hanya dipakai saat user menekan "Cek status" dan
 * dibatasi jeda per transaksi (lihat JEDA_CEK_MS).
 *
 * Ambil nilai `success`/`data` dari respons lewat helper `call()` — bentuk
 * bungkus respons jangan diasumsikan di banyak tempat.
 */

const crypto = require('crypto');

const BASE   = process.env.QRISKU_BASE_URL || 'https://qriskuu.web.id';
const KEY    = process.env.QRISKU_API_KEY || '';
const SECRET = process.env.QRISKU_WEBHOOK_SECRET || '';

// Jangan spam API: satu transaksi cuma boleh dicek manual tiap 20 detik.
const JEDA_CEK_MS = 20_000;
const _cekTrakhir = new Map();

async function call(method, path, body) {
  if (!KEY) throw Object.assign(new Error('QRISKU_API_KEY belum diisi'), { status: 503 });

  const res = await fetch(BASE + path, {
    method,
    headers: {
      'X-API-Key': KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const err = new Error(json.message || `QRISku HTTP ${res.status}`);
    err.status = res.status === 401 ? 502 : res.status; // jangan bocorin "key salah" ke user
    throw err;
  }
  return json.data ?? json;
}

/**
 * Bikin tagihan QRIS. `method` default 'shoppee' (ShopeePay) sesuai keputusan user.
 * Balikan QRISku: { id, payment_link, qr_url, amount, expired_at (unix), status }
 */
function buatTagihan({ amount, method = 'shoppee', customer_name }) {
  return call('POST', '/payments', {
    amount: Math.max(1, Math.round(amount)),
    method,
    customer_name,
  });
}

/** Cek status SATU tagihan (dipakai tombol manual, bukan polling berkala). */
function status(id) {
  return call('GET', `/payments/${encodeURIComponent(id)}/status`);
}

/** true kalau user boleh mengecek lagi (biar akun QRISku tidak kena ban). */
function bolehCek(id) {
  const last = _cekTrakhir.get(id) || 0;
  if (Date.now() - last < JEDA_CEK_MS) return false;
  _cekTrakhir.set(id, Date.now());
  return true;
}

/**
 * Verifikasi tanda tangan webhook.
 *
 * Header: X-Webhook-Signature: sha256=<hex hmac-sha256(rawBody, webhook_secret)>
 * WAJIB pakai raw body apa adanya — JSON.parse dulu = tanda tangan tidak akan
 * pernah cocok. Panjang sama dicek dulu karena timingSafeEqual melempar kalau beda.
 */
function tandaTanganValid(rawBody, header) {
  if (!SECRET) return false;
  const terima = String(header || '').replace(/^sha256=/i, '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(terima)) return false;

  const harap = crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(terima, 'hex'), Buffer.from(harap, 'hex'));
}

module.exports = { buatTagihan, status, bolehCek, tandaTanganValid, JEDA_CEK_MS };
