'use strict';
/**
 * test/plugin-loader-terdaftar.js
 *
 * Loader plugin (engine/whatsappEngine.js) cuma menerima DUA bentuk ekspor:
 *   `typeof mod === 'function'`  atau  `mod.handler` function.
 *
 * Bentuk lain = plugin dimuat TANPA ERROR, file-nya ada, tapi handler-nya tidak
 * pernah dipanggil. Command-nya muncul di log (dispatch kelihatan jalan) tapi
 * bot DIAM. Tidak ada satu pun pesan error — persis kelas "kegagalan senyap"
 * yang paling mahal: kelihatan seperti bot rusak, bukan seperti kode salah.
 *
 * KASUS NYATA: plugins/11-backup.js menulis
 *     module.exports = async function handler(ctx) {...}
 *     module.exports.limitedCmds = new Set([]);
 * Baris kedua MENEMPELKAN properti ke fungsi — bukan menggantinya. Jadi
 * `typeof mod` tetap 'function' dan `mod.limitedCmds` juga ada, TAPI ...
 * justru kombinasi itu yang aman. Yang berbahaya adalah urutan sebaliknya:
 *     module.exports = { limitedCmds: ... }   // objek, handler hilang
 *
 * Tes ini memuat SETIAP plugin lewat cara loader, jadi bentuk ekspor yang
 * tidak dikenali langsung kelihatan — sebelum sampai ke produksi.
 */

const fs = require('fs');
const path = require('path');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

// ─── Replika PERSIS loadPlugins() dari engine/whatsappEngine.js ───────────────
const dir = path.resolve(__dirname, '../plugins');

// SATU berkas di folder itu sengaja BUKAN plugin: `07-button-helpers.js`
// mengeskpor objek `{ sendCategoryDropdown }` dan dipakai lewat
// `require('./07-button-helpers')` di 07-button.js. Loader mengabaikannya
// dengan benar (bukan function, tidak ada .handler) — jadi dia BUKAN temuan.
// Daftar kecualinya eksplisit supaya berkas ketiga tidak bisa menyelinap.
const BUKAN_PLUGIN = new Set(['07-button-helpers.js']);

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
const harusJadiPlugin = files.filter((f) => !BUKAN_PLUGIN.has(f));

console.log(`=== Memuat ${harusJadiPlugin.length} plugin (+${BUKAN_PLUGIN.size} helper dikecualikan) ===\n`);

const diterima = [];
const ditolak = [];
const gagalMuat = [];

for (const file of harusJadiPlugin) {
  let mod;
  try {
    // Loader asli: require(path.join(pluginsDir, file))
    mod = require(path.join(dir, file));
  } catch (e) {
    gagalMuat.push([file, e.message]);
    continue;
  }
  if (typeof mod === 'function' || typeof mod.handler === 'function') {
    diterima.push(file);
  } else {
    ditolak.push(file);
  }
}

for (const f of diterima) console.log(`✅ diterima   ${f}`);
for (const f of ditolak) console.log(`❌ DITOLAK   ${f}  <- typeof exports: ${typeof require(path.join(dir, f))}`);

console.log('');
cek('tidak ada plugin yang gagal dimuat', gagalMuat.length === 0,
  gagalMuat.map(([f, m]) => `${f}: ${m}`).join('; '));

cek('semua plugin diterima loader', ditolak.length === 0,
  `ditolak: ${ditolak.join(', ')} — handler-nya tidak akan pernah dipanggil`);

cek('jumlah diterima == jumlah plugin yang harus diterima', diterima.length === harusJadiPlugin.length,
  `${diterima.length}/${harusJadiPlugin.length}`);

cek('berkas helper memang masih berbentuk objek (bukan plugin tak sengaja)',
  typeof require(path.join(dir, '07-button-helpers.js')) === 'object',
  'kalau jadi function, dia ikut dipanggil loader tiap pesan');

// ─── Khusus 11-backup: harus tetap owner-only DAN tetap punya handler ────────
console.log('');
const backup = require(path.join(dir, '11-backup.js'));
cek('11-backup.js tetap punya handler yang dipanggil loader',
  typeof backup === 'function' || typeof backup.handler === 'function',
  `typeof = ${typeof backup}`);
cek('11-backup.js masih mengekspor limitedCmds (kontrak engine/limitedCmds.js)',
  backup.limitedCmds instanceof Set, String(backup.limitedCmds));

// ─── Jaring kedua: plugin WAJIB punya gerbang command sendiri ────────────────
// Loader memanggil SEMUA handler untuk tiap pesan; yang memutuskan "ini bukan
// punyaku" adalah `if (command !== '...') return false` di awal handler.
// Handler yang selalu `return true` akan MENELAN SEMUA pesan dan bot diam total.
console.log('');
console.log('=== Handler wajib bisa menolak command yang bukan miliknya ===');
const SUMBER = path.join(dir, '11-backup.js');
const src = fs.readFileSync(SUMBER, 'utf8');
cek('11-backup.js punya gerbang `command !== \'backup\'`',
  /command\s*!==\s*'backup'/.test(src),
  'tanpa ini, .backup menelan semua command lain');

console.log('');
console.log(gagal ? `=== GAGAL: ${gagal} masalah ===` : '=== SEMUA CEK LULUS ===');
process.exit(gagal ? 1 : 0);
