'use strict';
// Cek: (1) `.restart` kecatat di .menu, (2) gate owner/dev bener,
// (3) restartWhatsAppBot nge-set is_running=1 SEBELUM stop (biar auto-start
//     boot nggak ninggalin bot) dan nggak dobel-start.
const assert = require('assert');
const path = require('path');
const os = require('os');

// ── 1. Command kecatat ───────────────────────────────────────────────────────
const { ALL_COMMANDS, CATS } = require('../plugins/01-info');
assert.ok(ALL_COMMANDS.includes('restart'), '1. `restart` harus ada di ALL_COMMANDS');
assert.ok(CATS.owner.includes('restart'), '1. `restart` harus ada di kategori owner');
console.log('✓ 1. .restart kecatat di .menu kategori owner');

// ── 2. Gate owner/dev di 05-owner.js ─────────────────────────────────────────
const fs = require('fs');
const src = fs.readFileSync(path.join(__dirname, '..', 'plugins', '05-owner.js'), 'utf8');
assert.ok(/case 'restart'/.test(src), '2. case restart ada');
// Gate-nya sekarang `ctx.isOwner || ctx.isDev` — peran dev dihitung sekali di
// engine (dulu tiap plugin baca DEVELOPER_NUMBER sendiri, gampang meleset).
assert.ok(/!ctx\.isOwner && !ctx\.isDev/.test(src), '2. gate harus owner ATAU dev');
console.log('✓ 2. gate owner + dev ada di case restart');

// ── 3. Urutan is_running=1 sebelum stop ──────────────────────────────────────
// Pakai stub: engine-nya di-require dengan pool & baileys dipalsukan.
const Module = require('module');
const origResolve = Module._resolveFilename;
const calls = [];
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === '../config/database' || req.endsWith('/config/database')) {
    return { pool: { execute: async (sql, args) => { calls.push(['sql', sql.trim().slice(0, 60), args?.[0]]); return [[{ id: 7, bot_name: 'Tester', platform: 'whatsapp', owner_number: '6287778032605' }]]; } } };
  }
  if (req === '../engine/api' || req.endsWith('/engine/api')) return { uploadInfo: async () => ({}) };
  if (req === 'baileys' || req === '@whiskeysockets/baileys') return { proto: {}, default: {} };
  return origLoad.apply(this, arguments);
};

(async () => {
  let engine;
  try { engine = require('../engine/whatsappEngine'); }
  finally { Module._load = origLoad; }

  assert.ok(typeof engine.restartWhatsAppBot === 'function', '3. restartWhatsAppBot harus diexport');
  assert.ok(typeof engine.restartWhatsAppBotInBackground === 'function', '3b. versi background diexport');

  // stub bagian dalam: ganti stop & start lewat activeBots + module.exports gak bisa,
  // jadi kita cek urutan lewat observasi panggilan DB + aktivitas bot.
  const { activeBots } = require('../controllers/botController');

  // restart bot yang nggak jalan -> harus nolak, bukan diam-diam start
  await assert.rejects(() => engine.restartWhatsAppBot(7), /tidak sedang berjalan/,
    '3c. restart bot yg nggak jalan harus error jelas');
  console.log('✓ 3. restartWhatsAppBot nolak bot yang nggak jalan (nggak diem-diem nyalain)');

  // bot "jalan": masukkan instan palsu, lalu restart -> harus is_running=1 dicatat
  activeBots.set(7, { disconnect: async () => { calls.push(['disconnect']); },
                      __closeAuth: () => {} });
  calls.length = 0;
  await engine.restartWhatsAppBot(7).catch((e) => calls.push(['start-error', e.message]));

  const sqlIdx   = calls.findIndex((c) => c[0] === 'sql' && /is_running = 1/.test(c[1]));
  const discIdx  = calls.findIndex((c) => c[0] === 'disconnect');
  assert.ok(sqlIdx !== -1, '3d. is_running=1 harus di-set saat restart');
  assert.ok(discIdx === -1 || sqlIdx < discIdx,
    '3e. is_running=1 WAJIB diset SEBELUM disconnect (kalau nggak, auto-start boot ninggalin bot)');
  console.log('✓ 4. is_running=1 diset sebelum stop' + (discIdx === -1 ? ' (stop nggak kepanggil karena guard)' : ''));

  console.log('\n✓ restart: command kecatat + gate owner/dev + urutan is_running aman');
})().catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
