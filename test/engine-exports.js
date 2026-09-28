'use strict';
/**
 * test/engine-exports.js — guard: tiap simbol yang di-destructure plugin dari
 * modul engine/config WAJIB beneran diekspor.
 *
 * Kenapa ada: waktu port Baileys→zapo, beberapa modul kekurangan blok yang
 * dipakai plugin (`config/mess.js` kehilangan roleLabel, `config/globalSettings.js`
 * kehilangan getMuteGrup, `engine/thumbnail.js` kehilangan param size + jpegkan).
 * Semuanya meledak sebagai `Cannot read properties of undefined` / TypeError saat
 * command dipakai — ketahuan dari user, bukan dari CI. Tes ini nutup lubang itu:
 * `require()` tetap sukses walau isinya kurang, jadi harus dicek satu-satu.
 *
 * Cara kerja: ambil semua `const { a, b } = require('...')` di plugins/ + engine/,
 * resolve path-nya, lalu bandingkan dengan kunci yang beneran diekspor modul itu.
 */
const fs = require('fs');
const path = require('path');

const AKAR = path.join(__dirname, '..');
const DIR = ['plugins', 'engine', 'config'];

// `require('zapo-js')` dll = paket npm (bukan berkas repo) → skip.
const LEWAT = /^[a-z@][a-z0-9@/._-]*$/i;

function berkasResmi() {
  const out = [];
  for (const d of DIR) {
    const p = path.join(AKAR, d);
    if (!fs.existsSync(p)) continue;
    for (const f of fs.readdirSync(p)) {
      if (f.endsWith('.js')) out.push(path.join(d, f));
    }
  }
  return out;
}

// const { a, b } = require('../engine/thumbnail');
const POLA = /const\s*\{([^}]+)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;

const hilang = new Map(); // "modul -> simbol" → [berkas pemakai]

function catat(modul, simbol, berkas) {
  const k = `${modul} -> ${simbol}`;
  if (!hilang.has(k)) hilang.set(k, []);
  hilang.get(k).push(berkas);
}

let berkasDisisir = 0;

for (const rel of berkasResmi()) {
  const isi = fs.readFileSync(path.join(AKAR, rel), 'utf8');
  berkasDisisir++;
  POLA.lastIndex = 0;
  let m;
  while ((m = POLA.exec(isi))) {
    const [, isiKurung, spec] = m;
    if (LEWAT.test(spec)) continue; // paket npm
    let abs;
    try { abs = require.resolve(path.join(AKAR, path.dirname(rel), spec)); }
    catch { catat(spec, '(modulnya sendiri tidak bisa di-require)', rel); continue; }

    // Hanya periksa modul di dalam repo (bukan node_modules).
    if (abs.includes('node_modules')) continue;

    let ekspor;
    // `require` punya cache: sekali modul dimuat, isi lamanya nempel sampai proses
    // mati. Tanpa `delete require.cache`, tes ini buta terhadap modul yang sudah
    // di-require lebih dulu (mis. lewat berkas lain) → tes negatifnya nggak nangkep.
    const kunciCache = require.resolve(abs);
    delete require.cache[kunciCache];
    try { ekspor = require(abs); }
    catch (e) { catat(spec, `(require gagal: ${e.message})`, rel); continue; }
    if (!ekspor || typeof ekspor !== 'object') continue;

    const punya = new Set(Object.keys(ekspor));
    for (const s of isiKurung.split(',')) {
      // `const { kiri: kanan } = obj` → yang diekspor = KIRI (`kiri`), `kanan` cuma
      // alias lokal. Jadi ambil potongan pertama, bukan terakhir.
      const nama = s.split(':')[0].trim();
      if (!nama) continue;
      if (!punya.has(nama)) catat(path.relative(AKAR, abs), nama, rel);
    }
  }
}

console.log(`── ekspor modul: ${berkasDisisir} berkas disisir, ${hilang.size} masalah ──`);
if (hilang.size) {
  console.log('');
  for (const [k, pemakai] of hilang) {
    console.log(`❌ ${k}`);
    for (const p of pemakai) console.log(`     dipakai: ${p}`);
  }
  console.log(`\n❌ ${hilang.size} simbol di-destructure tapi modulnya nggak ngekspor.`);
  process.exit(1);
}
console.log('\n✅ tiap simbol yang di-destructure plugin benar-benar diekspor modulnya');
