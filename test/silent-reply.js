#!/usr/bin/env node
/**
 * test/silent-reply.js
 * Gate: engine TIDAK BOLEH membiarkan member tanpa balasan saat command.
 *
 * Akar keluhan "member kirim cmd ga di respon ... member pun pada out":
 *   - whatsappEngine.js: `if (!cmdHandled) console.log(...)` — cuma nulis log,
 *     member nggak dibales. 42x kejadian di SATU log (`.harga`, `.toimg`,
 *     `.getnumber`, `.blacklist`, `.unblacklist`, `.ceksewagc`, ...).
 *   - whatsappEngine.js: fitur di luar paket → `return;` telanjang.
 *   - plugins/04-tools.js `.tt`: timeout 20 dtk padahal komentarnya nulis 9 dtk,
 *     dan alasan manusiawi dari BE dibuang diganti kalimat generik.
 *
 * Jalankan: node test/silent-reply.js
 */
'use strict';
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
const wa   = fs.readFileSync(path.join(root, 'engine/whatsappEngine.js'), 'utf8');
const tt   = fs.readFileSync(path.join(root, 'plugins/04-tools.js'), 'utf8');

let gagal = 0;
const cek = (nama, ok, pesan) => {
  console.log(`${ok ? '✓' : '✗'} ${nama}`);
  if (!ok) { console.log(`    ${pesan}`); gagal++; }
};

// ── 1. Command nggak dikenal HARUS dibales ───────────────────────────────────
const blokUnknown = wa.slice(wa.indexOf("if (!cmdHandled) {"), wa.indexOf("if (!cmdHandled) {") + 700);
cek('command nggak dikenal dibales ke WA, bukan cuma log',
  /if \(!cmdHandled\) \{[\s\S]{0,600}?client\.message\.send\(/.test(blokUnknown),
  'blok `if (!cmdHandled)` harus manggil client.message.send()');

// ── 2. Fitur di luar paket HARUS dibales ─────────────────────────────────────
const iFitur = wa.indexOf('fitur di luar paket');
const blokFitur = wa.slice(iFitur, iFitur + 900);
cek('fitur di luar paket dibales alasannya',
  /client\.message\.send\(/.test(blokFitur),
  'tidak boleh `return;` telanjang tanpa ngasih tahu member');

// ── 3. Error plugin nggak boleh dikirim mentah ───────────────────────────────
const iErr = wa.indexOf('Error pas jalanin');
cek('error plugin dilewatkan rapikanError()',
  wa.slice(iErr, iErr + 400).includes('rapikanError('),
  '`e.message` mentah bisa bikin member nerima "Timeout"/"ECONNABORTED"/stack kode');
cek('engine/whatsappEngine.js impor rapikanError',
  /require\(['"]\.\/pesanError['"]\)/.test(wa),
  'butuh `const { rapikanError } = require(\'./pesanError\')`');

// ── 4. `.tt` nggak boleh nggantung ───────────────────────────────────────────
const iTt = tt.indexOf("case 'tt': {");
const blokTt = tt.slice(iTt, iTt + 1200);
const mTimeout = blokTt.match(/timeout:\s*(\d+)/);
cek('.tt timeout BE <= 10 dtk (dulu 20 dtk, terukur 14 dtk nunggu)',
  !!mTimeout && Number(mTimeout[1]) <= 10000,
  `timeout sekarang ${mTimeout ? mTimeout[1] : '?'} ms`);
cek('.tt pakai alasan manusiawi dari BE kalau media kosong',
  /new Error\(alasanBe/.test(tt),
  'pesan `data.message` dari BE dibuang → member cuma dapat kalimat generik');

// ── 5. Semua error di jalur '.tt' lewat rapikanError ─────────────────────────
const iCatchTt = tt.indexOf('Gagal download TikTok');
cek('catch `.tt` pakai rapikanError',
  tt.slice(iCatchTt, iCatchTt + 200).includes('rapikanError('),
  'catch `.tt` harus rapikanError(e)');

if (gagal) { console.log(`\n${gagal} cek GAGAL`); process.exit(1); }
console.log('\n✓ silent-reply: semua jalur "bot diem" ketutup');
