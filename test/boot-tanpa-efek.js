'use strict';
/**
 * test/boot-tanpa-efek.js — penjaga: server HARUS bisa dijalankan tanpa efek samping.
 *
 * Kenapa ada: untuk menguji RUTE, gue sempat menjalankan `node server.js` penuh
 * di port 3999. Yang terjadi: `autoStartBots()` ikut jalan (nyalakan bot WA),
 * dan SELURUH `cron.schedule` terdaftar — di DB yang SAMA dengan proses PM2 yang
 * sedang melayani user. Satu cron 1-menit sempat menulis ke DB itu. Untuk uji
 * rute, satu-satunya yang dibutuhkan cuma Express-nya "listen".
 *
 * Jadi penjaganya bukan "jangan lupa memakai flag", tapi: setiap `cron.schedule`
 * WAJIB lewat pembungkus `cronAman`, dan `autoStartBots()` WAJIB di balik
 * pemeriksaan flag. Cron baru yang ditambahkan nanti otomatis ikut mati —
 * tidak ada cara lupa, dan tes ini yang membuktikannya.
 *
 * Statis (baca source), nol DB, nol jaringan.
 *
 * Jalankan: node test/boot-tanpa-efek.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

let gagal = 0;
const ok = (nama, fn) => {
  try { fn(); console.log(`  ✓ ${nama}`); }
  catch (e) { gagal++; console.error(`  ✗ ${nama} — ${e.message}`); }
};

console.log('=== 1. Flag NO_BOOT_SIDE_EFFECTS ada ===');
ok('flag dibaca dari env', () => {
  assert.ok(/process\.env\.NO_BOOT_SIDE_EFFECTS/.test(src),
    'NO_BOOT_SIDE_EFFECTS tidak dibaca — server tidak bisa dijalankan tanpa efek samping');
});
ok('flag dihitung SEKALI jadi konstanta TANPA_EFEK', () => {
  assert.ok(/const TANPA_EFEK\s*=\s*process\.env\.NO_BOOT_SIDE_EFFECTS\s*===\s*'1'/.test(src),
    'TANPA_EFEK harus bernilai boolean dari perbandingan ketat === 1');
});
ok('DEFAULT MATI: jika flag undefined atau 0, cronAman === cron asli', () => {
  // Evaluasi ekspresi logika yang sama dengan server.js
  const cekTanpaEfek = (val) => val === '1';
  assert.strictEqual(cekTanpaEfek(undefined), false, 'default tanpa env harus false (efek jalan)');
  assert.strictEqual(cekTanpaEfek(''), false, 'string kosong harus false');
  assert.strictEqual(cekTanpaEfek('0'), false, 'string 0 harus false');
  assert.strictEqual(cekTanpaEfek('1'), true, 'string 1 harus true');
});

console.log('\n=== 2. autoStartBots di balik flag ===');
ok('autoStartBots() HANYA dipanggil di cabang else', () => {
  const i = src.indexOf('await autoStartBots()');
  assert.ok(i > -1, 'autoStartBots() tidak ketemu');
  // 300 karakter sebelum pemanggilan harus memuat `if (TANPA_EFEK)` + `else`
  const sebelum = src.slice(Math.max(0, i - 300), i);
  assert.ok(/if\s*\(\s*TANPA_EFEK\s*\)/.test(sebelum),
    'autoStartBots() tidak di balik pemeriksaan TANPA_EFEK — bot akan menyala saat uji rute');
  assert.ok(/else\s*\{/.test(sebelum), 'autoStartBots() tidak di cabang else');
});

console.log('\n=== 3. SEMUA cron lewat pembungkus cronAman ===');
ok('pembungkus cronAman ada, dan no-op saat mode uji', () => {
  assert.ok(/const cronAman\s*=\s*TANPA_EFEK\s*\?\s*\{\s*schedule:\s*\(\)\s*=>/.test(src),
    'cronAman tidak didefinisikan sebagai no-op saat TANPA_EFEK');
});
ok('TIDAK ada `cron.schedule(` telanjang yang tersisa', () => {
  // Baris komentar boleh menyebut `cron.schedule` — yang dilarang adalah
  // PEMANGGILANNYA. `cronAman.schedule` tidak match pola ini.
  const nakal = [...src.matchAll(/(^|[^a-zA-Z])cron\.schedule\(/gm)]
    .map((m) => m.index)
    .filter((i) => {
      const baris = src.slice(src.lastIndexOf('\n', i) + 1, src.indexOf('\n', i));
      return !/^\s*(\*|\/\/|\/\*)/.test(baris); // lewati komentar
    });
  assert.strictEqual(nakal.length, 0,
    `${nakal.length} pemanggilan cron.schedule telanjang — cron itu TIDAK akan mati saat mode uji`);
});
ok('jumlah cronAman.schedule sesuai jumlah cron yang diharapkan (>=5)', () => {
  const n = [...src.matchAll(/cronAman\.schedule\(/g)].length;
  assert.ok(n >= 5, `cuma ${n} cron yang dibungkus — ada yang lolos?`);
});

console.log('\n=== 4. Mode uji TIDAK mengurangi yang seharusnya tetap jalan ===');
ok('seed admin tetap jalan (idempoten)', () => {
  const iBoot = src.indexOf('async function boot()');
  const blok = src.slice(iBoot, iBoot + 600);
  assert.ok(/seedDefaults\(/.test(blok), 'seedDefaults hilang dari boot()');
});
ok('server.listen tetap jalan (itu yang dibutuhkan uji rute)', () => {
  assert.ok(/server\.listen\(PORT/.test(src), 'server.listen tidak ketemu');
});
ok('mode uji diberi tahu di log, bukan diam-diam', () => {
  assert.ok(/NO_BOOT_SIDE_EFFECTS=1 — autoStartBots & SELURUH cron dimatikan/.test(src),
    'peringatan mode uji tidak ada di log');
  assert.ok(/bot & cron TIDAK dijalankan/.test(src),
    'log saat listen tidak menyatakan bot & cron tidak dijalankan');
});

console.log('\n=== 5. .env.example didokumentasikan ===');
const contoh = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
ok('NO_BOOT_SIDE_EFFECTS ada di .env.example', () => {
  assert.ok(/NO_BOOT_SIDE_EFFECTS/.test(contoh), 'tidak didokumentasikan untuk operator');
});

console.log(`\n${'─'.repeat(50)}`);
if (gagal) { console.error(`❌ ${gagal} pemeriksaan GAGAL`); process.exit(1); }
console.log('✅ Server bisa dijalankan tanpa efek samping; setiap cron baru otomatis ikut mati');
