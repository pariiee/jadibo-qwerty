'use strict';
/**
 * test/stats-jujur.js
 *
 * Landing page `/` itu PUBLIK dan menampilkan "Bot Online" + "Total Pengguna"
 * dari `/api/stats`. Angka-angka itu pernah BOHONG di produksi: tertulis
 * "306 bot online" dan "5 pengguna" padahal botnya 1 dan usernya 2 — dan
 * naik terus tiap pm2 restart. Yang salah bukan cuma nilainya, tapi caranya:
 *
 *   - `total_bots_online` di-increment tiap event `connection: open`
 *     (reconnect DAN tiap boot proses), sementara decrement-nya cuma jalan
 *     kalau prosesnya sempat putus dengan rapi. pm2 restart / crash tidak
 *     pernah menjalankannya → counter cuma bisa naik.
 *   - `total_users` polanya sama (register +1, delete -1).
 *
 * Perbaikannya dua lapis, dan tes ini mengunci KEDUANYA:
 *   1. `getStats()` menghitung bot online & user dari TABELNYA, bukan dari
 *      counter. Satu definisi "bot online" untuk seluruh aplikasi:
 *      `bots.status = 'connected'` — sama seperti `/health`.
 *   2. Jalur increment-nya di-guard, supaya tabel `stats` juga tidak makin
 *      ngawur buat siapa pun yang membacanya langsung.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

const baca = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

/**
 * Buang komentar sebelum memeriksa sumber.
 *
 * WAJIB. Komentar yang menjelaskan perbaikan ikut menyebut nama fungsi yang
 * dibuang ("Tanpa `incrementStat('total_bots_online')`…"), jadi pencocokan teks
 * mentah akan menuduh komentarnya sendiri — persis jebakan yang sudah pernah
 * kena di repo ini.
 */
const tanpaKomentar = (src) => src
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .map((l) => l.replace(/\s\/\/.*$/, ''))  // komentar di ujung baris
  .join('\n');

const dbSrc = baca('config/database.js');
const engine = tanpaKomentar(baca('engine/whatsappEngine.js'));
const telegramSrc = tanpaKomentar(baca('engine/telegramEngine.js'));
const authSrc = tanpaKomentar(baca('controllers/authController.js'));

console.log('=== 1. getStats() DIHITUNG dari tabel, bukan dari counter ===');
// Counter-nya sengaja diisi angka ngawur: kalau getStats masih membacanya,
// hasilnya ikut ngawur dan tes ini MERAH.
const poolPalsu = {
  execute: async (sql) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (/FROM stats/i.test(q)) {
      return [[
        { stat_key: 'total_bots_online', stat_value: 306 },
        { stat_key: 'total_users', stat_value: 5 },
        { stat_key: 'total_messages', stat_value: 14075 },
      ]];
    }
    if (/FROM bots/i.test(q)) return [[{ n: 1 }]];
    if (/FROM users/i.test(q)) return [[{ n: 2 }]];
    return [[]];
  },
};

const asli = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'mysql2/promise') {
    return { createPool: () => ({ execute: poolPalsu.execute, query: poolPalsu.execute, getConnection: async () => ({ release() {} }) }) };
  }
  return asli.apply(this, arguments);
};

(async () => {
  // database.js bikin pool sendiri saat di-require, jadi tiruannya harus aktif
  // SEBELUM require — dan sesudahnya perlu `testConnection` di-skip.
  process.env.DB_HOST = process.env.DB_HOST || 'localhost';
  const db = require(path.join(__dirname, '..', 'config', 'database.js'));
  Module.prototype.require = asli;

  const s = await db.getStats();
  cek('total_bots_online = 1 (dari tabel bots), BUKAN 306 (counter)',
    s.total_bots_online === 1, `dapat ${s.total_bots_online}`);
  cek('total_users = 2 (dari tabel users), BUKAN 5 (counter)',
    s.total_users === 2, `dapat ${s.total_users}`);
  cek('total_messages tetap dari counter (kumulatif, tidak pernah dikurangi)',
    s.total_messages === 14075, `dapat ${s.total_messages}`);
  cek('getStats tidak melempar kalau tabel bots kosong',
    typeof s.total_bots_online === 'number');

  console.log('\n=== 2. Definisi "bot online" SAMA dengan /health ===');
  const health = baca('engine/health.js');
  cek('health pakai status = \'connected\'', /status = 'connected'/.test(health));
  cek('getStats pakai status = \'connected\' (satu definisi, bukan dua)',
    /status = 'connected'/.test(dbSrc));
  cek('getStats TIDAK pakai is_running (bisa true walau WA-nya belum nyambung)',
    !/SUM\(is_running/i.test(dbSrc));

  console.log('\n=== 3. TIDAK ADA lagi yang menulis counter itu ===');
  // Guard saja tidak cukup. Decrement-nya cuma jalan kalau proses sempat putus
  // dengan rapi; pm2 restart / crash tidak pernah menjalankannya — jadi counter
  // TETAP naik tiap restart, cuma lebih lambat. Satu-satunya perbaikan jujur:
  // jangan tulis counter-nya sama sekali, hitung dari tabel saat dibaca.
  cek('whatsappEngine tidak menulis total_bots_online',
    !/Stat\('total_bots_online'\)/.test(engine),
    'masih ada di engine/whatsappEngine.js');
  const telegram = telegramSrc;
  cek('telegramEngine tidak menulis total_bots_online',
    !/Stat\('total_bots_online'\)/.test(telegram),
    'di telegram bahkan decrement-nya tidak pernah ada');
  const auth = authSrc;
  cek('authController tidak menulis total_users',
    !/Stat\('total_users'\)/.test(auth));

  console.log('\n=== 4. Counter yang TERSISA cuma yang kumulatif ===');
  // `total_messages` tidak pernah dikurangi → aman. Kalau suatu saat ada
  // counter baru, tes ini memaksa penulisnya berpikir dulu.
  const semuaSumber = [engine, telegramSrc, authSrc, tanpaKomentar(dbSrc)].join('\n');
  const dikelola = [...semuaSumber.matchAll(/Stat\('([a-z_]+)'/g)].map((m) => m[1]);
  const unik = [...new Set(dikelola)];
  cek(`counter yang masih dikelola: ${unik.join(', ') || '(tidak ada)'}`,
    unik.every((k) => k === 'total_messages'),
    'counter selain total_messages tidak akan pernah akurat — hitung dari tabelnya');

  console.log('');
  console.log(gagal ? `=== GAGAL: ${gagal} masalah ===` : '=== SEMUA CEK LULUS ===');
  process.exit(gagal ? 1 : 0);
})();
