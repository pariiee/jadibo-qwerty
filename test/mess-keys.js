'use strict';
/**
 * test/mess-keys.js
 *
 * Kenapa ada: `config/mess.js` sempat ke-drop saat port zapo, jadi plugin yang
 * manggil `mess.roleLabel` / `mess.devOnly` meledak dengan
 * "Cannot read properties of undefined (reading 'undefined')" — `.menu`,
 * `.carifitur`, `.bot`, `.crm`, `.listuser`. Errornya nggak jelas, dan nggak
 * ada tes yang nangkap karena tes lama cuma ngecek method adapter ada.
 *
 * Tes ini nyisir semua plugin + engine, ambil tiap `mess.<key>` yang dipakai,
 * lalu pastikan key-nya beneran ada di config/mess.js.
 *
 * Jalankan: node test/mess-keys.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const AKAR = path.join(__dirname, '..');
const mess = require(path.join(AKAR, 'config', 'mess'));

const berkas = [];
for (const dir of ['plugins', 'engine', 'config']) {
  const p = path.join(AKAR, dir);
  if (!fs.existsSync(p)) continue;
  for (const f of fs.readdirSync(p)) {
    if (f.endsWith('.js')) berkas.push(path.join(p, f));
    const sub = path.join(p, f);
    if (fs.statSync(sub).isDirectory()) {
      for (const g of fs.readdirSync(sub)) if (g.endsWith('.js')) berkas.push(path.join(sub, g));
    }
  }
}

// `mess.js` di dalam string require(...) bukan pemakaian key — batasi ke kode,
// bukan string: tolak yang diawali `'`/`"`/`/` dan yang abis `mess.` langsung `js`.
const POLA = /(?<!['"`./])mess\.((?!js\b)[a-zA-Z_][a-zA-Z0-9_]*)/g;
const hilang = new Map();

for (const f of berkas) {
  const isi = fs.readFileSync(f, 'utf8');
  for (const m of isi.matchAll(POLA)) {
    if (!(m[1] in mess)) {
      const rel = path.relative(AKAR, f).replace(/\\/g, '/');
      if (!hilang.has(m[1])) hilang.set(m[1], []);
      hilang.get(m[1]).push(rel);
    }
  }
}

console.log(`── mess.<key>: ${Object.keys(mess).length} key di config/mess.js, ${berkas.length} berkas disisir ──`);

if (hilang.size) {
  console.error('\n❌ plugin manggil mess.<key> yang NGGAK ADA di config/mess.js:');
  for (const [k, files] of [...hilang].sort()) {
    console.error(`   mess.${k}  <- ${[...new Set(files)].join(', ')}`);
  }
  console.error('\nIni bakal meledak "Cannot read properties of undefined" saat command itu dipakai.');
  process.exit(1);
}

console.log('\n✅ tiap mess.<key> yang dipanggil plugin beneran ada');
