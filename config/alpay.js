'use strict';

/**
 * config/alpay.js — Klien Payment Gateway Alpay (https://pay.ghifari.biz.id).
 *
 * Mendukung:
 * - Buat tagihan QRIS dinamis (POST /payments)
 * - Cek status pembayaran (GET /payments/:trxid/status)
 * - Batalkan transaksi (POST /payments/:trxid/cancel)
 * - Verifikasi tanda tangan webhook (HMAC-SHA256 x-webhook-signature)
 */

const crypto = require('crypto');

const BASE = process.env.ALPAY_BASE_URL || 'https://pay.ghifari.biz.id';
const KEY  = process.env.ALPAY_API_KEY || '';

// Cegah spam: jeda minimal antar pengecekan manual per transaksi
const JEDA_CEK_MS = 15_000;
const _cekTrakhir = new Map();

async function call(method, path, body, useKey = true) {
  if (useKey && !KEY) {
    throw Object.assign(new Error('Layanan pembayaran otomatis belum aktif'), { status: 503 });
  }

  const headers = {
    Accept: 'application/json',
  };
  if (useKey && KEY) {
    headers['X-API-Key'] = KEY;
  }
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const msg = json.error || json.message || `Gateway HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status === 401 ? 502 : res.status;
    throw err;
  }
  return json.data ?? json;
}

/**
 * Bikin tagihan QRIS dinamis di Alpay.
 * Balikan: { id, payment_link, payment_url, qr_url, qr_image, amount, expired_at (unix), status }
 */
async function buatTagihan({ amount, customer_name = 'User', note = 'Pembayaran JadiBot' }) {
  const d = await call('POST', '/payments', {
    amount: Math.max(100, Math.round(amount)),
    fee: 0,
    customer_name: String(customer_name || 'Pelanggan').slice(0, 50),
    note: String(note || 'Pembayaran JadiBot').slice(0, 100),
    valid_minutes: 5,
  });

  const expUnix = d.expires_at
    ? Math.floor(new Date(d.expires_at).getTime() / 1000)
    : Math.floor(Date.now() / 1000) + 300;

  return {
    id: d.id,
    payment_link: d.payment_url,
    payment_url: d.payment_url,
    qr_url: d.qr_image,
    qr_image: d.qr_image,
    amount: d.amount,
    expired_at: expUnix,
    status: 'pending',
  };
}

/** Cek status real-time pembayaran dari ID transaksi */
async function status(id) {
  const d = await call('GET', `/payments/${encodeURIComponent(id)}/status`, null, false);
  const isPaid = Boolean(d.paid || d.status === 'paid');
  return {
    id,
    status: isPaid ? 'paid' : (d.status || 'pending'),
    paid: isPaid,
    raw: d,
  };
}

/** Batalkan transaksi (pending) */
function cancel(id) {
  return call('POST', `/payments/${encodeURIComponent(id)}/cancel`);
}

/** Cegah flooding cek manual */
function bolehCek(id) {
  const last = _cekTrakhir.get(id) || 0;
  if (Date.now() - last < JEDA_CEK_MS) return false;
  _cekTrakhir.set(id, Date.now());
  return true;
}

/**
 * Verifikasi tanda tangan webhook (HMAC-SHA256 menggunakan API Key).
 * Header: x-webhook-signature
 */
function tandaTanganValid(rawBody, header) {
  if (!KEY) return false;
  const terima = String(header || '').replace(/^sha256=/i, '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(terima)) return false;

  const harap = crypto.createHmac('sha256', KEY).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(terima, 'hex'), Buffer.from(harap, 'hex'));
  } catch {
    return false;
  }
}

module.exports = { buatTagihan, status, cancel, bolehCek, tandaTanganValid, JEDA_CEK_MS };
