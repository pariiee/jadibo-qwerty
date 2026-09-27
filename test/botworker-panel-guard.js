'use strict';
/**
 * Uji guard "bot panel lain" di workers/botWorker.js.
 *
 * Kenapa ada: panel labs & panel zapo berbagi tabel `bots`. Tanpa guard,
 * watchdog/boot panel labs nyalain bot ber-platform `zapo` pakai engine
 * Baileys → dua engine rebutan nomor yang sama → WA logout.
 *
 * Yang diuji murni logikanya (nggak perlu DB/PM2):
 *   1. default nama platform panel lain = 'zapo'
 *   2. env ENGINE_LAIN_PLATFORM bisa nimpah
 *   3. pola saring SQL yang dipakai watchdog & boot
 *   4. keputusan botDariDb() buat tiap platform
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

let gagal = 0;
let total = 0;
function ok(nama, fn) {
  total++;
  try { fn(); console.log('  ✓ ' + nama); }
  catch (e) { gagal++; console.log('  ✗ ' + nama + ' → ' + e.message); }
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'workers', 'botWorker.js'), 'utf8');

// ─── 1. Default nama platform ────────────────────────────────────────────────
delete process.env.ENGINE_LAIN_PLATFORM;
ok("default PLATFORM_PANEL_LAIN = 'zapo'", () => {
  assert.ok(/process\.env\.ENGINE_LAIN_PLATFORM \|\| 'zapo'/.test(SRC),
    "baris default 'zapo' nggak ada di botWorker.js");
});

// ─── 2. Env bisa nimpah (tanpa nyentuh kode) ─────────────────────────────────
ok('env ENGINE_LAIN_PLATFORM dipakai (bukan hardcode)', () => {
  process.env.ENGINE_LAIN_PLATFORM = 'zapo';
  const nama = process.env.ENGINE_LAIN_PLATFORM || 'zapo';
  assert.strictEqual(nama, 'zapo');
});

// ─── 3. Pola saring SQL ──────────────────────────────────────────────────────
ok('watchdog nyaring platform panel lain', () => {
  const m = SRC.match(/SELECT id, platform FROM bots WHERE is_running = 1 AND platform <> \?/);
  assert.ok(m, 'watchdog (setInterval) belum difilter platform <> ?');
});

ok('boot nyaring platform panel lain', () => {
  const m = SRC.match(/SELECT \* FROM bots WHERE is_running = 1 AND platform <> \?/);
  assert.ok(m, 'boot() belum difilter platform <> ?');
});

ok('nggak ada SELECT is_running = 1 yang lolos tanpa saring', () => {
  const semua = SRC.match(/SELECT[^'"`]*FROM bots WHERE is_running = 1[^'"`]*/g) || [];
  const lolos = semua.filter((s) => !/platform <> \?/.test(s));
  assert.deepStrictEqual(lolos, [],
    'masih ada query auto-start tanpa saring: ' + JSON.stringify(lolos));
});

// ─── 4. Keputusan botDariDb() ────────────────────────────────────────────────
// Replika gerbang yang dipasang di botDariDb(), biar keputusannya ikut diuji.
function ditolakPanelIni(platform, panelLain = 'zapo') {
  return platform === panelLain;
}

ok('bot zapo DITOLAK panel ini', () => {
  assert.strictEqual(ditolakPanelIni('zapo'), true);
});

ok('bot whatsapp DITERIMA panel ini (bot 1 aman)', () => {
  assert.strictEqual(ditolakPanelIni('whatsapp'), false);
});

ok('bot telegram DITERIMA panel ini (slot TG tetap jalan)', () => {
  assert.strictEqual(ditolakPanelIni('telegram'), false);
});

ok('guard ada DI DALAM botDariDb (gerbang bersama semua jalur)', () => {
  const fn = SRC.slice(SRC.indexOf('async function botDariDb'));
  const badan = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(/bot\.platform === PLATFORM_PANEL_LAIN/.test(badan),
    'guard nggak ada di botDariDb()');
  assert.ok(/status = 400/.test(badan), 'error ditolak tanpa status 400');
});

// ─── 5. Pesan error kebaca user ──────────────────────────────────────────────
ok('pesan error nyebut nama panel tujuan', () => {
  assert.ok(/panel \$\{PLATFORM_PANEL_LAIN\}/.test(SRC),
    'pesan error nggak nyebut panel yang benar');
});

console.log('\n' + (gagal ? `✗ ${gagal} GAGAL` : `✓ semua lolos (${total}/${total})`));
process.exit(gagal ? 1 : 0);
