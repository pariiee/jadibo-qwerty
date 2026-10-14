'use strict';

/**
 * config/cekOrigin.js — lapis kedua terhadap CSRF.
 *
 * ── Kenapa lapis kedua, bukan pengganti ──────────────────────────────────────
 * Pertahanan UTAMA-nya adalah cookie `SameSite=Lax` (controllers/authController.js).
 * `Lax` TIDAK mengirim cookie pada POST lintas-situs — termasuk navigasi
 * top-level dari form. Jadi browser modern sudah memblokir serangan CSRF biasa
 * dengan sendirinya, dan itu memang alasan `Lax` dipakai.
 *
 * Tapi `Lax` sendirian tidak cukup:
 *   - `Lax` itu default browser, bukan jaminan. Browser lama (dan sebagian
 *     WebView) memperlakukan cookie tanpa atribut sebagai `None`.
 *   - Kalau nanti ada yang menambahkan `SameSite=None` di satu tempat (mis. demi
 *     embed), proteksinya hilang tanpa ada yang sadar.
 *   - Endpoint uang: satu POST yang lolos = saldo atau paket berubah.
 *
 * Jadi Origin/Referer diperiksa TAMPA tambahan. Bukan karena `Lax` keliru,
 * tapi karena satu lapis di jalur uang itu tipis.
 *
 * ── Yang TIDAK diperiksa ─────────────────────────────────────────────────────
 *   - Webhook `/api/payment/webhook`: BUKAN request browser. Tidak ada Origin,
 *     tidak ada cookie, dan tanda tangannya sudah diverifikasi HMAC dari raw
 *     body. Kalau ini ikut dicek, pembayaran sah akan ditolak.
 *   - Request tanpa cookie `token`: tidak ada yang bisa dipalsukan. API yang
 *     pakai `Authorization: Bearer` (bukan cookie) juga lewat.
 *   - Method aman (GET/HEAD/OPTIONS): tidak mengubah apa pun.
 *
 * ── ALLOWED_ORIGIN kosong ────────────────────────────────────────────────────
 * Di dev, `ALLOWED_ORIGIN` sering tidak diisi (cuma ada di .env.example).
 * Kalau nilainya kosong, SATU-SATUNYA yang diterima adalah Origin yang sama
 * dengan Host request itu sendiri — dan `csrfDiperiksa()` melaporkan bahwa
 * daftar izinnya kosong, supaya kelihatan di log saat boot, bukan cuma jadi
 * perilaku diam-diam yang beda antara dev dan produksi.
 *
 * Nama variabelnya `ALLOWED_ORIGIN` (juga dipakai CORS di server.js).
 */

const IZIN = String(process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

/** Origin dari header, atau null. Dinormalkan (buang garis miring di ekor). */
function originDari(headerOrigin) {
  const o = String(headerOrigin || '').trim();
  if (!o) return null;
  try {
    const u = new URL(o);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null; // Origin rusak -> diperlakukan sebagai tidak ada
  }
}

/** Origin dari Referer (kalau Origin tidak dikirim). */
function originDariReferer(referer) {
  const r = String(referer || '').trim();
  if (!r) return null;
  try {
    const u = new URL(r);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * Origin ini boleh? Origin yang sama dengan Host request SELALU boleh — itu
 * permintaan dari halaman aplikasi sendiri, dan tidak butuh dikonfigurasi.
 */
function originDiizinkan(origin, host) {
  if (!origin) return false;
  // Origin sendiri: bandingkan host + protocol. `trust proxy` sudah di-set
  // 'loopback' di server.js, jadi di balik Cloudflare Tunnel protokolnya benar.
  if (host) {
    const hostBersih = String(host).replace(/\/+$/, '');
    if (origin === `http://${hostBersih}` || origin === `https://${hostBersih}`) return true;
    // Terowongan HTTPS -> aplikasi HTTP: Origin https, Host tetap sama.
    try {
      const u = new URL(origin);
      if (u.host === hostBersih) return true;
    } catch { /* sudah difilter di originDari */ }
  }
  return IZIN.includes(origin);
}

/** true kalau request ini memakai cookie auth (`token`). */
function pakaiCookieAuth(req) {
  return Boolean(req.cookies?.token);
}

/**
 * Middleware. Dipasang SETELAH cookieParser, SEBELUM rute.
 *
 * Menolak HANYA kalau: POST/PUT/PATCH/DELETE + pakai cookie auth + Origin DAN
 * Referer dua-duanya tidak ada, atau ada tapi tidak diizinkan.
 *
 * Bila Origin tidak ada, Referer dipakai. Bila keduanya tidak ada, request
 * DITOLAK — di endpoint uang, "tidak bisa dibuktikan asalnya" diperlakukan
 * sama dengan "asalnya tidak boleh".
 */
function cekOrigin(req, res, next) {
  const metode = String(req.method || '').toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(metode)) return next();
  if (!pakaiCookieAuth(req)) return next(); // Bearer / tanpa auth: bukan jalur CSRF

  const origin = originDari(req.get('origin')) || originDariReferer(req.get('referer'));

  if (!origin) {
    console.warn(`[CSRF] ${metode} ${req.path} ditolak: tanpa Origin & Referer (pakai cookie auth)`);
    return res.status(403).json({
      ok: false,
      message: 'Permintaan ditolak: asal permintaan tidak bisa diverifikasi. Muat ulang halaman lalu coba lagi.',
    });
  }
  if (!originDiizinkan(origin, req.get('host'))) {
    console.warn(`[CSRF] ${metode} ${req.path} ditolak: origin '${origin}' tidak diizinkan` +
      (IZIN.length ? ` (izin: ${IZIN.join(', ')})` : ' (ALLOWED_ORIGIN kosong — hanya origin sendiri yang diterima)'));
    return res.status(403).json({
      ok: false,
      message: 'Permintaan ditolak: asal permintaan tidak dikenali.',
    });
  }
  return next();
}

/** Dipakai saat boot supaya keadaan konfigurasinya kelihatan, bukan tebak-tebakan. */
function csrfDiperiksa() {
  return { env: 'ALLOWED_ORIGIN', jumlah: IZIN.length, izin: IZIN };
}

module.exports = { cekOrigin, csrfDiperiksa, originDiizinkan, originDari, originDariReferer };
