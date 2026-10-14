'use strict';
/**
 * test/csrf-origin.js — lapis kedua CSRF (Origin/Referer).
 *
 * Cookie auth sudah `SameSite=Lax`, dan `Lax` memang TIDAK mengirim cookie pada
 * POST lintas-situs (termasuk navigasi top-level form). Jadi ini BUKAN
 * pengganti — ini lapis kedua di jalur uang, karena satu POST yang lolos =
 * saldo atau paket berubah, dan `Lax` bergantung pada browser menghormatinya.
 *
 * Yang dikunci:
 *   1. Origin benar -> lolos
 *   2. Origin salah -> 403
 *   3. Origin & Referer dua-duanya kosong -> 403 (di endpoint uang, "tidak bisa
 *      dibuktikan" = "tidak boleh")
 *   4. Origin kosong TAPI Referer benar -> lolos (fallback)
 *   5. Webhook & request tanpa cookie -> TIDAK diperiksa (kalau diperiksa,
 *      pembayaran sah akan ditolak)
 *   6. GET tidak diperiksa (tidak mengubah apa pun)
 *   7. ALLOWED_ORIGIN kosong -> hanya origin sendiri yang diterima
 *
 * Nggak nyentuh DB, nggak nyentuh jaringan.
 *
 * Jalankan: node test/csrf-origin.js
 */
const path = require('path');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`  ✓ ${nama}`);
  else { gagal++; console.error(`  ✗ ${nama}${info ? ' — ' + info : ''}`); }
};

const IZIN = 'https://labs.yapari.web.id';
process.env.ALLOWED_ORIGIN = IZIN;
const { cekOrigin, csrfDiperiksa } = require('../config/cekOrigin');

/** Bikin req palsu. `cookie` true = pakai cookie auth. */
function req({ method = 'POST', origin, referer, host = 'labs.yapari.web.id', cookie = true, path: p = '/api/wallet/topup' }) {
  const headers = {};
  if (origin !== undefined) headers.origin = origin;
  if (referer !== undefined) headers.referer = referer;
  headers.host = host;
  return {
    method, path: p, cookies: cookie ? { token: 'x' } : {},
    get: (k) => headers[String(k).toLowerCase()],
  };
}

function jalankan(r) {
  let kode = null, lanjut = false, body = null;
  const res = {
    status(c) { kode = c; return this; },
    json(b) { body = b; return this; },
  };
  cekOrigin(r, res, () => { lanjut = true; });
  return { lanjut, kode, body };
}

console.log('=== Nama variabel env yang dipakai ===');
const info = csrfDiperiksa();
console.log(`  env: ${info.env}, jumlah izin: ${info.jumlah} (${info.izin.join(', ')})`);
cek('memakai ALLOWED_ORIGIN (sama seperti CORS)', info.env === 'ALLOWED_ORIGIN', info.env);

console.log('\n=== 1. Origin benar ===');
let h = jalankan(req({ origin: IZIN }));
cek('origin sesuai izin -> LOLOS', h.lanjut === true && h.kode === null, JSON.stringify(h));

h = jalankan(req({ origin: 'https://labs.yapari.web.id/' })); // garis miring di ekor
cek('origin dengan / di ekor tetap LOLOS', h.lanjut === true, JSON.stringify(h));

h = jalankan(req({ origin: 'https://labs.yapari.web.id', host: 'labs.yapari.web.id' }));
cek('origin == host sendiri -> LOLOS walau tidak di daftar izin', h.lanjut === true, JSON.stringify(h));

console.log('\n=== 2. Origin salah -> 403 ===');
for (const jahat of ['https://jahat.example', 'http://labs.yapari.web.id.evil.com', 'null']) {
  h = jalankan(req({ origin: jahat, referer: 'https://jahat.example/x' }));
  cek(`origin '${jahat}' -> 403`, h.lanjut === false && h.kode === 403, JSON.stringify(h));
}

