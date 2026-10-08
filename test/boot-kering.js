'use strict';
/**
 * test/boot-kering.js
 *
 * Nyala-in server.js dengan MySQL DIPALSUKAN, lalu ketuk tiap rute baru dan
 * pastikan balasannya bukan 404 (rute nggak terpasang) dan bukan 500.
 *
 * Kenapa perlu: tes statis cuma buktiin handler-nya ada di controller, bukan
 * bahwa rutenya benar-benar terpasang & middleware-nya jalan. Boot beneran
 * butuh MySQL; di mesin dev nggak ada. Pool palsu bikin boot tetap jalan
 * tanpa nyentuh DB mana pun.
 */
const http = require('http');

process.env.PORT = process.env.PORT || '39311';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'uji-boot-kering';
process.env.INTERNAL_KEY = process.env.INTERNAL_KEY || 'uji-boot-kering';
process.env.NODE_ENV = 'test';

// ── Palsukan mysql2 SEBELUM config/database.js memuatnya ─────────────────────
const mysql = require('mysql2/promise');
const KOSONG = [[], []];
const poolPalsu = {
  execute: async () => KOSONG,
  query: async () => KOSONG,
  getConnection: async () => ({
    execute: async () => KOSONG,
    query: async () => KOSONG,
    release() {},
  }),
  end: async () => {},
};
mysql.createPool = () => poolPalsu;
mysql.createConnection = async () => poolPalsu;

const PORT = Number(process.env.PORT);

function minta(method, path) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path, method, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body: body.slice(0, 120) }));
      }
    );
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.end();
  });
}

// Rute: [method, path, status yang DILARANG]
// 404 = rute nggak terpasang. 500 = handler-nya meledak.
const RUTE = [
  ['GET',  '/',                          'halaman index'],
  ['GET',  '/login',                     'halaman login'],
  ['GET',  '/register',                  'halaman register'],
  ['GET',  '/forgot-password',           'halaman forgot password'],
  ['GET',  '/reset-password',            'halaman reset password'],
  ['GET',  '/pricing',                   'halaman pricing'],
  ['GET',  '/langganan',                 'halaman langganan'],
  ['GET',  '/kountole',                  'panel admin (path sengaja tidak /admin)'],
  ['GET',  '/health',                    'kesehatan sistem'],
  // ENDPOINT /api/admin/* SENGAJA tetap di path itu: yang dipindah cuma
  // HALAMANNYA. Mengubah path API = mengubah kontrak, dan penebak tidak dapat
  // apa-apa dari `/api/admin/*` tanpa sesi login + role `kawula`.
  ['GET',  '/admin',                     'HARUS MATI: panel pindah ke /kountole', 404],
  ['GET',  '/config/4',                  'halaman config bot'],
  ['GET',  '/api/plans',                 'daftar paket'],
  ['GET',  '/api/billing/orders',        'order milik user'],
  ['GET',  '/api/admin/billing/orders',  'order (admin)'],
  ['GET',  '/api/admin/billing/settings','setelan billing (admin)'],
  ['POST', '/api/admin/bots/4/kuota',       'top-up kuota pesan (admin)'],
  ['POST', '/api/admin/bots/4/reset-kuota', 'reset pemakaian kuota (admin)'],
  ['GET',  '/api/bots/4/stats',          'statistik bot'],
  ['GET',  '/api/bots/4/config',         'ekspor config bot'],
  ['POST', '/api/billing/checkout',      'checkout'],
  ['POST', '/api/payment/webhook',       'webhook QRIS'],
  ['POST', '/api/bots/4/resolve-invite', 'resolve link grup'],
  ['POST', '/internal/op',               'jembatan panel'],
];

(async () => {
  require('../server.js');

  // Tunggu server benar-benar listen
  let siap = false;
  for (let i = 0; i < 60; i++) {
    const r = await minta('GET', '/');
    if (r.status) { siap = true; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!siap) { console.log('❌ server nggak listen'); process.exit(1); }

  let gagal = 0;
  for (const [method, path, label, harap] of RUTE) {
    const r = await minta(method, path);
    // `harap` diisi kalau status yang BENAR justru status "jelek" (mis. /admin
    // harus 404). Tanpa itu, memindahkan panel balik ke /admin akan lolos diam-diam.
    const jelek = harap ? r.status !== harap : (r.status === 404 || r.status === 0 || r.status >= 500);
    if (jelek) gagal++;
    console.log(`${jelek ? '❌' : '✅'} ${String(r.status).padEnd(4)} ${method.padEnd(4)} ${path.padEnd(28)} ${label}`);
  }

  // Rute yang memang nggak ada harus tetap 404
  const nyasar = await minta('GET', '/halaman-nggak-ada-xyz');
  const nyasarOk = nyasar.status === 404;
  if (!nyasarOk) gagal++;
  console.log(`${nyasarOk ? '✅' : '❌'} ${nyasar.status} GET  /halaman-nggak-ada-xyz      (harus 404)`);

  // /health WAJIB 200/503, bukan 404 — kalau dia ikut hilang, uptime monitor
  // luar akan menganggap server mati padahal cuma route-nya yang lepas.
  const sehat = await minta('GET', '/health');
  const sehatOk = sehat.status === 200 || sehat.status === 503;
  if (!sehatOk) gagal++;
  console.log(`${sehatOk ? '✅' : '❌'} ${sehat.status} GET  /health                   (200 atau 503, bukan 404)`);

  console.log(gagal ? `\n=== GAGAL: ${gagal} rute bermasalah ===` : '\n=== SEMUA RUTE BARU HIDUP ===');
  process.exit(gagal ? 1 : 0);
})();
