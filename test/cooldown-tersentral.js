'use strict';
/**
 * test/cooldown-tersentral.js — kunci middleware cooldown.
 *
 * Kenapa ada: plugin 04-tools (245 case), 03-fun-rpg, 02-group tadinya tanpa
 * cooldown — server jadi proxy download gratis. Tambal per-case berarti
 * satu per satu bisa kelewat; dispatcher adalah satu titik yang lebih
 * mudah diaudit. Tes ini mengunci aturan:
 *
 *   1. config/cooldown.js ada & punya 6 kelompok (umum, berat, upload,
 *      judi, admin-grup, owner-destructive).
 *   2. engine/cooldown.js ada dengan cooldownGuard().
 *   3. cooldownGuard dipanggil di dispatcher WA & Telegram SEBELUM plugin
 *      handler.
 *   4. Owner & dev dikecualikan dari kelompok bukan-owner-destructive.
 *   5. Pelanggaran: balas "⏳ Tunggu" SEKALI per jendela — bukan spam
 *      balasan kalau user spam.
 *   6. Kelompok 'umum' (0.5 dtk) DIAM, tidak balas.
 *   7. Cleanup berjalan periodik (setInterval .unref()).
 *   8. Tabel kelompok berat/upload/judi/admin-grup berisi command-command
 *      yang berisiko spam.
 *
 * Statis. Yang diuji: source + struktur, bukan perilaku runtime.
 *
 * Jalankan: node test/cooldown-tersentral.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const base = path.join(__dirname, '..');
const tabel       = require('../config/cooldown');
const waEngine    = fs.readFileSync(path.join(base, 'engine/whatsappEngine.js'), 'utf8');
const tgEngine    = fs.readFileSync(path.join(base, 'engine/telegramEngine.js'), 'utf8');
const toolsPath = fs.existsSync(path.join(base, 'plugins/whatsapp/04-tools.js'))
  ? path.join(base, 'plugins/whatsapp/04-tools.js')
  : path.join(base, 'plugins/04-tools.js');
const tools = fs.readFileSync(toolsPath, 'utf8');

// ── 1. Tabel & kelompok ──────────────────────────────────────────────────────
console.log('=== 1. config/cooldown.js: 6 kelompok ===');
const namaHarap = ['umum','berat','upload','judi','admin-grup','owner-destructive'];
for (const n of namaHarap) {
  assert.ok(tabel.TABEL[n], `kelompok "${n}" tidak ada di TABEL`);
  const cfg = tabel.TABEL[n];
  assert.ok(typeof cfg.ms === 'number' && cfg.ms > 0, `${n}: ms harus > 0`);
  assert.ok(typeof cfg.balasan === 'boolean', `${n}: balasan harus boolean`);
}
console.log(`✅ ${namaHarap.length} kelompok: ${namaHarap.join(', ')}`);

// ── 2. cooldownGuard ada ─────────────────────────────────────────────────────
console.log('\n=== 2. engine/cooldown.js: cooldownGuard() ===');
const cdEngine = fs.readFileSync(path.join(base, 'engine/cooldown.js'), 'utf8');
assert.ok(/async\s+function\s+cooldownGuard\s*\(/.test(cdEngine), 'cooldownGuard() tidak ditemukan');
assert.ok(/setInterval\s*\(\s*cleanup\s*,/.test(cdEngine), 'setInterval cleanup tidak ditemukan');
assert.ok(/\.unref\(\)/.test(cdEngine), 'setInterval tidak di-unref() — bisa tahan proses shutdown');
console.log('✅ cooldownGuard() + setInterval cleanup().unref() ada');

// ── 3. Dispatcher WA panggil cooldown SEBELUM loop plugin ───────────────────
console.log('\n=== 3. Dispatcher WA: cooldownGuard() SEBELUM loop plugin ===');
// Cari: 'Jalankan semua plugin' (komentar) ... require('./cooldown') ... for (const handler
const iA = waEngine.indexOf('cooldownGuard');
const iB = waEngine.indexOf('for (const handler of plugins)');
assert.ok(iA > 0 && iB > 0, 'cooldownGuard atau loop plugin tidak ditemukan di whatsappEngine.js');
assert.ok(iA < iB, 'cooldownGuard dipanggil SETELAH loop plugin — middleware tidak berguna');
console.log('✅ cooldownGuard() dipanggil sebelum loop plugin di WA');

// ── 4. Dispatcher Telegram panggil cooldown SEBELUM loop plugin ─────────────
console.log('\n=== 4. Dispatcher Telegram: cooldownGuard() SEBELUM loop plugin ===');
const iC = tgEngine.indexOf('cooldownGuard');
const iD = tgEngine.indexOf('for (const handler of plugins)');
assert.ok(iC > 0 && iD > 0, 'cooldownGuard atau loop plugin tidak ditemukan di telegramEngine.js');
assert.ok(iC < iD, 'cooldownGuard dipanggil SETELAH loop plugin di Telegram');
console.log('✅ cooldownGuard() dipanggil sebelum loop plugin di Telegram');

// ── 5. Pengecualian owner & dev (Opsi A) ────────────────────────────────────
console.log('\n=== 5. Pengecualian owner & dev (Opsi A: hanya kelompok ber-`pengecualian`) ===');
// engine/cooldown.js: pengecualian dibaca dari tabel config. Opsi A — owner/dev
// HANYA dibebaskan di kelompok yang mendefinisikan `pengecualian` (cuma 'umum').
assert.ok(/pengecualian[\s\S]{0,200}?isOwner\s*&&\s*ctx\.isOwner/.test(cdEngine),
  'pengecualian isOwner tidak ada');
assert.ok(/pengecualian[\s\S]{0,200}?isDev\s*&&\s*ctx\.isDev/.test(cdEngine),
  'pengecualian isDev tidak ada');
// Pengecualian TIDAK boleh lagi di-hardcode mengecualikan 'owner-destructive'
// (versi lama: `nama !== 'owner-destructive' && pengecualian`). Opsi A: perilaku
// murni dari tabel config, jadi kelompok tanpa `pengecualian` tetap kena.
assert.ok(/if\s*\(\s*pengecualian\s*\)/.test(cdEngine),
  'guard harus `if (pengecualian)` — perilaku dibaca dari tabel config (opsi A)');
assert.ok(!/nama\s*!==\s*'owner-destructive'/.test(cdEngine),
  'sisa pengecualian hardcode lama — opsi A tidak boleh mengecualikan per-nama kelompok');
console.log('✅ isOwner & isDev dibebaskan lewat tabel config (opsi A), tanpa hardcode nama kelompok');
// Konfigurasi: HANYA 'umum' yang punya `pengecualian`.
for (const [nama, cfg] of Object.entries(tabel.TABEL)) {
  const punya = !!cfg.pengecualian;
  assert.strictEqual(punya, nama === 'umum',
    `kelompok '${nama}' ${punya ? 'punya' : 'tidak punya'} pengecualian — opsi A: cuma 'umum'`);
}
console.log("✅ hanya kelompok 'umum' yang punya `pengecualian` (opsi A)");

// ── 6. Throttle balasan pelanggaran ──────────────────────────────────────────
console.log('\n=== 6. Pelanggaran: balas SEKALI per jendela ===');
// lastBalas Map ada & dicek SEBELUM balas
assert.ok(/lastBalas\s*=\s*new Map\(\)/.test(cdEngine), 'Map lastBalas tidak ditemukan');
assert.ok(/lastB\s*=\s*lastBalas\.get\(key\)/.test(cdEngine),
  'pengecekan lastBalas.get(key) tidak ada');
assert.ok(/if\s*\(\s*now\s*-\s*lastB\s*>=\s*ms\s*\)/.test(cdEngine),
  'pembatas "sekali per jendela" tidak ada — bisa spam balasan');
console.log('✅ lastBalas Map: balas sekali per jendela cooldown');

// ── 7. Kelompok 'umum' diam ─────────────────────────────────────────────────
console.log('\n=== 7. Kelompok "umum" diam (balasan:false) ===');
assert.strictEqual(tabel.TABEL['umum'].balasan, false,
  'kelompok "umum" harus balasan:false — spam user biasa tidak boleh dapat balasan');
assert.strictEqual(tabel.TABEL['umum'].ms, 500,
  'kelompok "umum" harus 500ms');
assert.strictEqual(tabel.TABEL['umum'].daftar, null,
  'kelompok "umum" harus catch-all (daftar:null) — semua command yang tak masuk kategori lain');
console.log('✅ "umum" = 500ms, diam, catch-all');

// ── 8. Tabel berisi command berisiko ─────────────────────────────────────────
console.log('\n=== 8. Tabel berat berisi downloader utama ===');
const HARUS = ['play','tiktok','tt','ig','fb','twitter','yt','ytdl','youtube'];
const berat = tabel.TABEL['berat'].daftar || [];
for (const cmd of HARUS) {
  assert.ok(berat.includes(cmd), `kelompok "berat" harus berisi "${cmd}"`);
}
console.log(`✅ ${HARUS.length} command downloader utama ada di "berat"`);

const HARUS_UPLOAD = ['tourl','tourl2'];
const upload = tabel.TABEL['upload'].daftar || [];
for (const cmd of HARUS_UPLOAD) {
  assert.ok(upload.includes(cmd), `kelompok "upload" harus berisi "${cmd}"`);
}
console.log(`✅ ${HARUS_UPLOAD.length} command upload ada di "upload"`);

const HARUS_JUDI = ['coinflip','cf','slot','gacha'];
const judi = tabel.TABEL['judi'].daftar || [];
for (const cmd of HARUS_JUDI) {
  assert.ok(judi.includes(cmd), `kelompok "judi" harus berisi "${cmd}"`);
}
console.log(`✅ ${HARUS_JUDI.length} command judi ada di "judi"`);

const HARUS_ADMIN = ['kick','kickall','promote','demote','add'];
const admin = tabel.TABEL['admin-grup'].daftar || [];
for (const cmd of HARUS_ADMIN) {
  assert.ok(admin.includes(cmd), `kelompok "admin-grup" harus berisi "${cmd}"`);
}
console.log(`✅ ${HARUS_ADMIN.length} command admin ada di "admin-grup"`);

// ── 9. Validasi download: jalur tanpa maxContentLength sudah di-cap ────────
console.log('\n=== 9. maxContentLength untuk downloader utama ===');
// HANYA jalur yang berisiko tanpa cap sebelumnya. Cek: axios.get dengan
// responseType:'arraybuffer' DAN tidak ada maxContentLength → gagal.
const lines = tools.split('\n');
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (/axios\.(get|post)\([^)]*arraybuffer|responseType:\s*['"]arraybuffer/.test(l)) {
    const block = lines.slice(i, Math.min(i+10, lines.length)).join('');
    if (/maxContentLength/.test(block)) continue;  // ada cap, aman
    if (/timeout/.test(block) && !/v\.play_url|tts_/.test(block)) continue; // jalur kecil, skip
    // Khusus untuk jalur berisiko (tts_download v.play_url) WAJIB ada cap
    if (/v\.play_url/.test(block)) {
      assert.fail(`04-tools.js: jalur v.play_url tanpa maxContentLength (sekitar baris ${i+1})`);
    }
  }
}
console.log('✅ jalur v.play_url (TikTok search) punya maxContentLength');

console.log('\nsemua ok — cooldown terpusat terkunci');