console.log('\n=== 3. Origin & Referer dua-duanya kosong -> 403 ===');
h = jalankan(req({}));
cek('tanpa Origin & Referer -> 403', h.lanjut === false && h.kode === 403, JSON.stringify(h));
cek('pesannya manusiawi (tidak bocorin istilah internal)',
  typeof h.body?.message === 'string' && !/origin|referer|csrf/i.test(h.body.message), h.body?.message);

h = jalankan(req({ origin: '', referer: '' }));
cek('Origin & Referer string kosong -> 403', h.lanjut === false && h.kode === 403, JSON.stringify(h));

console.log('\n=== 4. Origin kosong, Referer benar -> LOLOS (fallback) ===');
h = jalankan(req({ referer: `${IZIN}/saldo` }));
cek('Referer dipakai kalau Origin tidak ada', h.lanjut === true, JSON.stringify(h));

h = jalankan(req({ origin: 'bukan-url', referer: `${IZIN}/saldo` }));
cek('Origin rusak -> jatuh ke Referer yang benar', h.lanjut === true, JSON.stringify(h));

console.log('\n=== 5. Yang TIDAK boleh diperiksa ===');
h = jalankan(req({ cookie: false }));  // webhook: tanpa cookie, tanpa Origin
cek('tanpa cookie auth (mis. webhook) -> LOLOS', h.lanjut === true, JSON.stringify(h));

h = jalankan(req({ cookie: false, origin: 'https://jahat.example', path: '/api/payment/webhook' }));
cek('webhook dengan Origin asing -> LOLOS (ditangani tanda tangan HMAC, bukan Origin)',
  h.lanjut === true, JSON.stringify(h));

h = jalankan(req({ method: 'GET', origin: 'https://jahat.example' }));
cek('GET -> LOLOS (tidak mengubah apa pun)', h.lanjut === true, JSON.stringify(h));

h = jalankan(req({ method: 'OPTIONS' }));
cek('OPTIONS -> LOLOS', h.lanjut === true, JSON.stringify(h));

// Muat ulang modul dengan env kosong, supaya IZIN-nya benar-benar kosong.
delete require.cache[require.resolve('../config/cekOrigin')];
const envLama = process.env.ALLOWED_ORIGIN;
delete process.env.ALLOWED_ORIGIN;
const mod2 = require('../config/cekOrigin');
const info2 = mod2.csrfDiperiksa();
cek('daftar izin kosong terdeteksi', info2.jumlah === 0, JSON.stringify(info2));

const jalankan2 = (r) => {
  let kode = null, lanjut = false;
  const res = { status(c) { kode = c; return this; }, json() { return this; } };
  mod2.cekOrigin(r, res, () => { lanjut = true; });
  return { lanjut, kode };
};
cek('origin asing -> 403 (tidak ada daftar izin)',
  jalankan2(req({ origin: 'https://jahat.example' })).kode === 403);
cek('origin == host sendiri -> tetap LOLOS (dev tetap jalan)',
  jalankan2(req({ origin: 'https://labs.yapari.web.id', host: 'labs.yapari.web.id' })).lanjut === true);
cek('Origin & Referer kosong -> 403 juga',
  jalankan2(req({})).kode === 403);

process.env.ALLOWED_ORIGIN = envLama;

// ══════════════════════════════════════════════════════════════════════════════
// 7. Simulasi Cloudflare Tunnel (cloudflared)
// ══════════════════════════════════════════════════════════════════════════════
//
// Di produksi, user TIDAK menyentuh Express langsung: cloudflared (jalan di
// localhost) yang meneruskan, dan menambahkan X-Forwarded-Proto + For. Karena
// `app.set('trust proxy', 'loopback')` (server.js:119), Express mempercayai
// header itu HANYA kalau peer-nya loopback — yaitu cloudflared, bukan penyerang.
//
// Yang penting untuk middleware ini: `req.get('host')` tetap berisi Host ASLI
// (`labs.yapari.web.id`), karena cloudflared meneruskannya. Jadi "origin sendiri"
// dihitung dari Host header, BUKAN dari req.ip atau req.protocol.
console.log('\n=== 7. Simulasi cloudflared (X-Forwarded-Proto + Host produksi) ===');

const HOST_PROD = 'labs.yapari.web.id';

