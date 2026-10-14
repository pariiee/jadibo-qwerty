'use strict';
/**
 * test/start-bot-expired.js — temuan #25: bot stop_reason='expired' tidak
 * boleh dinyalakan manual kalau paketnya belum dibayar lagi.
 *
 * Kenapa ada: tanpa guard ini, pemilik bisa klik Start berulang. Bot hidup
 * ~1 menit, cron 1-menit (server.js) mematikannya lagi karena paket habis,
 * pemilik klik lagi → bot hidup ~50-60% waktu TANPA bayar.
 *
 * Dua bagian:
 *   1. KONTRAK — guard-nya benar-benar ada di startBot().
 *   2. PERILAKU — jalankan startBot() dengan req/res tiruan + pool tiruan,
 *      pastikan expired TANPA paket → 402 dan engineBus.start TIDAK dipanggil,
 *      sedangkan paket aktif → engineBus.start DIPANGGIL.
 *
 * Jalankan: node test/start-bot-expired.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const base = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(base, 'controllers/botController.js'), 'utf8');

// ── 1. KONTRAK ───────────────────────────────────────────────────────────────
console.log('=== 1. Kontrak: guard ada di startBot() ===');

// File-nya CRLF (Windows) — jangan pakai `\n}` saja, itu tidak akan match.
const m = src.match(/async function startBot\(req, res\) \{([\s\S]*?)\r?\n\}\r?\n/);
assert.ok(m, 'startBot() tidak ditemukan');
const blok = m[1];

assert.match(blok, /stop_reason\s*===\s*'expired'/,
  "startBot() harus memeriksa stop_reason === 'expired'");
assert.match(blok, /sendError\(res,\s*402/,
  'harus membalas 402 (Payment Required) saat paket habis');
assert.match(blok, /aktif\(/,
  'harus memakai helper aktif() dari config/plan — jangan tulis cek tanggal sendiri');

// Guard HARUS di atas pemanggilan engineBus.start — kalau tidak, bot tetap nyala.
const iGuard = blok.search(/stop_reason\s*===\s*'expired'/);
const iStart = blok.search(/engineBus\.start\(/);
assert.ok(iGuard !== -1 && iStart !== -1, 'penanda tidak ditemukan');
assert.ok(iGuard < iStart,
  'guard stop_reason HARUS sebelum engineBus.start() — kalau sesudah, bot terlanjur nyala');
console.log('✅ guard `stop_reason === \'expired\'` + 402 + aktif() ADA, dan sebelum engineBus.start()');

// ── 2. PERILAKU ──────────────────────────────────────────────────────────────
console.log('\n=== 2. Perilaku: startBot() dengan pool & engineBus tiruan ===');

// Cegat modul yang dipakai controller sebelum di-require.
const ModulPath = (rel) => require.resolve(path.join(base, rel));

let BOT = null;      // baris `bots` yang dikembalikan
let USER = null;     // baris `users` yang dikembalikan
let dipanggil = 0;   // berapa kali engineBus.start dipanggil

// config/database → pool tiruan
const dbPath = ModulPath('config/database');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    pool: {
      execute: async (sql, params) => {
        if (/FROM bots/i.test(sql)) return [BOT ? [BOT] : []];
        if (/FROM users/i.test(sql)) return [USER ? [USER] : []];
        return [[], {}];
      },
    },
    testConnection: async () => true,
  },
};

// config/engineBus → start tiruan (jangan benar-benar menyalakan bot)
const busPath = ModulPath('config/engineBus');
require.cache[busPath] = {
  id: busPath, filename: busPath, loaded: true,
  exports: { start: async () => { dipanggil++; return { message: 'ok' }; } },
};

// botSlug → jangan sentuh DB
const slugPath = ModulPath('config/botSlug');
require.cache[slugPath] = {
  id: slugPath, filename: slugPath, loaded: true,
  exports: { resolveBotId: async (v) => Number(v), pastikanSlug: async () => 'slug' },
};

delete require.cache[ModulPath('controllers/botController.js')];
const bot = require(path.join(base, 'controllers/botController.js'));

/** req/res tiruan. assertOwnership lolos lewat user dengan role 'user'. */
function reqRes(role = 'user') {
  const res = {
    kode: null, isi: null,
    status(c) { this.kode = c; return this; },
    json(o) { this.isi = o; return this; },
  };
  return {
    req: { user: { id: 7, role }, params: { id: '5' }, body: {} },
    res,
  };
}

(async () => {
  // ── 2a. expired + paket habis + user biasa → TOLAK 402 ────────────────────
  BOT = { id: 5, user_id: 7, stop_reason: 'expired' };
  USER = { role: 'user', plan_expired_at: new Date(Date.now() - 86400000) }; // kemarin
  dipanggil = 0;
  let { req, res } = reqRes('user');
  await bot.startBot(req, res);
  assert.strictEqual(res.kode, 402,
    `harus 402 saat paket habis, dapat ${res.kode} (isi: ${JSON.stringify(res.isi)})`);
  assert.strictEqual(dipanggil, 0,
    'engineBus.start TIDAK boleh dipanggil saat paket habis — bot akan nyala tanpa bayar');
  console.log('✅ expired + paket habis  -> 402, engineBus.start TIDAK dipanggil');

  // ── 2b. expired tapi paket SUDAH dibayar lagi → boleh start ───────────────
  USER = { role: 'user', plan_expired_at: new Date(Date.now() + 86400000) }; // besok
  dipanggil = 0;
  ({ req, res } = reqRes('user'));
  await bot.startBot(req, res);
  assert.strictEqual(dipanggil, 1,
    'paket aktif harus BOLEH start — kalau ditolak, user yang sudah bayar tidak bisa nyalakan');
  console.log('✅ expired + paket aktif  -> engineBus.start DIPANGGIL (boleh)');

  // ── 2c. paket NULL (belum pernah bayar) → TOLAK ───────────────────────────
  USER = { role: 'user', plan_expired_at: null };
  dipanggil = 0;
  ({ req, res } = reqRes('user'));
  await bot.startBot(req, res);
  assert.strictEqual(res.kode, 402, 'plan_expired_at NULL harus 402');
  assert.strictEqual(dipanggil, 0, 'engineBus.start tidak boleh dipanggil');
  console.log('✅ expired + belum pernah bayar -> 402, tidak dipanggil');

  // ── 2d. admin (kawula) tetap boleh ────────────────────────────────────────
  USER = { role: 'kawula', plan_expired_at: null };
  dipanggil = 0;
  ({ req, res } = reqRes('kawula'));
  await bot.startBot(req, res);
  assert.strictEqual(dipanggil, 1,
    'admin harus tetap bisa menyalakan bot (mis. buat debug) walau paket habis');
  console.log('✅ admin (kawula)         -> engineBus.start DIPANGGIL (boleh)');

  // ── 2e. BUKAN expired → tidak tersentuh guard ─────────────────────────────
  BOT = { id: 5, user_id: 7, stop_reason: null };
  USER = { role: 'user', plan_expired_at: null };
  dipanggil = 0;
  ({ req, res } = reqRes('user'));
  await bot.startBot(req, res);
  assert.strictEqual(dipanggil, 1,
    'stop_reason NULL harus lolos — guard ini HANYA untuk expired');
  console.log('✅ stop_reason NULL       -> engineBus.start DIPANGGIL (tidak tersentuh guard)');

  console.log('\nsemua ok — #25 dijaga: expired tanpa paket tidak bisa di-start manual');
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