/** req dengan header proxy, seperti yang datang dari cloudflared. */
function reqProxy({ origin, referer, host = HOST_PROD, xfp = 'https', cookie = true }) {
  const headers = { host };
  if (origin !== undefined) headers.origin = origin;
  if (referer !== undefined) headers.referer = referer;
  if (xfp !== undefined) headers['x-forwarded-proto'] = xfp;
  headers['x-forwarded-for'] = '203.0.113.7'; // IP user asli, bukan loopback
  return {
    method: 'POST', path: '/api/wallet/perpanjang',
    cookies: cookie ? { token: 'x' } : {},
    get: (k) => headers[String(k).toLowerCase()],
  };
}

let hp = jalankan(reqProxy({ origin: `https://${HOST_PROD}` }));
cek('cloudflared: Origin benar + XFP=https -> LOLOS', hp.lanjut === true, JSON.stringify(hp));

hp = jalankan(reqProxy({ origin: 'https://jahat.example' }));
cek('cloudflared: Origin salah -> 403', hp.kode === 403, JSON.stringify(hp));

hp = jalankan(reqProxy({}));
cek('cloudflared: Origin & Referer kosong -> 403', hp.kode === 403, JSON.stringify(hp));

hp = jalankan(reqProxy({ referer: `https://${HOST_PROD}/saldo` }));
cek('cloudflared: Referer saja (Origin tidak ada) -> LOLOS', hp.lanjut === true, JSON.stringify(hp));

hp = jalankan(reqProxy({ origin: `https://${HOST_PROD}` }));
cek('cloudflared: origin == host produksi diterima walau ALLOWED_ORIGIN diisi',
  hp.lanjut === true, JSON.stringify(hp));

// Host yang dipalsukan: Origin dan Host DUA-DUANYA diisi nilai yang sama oleh
// penyerang. Ini SENGAJA LOLOS, dan itu bukan lubang — alasannya:
//
//   Penyerang tidak bisa memalsukan Host. Browser mengirim Host berdasarkan
//   URL yang dibuka korban, dan halaman jahat itu dilayani oleh SERVER SI
//   PENYERANG — jadi Host yang dia lihat adalah host si penyerang sendiri
//   (jahat.example), bukan host kita. Supaya Host berisi host kita, si penyerang
//   harus menyuruh korban mengakses domain kita — dan begitu halamannya datang
//   dari domain kita, Origin-nya juga domain kita, dan itu permintaan yang sah.
//
// Yang benar-benar melindungi tetap: cookie `SameSite=Lax` (browser tidak
// mengirim cookie pada POST lintas-situs) + daftar izin ALLOWED_ORIGIN. Cabang
// "Origin == Host" itu justru yang membuat dev/port-ganti tetap jalan tanpa
// konfigurasi.
//
// Jadi yang diuji di sini bukan "host palsu ditolak", tapi: cabang itu TIDAK
// membuat Origin ASING lolos (Origin jahat + Host kita harus tetap 403).
hp = jalankan(reqProxy({ origin: 'https://jahat.example', host: 'jahat.example' }));
cek('Origin cocok Host-nya -> LOLOS (cabang "origin sendiri", bukan lubang — lihat komentar)',
  hp.lanjut === true, JSON.stringify(hp));

hp = jalankan(reqProxy({ origin: 'https://jahat.example', host: HOST_PROD }));
cek('Origin jahat + Host KITA -> tetap 403 (yang ini yang wajib ditolak)',
  hp.kode === 403, JSON.stringify(hp));

// Port dev: Express jalan di :3000 di balik cloudflared. Host bisa memuat port.
hp = jalankan(reqProxy({ origin: 'http://127.0.0.1:3999', host: '127.0.0.1:3999', xfp: 'http' }));
cek('dev: origin == host:port sendiri -> LOLOS', hp.lanjut === true, JSON.stringify(hp));

console.log(`\n${'─'.repeat(50)}`);
if (gagal) { console.error(`❌ ${gagal} pemeriksaan GAGAL`); process.exit(1); }
console.log('✅ CSRF lapis kedua: origin benar lolos, salah/tanpa asal ditolak, webhook tidak diganggu');
