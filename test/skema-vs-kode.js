'use strict';
/**
 * test/skema-vs-kode.js — kolom yang DITULIS kode harus ada di skema.
 *
 * Kenapa ada: `plugins/03-fun-rpg.js` menulis kolom `energi` & `last_energi`
 * (lewat pakaiEnergi/energiSekarang) sejak lama, tapi kolomnya tidak pernah
 * dibuat di schema.sql maupun scripts/sync-schema.js. Akibatnya `.mancing`,
 * `.kerja`, `.berburu`, `.tambang`, `.maling`, `.adventure`, `.koboy` MATI
 * TOTAL di produksi dengan error `Unknown column 'energi'` — dan tidak ada
 * yang tahu karena fitur-nya cuma diam.
 *
 * Tes ini menyapu nama kolom yang ditulis kode, lalu memastikan tiap kolom
 * itu ada di skema (schema.sql + tambahan scripts/sync-schema.js). Kalau ada
 * kolom yang ditulis tapi tidak ada di skema → GAGAL.
 *
 * Statis (baca source). Tanpa DB — supaya jalan di mana saja, termasuk CI.
 *
 * Jalankan: node test/skema-vs-kode.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const base = path.join(__dirname, '..');
const baca = (p) => fs.readFileSync(path.join(base, p), 'utf8');

// ── 1. Kumpulkan kolom yang dikenal, dari skema ──────────────────────────────
console.log('=== 1. Kolom rpg_members menurut skema ===');

const schemaSql = baca('schema.sql');
const syncSchema = baca('scripts/sync-schema.js');

/** Ambil daftar kolom dari blok CREATE TABLE <tabel> di schema.sql. */
function kolomDariSchema(tabel) {
  const re = new RegExp(
    `CREATE TABLE IF NOT EXISTS ${tabel}\\s*\\(([\\s\\S]*?)\\n\\)\\s*ENGINE`, 'i');
  const m = schemaSql.match(re);
  if (!m) return [];
  const kolom = [];
  for (const baris of m[1].split('\n')) {
    const s = baris.trim();
    if (!s || s.startsWith('--')) continue;
    // `nama_kolom  TIPE ...` — ambil token pertama, lewati baris constraint.
    if (/^(PRIMARY|FOREIGN|UNIQUE|INDEX|KEY|CONSTRAINT)\b/i.test(s)) continue;
    const nm = s.match(/^`?([a-zA-Z_][a-zA-Z0-9_]*)`?\s/);
    if (nm) kolom.push(nm[1]);
  }
  return kolom;
}

/** Ambil kolom tambahan dari scripts/sync-schema.js blok `tabel: [ ['nama', ...] ]`. */
function kolomDariSync(tabel) {
  const re = new RegExp(`${tabel}:\\s*\\[([\\s\\S]*?)\\n\\s*\\]`, 'm');
  const m = syncSchema.match(re);
  if (!m) return [];
  return [...m[1].matchAll(/\[\s*'([a-zA-Z_][a-zA-Z0-9_]*)'/g)].map((x) => x[1]);
}

const kolomSchema = kolomDariSchema('rpg_members');
const kolomSync   = kolomDariSync('rpg_members');
const KENAL = new Set([...kolomSchema, ...kolomSync]);

console.log(`  schema.sql   : ${kolomSchema.length} kolom`);
console.log(`  sync-schema  : ${kolomSync.length} kolom tambahan`);
console.log(`  total dikenal: ${KENAL.size}`);

// Kolom yang jadi biang bug — harus ada di KEDUA sumber (fresh install & migrasi).
for (const wajib of ['energi', 'last_energi']) {
  assert.ok(kolomSchema.includes(wajib),
    `schema.sql: kolom rpg_members.${wajib} hilang — instalasi baru akan mati seperti produksi`);
  assert.ok(kolomSync.includes(wajib),
    `sync-schema.js: kolom rpg_members.${wajib} hilang — DB lama tidak akan dimigrasi`);
}
console.log('✅ energi & last_energi ada di schema.sql DAN sync-schema.js');

// ── 2. Sapu kolom yang ditulis kode (updateMember) ───────────────────────────
console.log('\n=== 2. Kolom yang ditulis updateMember() harus ada di skema ===');

/** Buang komentar (garis // dan blok) supaya kata di komentar tak dianggap kolom. */
function tanpaKomentar(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // blok komentar
    .replace(/^\s*\/\/.*$/gm, '');       // komentar baris
}

const rpgPath = fs.existsSync('plugins/whatsapp/03-fun-rpg.js') ? 'plugins/whatsapp/03-fun-rpg.js' : 'plugins/03-fun-rpg.js';
const rpg = tanpaKomentar(baca(rpgPath));

/** Ambil teks argumen ke-3 updateMember(...) dengan kurung berimbang. */
function argumenUpdateMember(src) {
  const out = [];
  const pola = /updateMember\s*\(/g;
  let m;
  while ((m = pola.exec(src)) !== null) {
    let i = m.index + m[0].length;
    let depth = 1;
    let kutip = null;
    // Lewati sampai kurung penutup yang seimbang.
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (kutip) {
        if (c === '\\') i++;
        else if (c === kutip) kutip = null;
      } else if (c === "'" || c === '"' || c === '`') kutip = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    out.push(src.slice(m.index, i));
  }
  return out;
}

const ditulis = new Set();
for (const call of argumenUpdateMember(rpg)) {
  // Objek literal `{ kolom: nilai }` — ambil kunci sebelum titik dua.
  for (const mm of call.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g)) {
    ditulis.add(mm[1]);
  }
  // SQL mentah di dalamnya: `SET \`kolom\` = ?`
  for (const mm of call.matchAll(/SET\s+`([a-zA-Z_][a-zA-Z0-9_]*)`/g)) {
    ditulis.add(mm[1]);
  }
}

// Kunci yang jelas bukan kolom (objek opsi/teks), bukan target tes ini.
const BUKAN_KOLOM = new Set(['type', 'text', 'media', 'mimetype', 'caption', 'fileName',
  'mentions', 'quote', 'contextInfo', 'ptt', 'vcard', 'displayName', 'editKey', 'participant']);

const dicurigai = [...ditulis].filter((k) => !BUKAN_KOLOM.has(k) && !KENAL.has(k));
console.log(`  kolom ditulis: ${ditulis.size}`);
if (dicurigai.length) {
  console.log(`  TIDAK DIKENAL di skema: ${dicurigai.join(', ')}`);
}
assert.strictEqual(dicurigai.length, 0,
  `kolom ditulis kode tapi tidak ada di skema: ${dicurigai.join(', ')} — ` +
  'fitur yang menulisnya akan mati dengan "Unknown column"');
console.log('✅ semua kolom yang ditulis updateMember() ada di skema');

// ── 3. Sapu SQL mentah di handler (SET/INSERT) ───────────────────────────────
console.log('\n=== 3. SQL mentah (SET/INSERT) di handler ===');

const sqlKolom = new Set();
// UPDATE rpg_members SET a = ?, b = ?, ...
for (const mm of rpg.matchAll(/UPDATE\s+rpg_members[\s\S]{0,600}?SET\s+([\s\S]{0,400}?)WHERE/gi)) {
  for (const k of mm[1].matchAll(/`?([a-zA-Z_][a-zA-Z0-9_]*)`?\s*=/g)) sqlKolom.add(k[1]);
}
// INSERT INTO rpg_members (a, b, c)
for (const mm of rpg.matchAll(/INSERT\s+INTO\s+rpg_members\s*\(([^)]*)\)/gi)) {
  for (const k of mm[1].split(',')) sqlKolom.add(k.trim().replace(/`/g, ''));
}

const sqlCuriga = [...sqlKolom].filter((k) => k && !KENAL.has(k));
console.log(`  kolom di SQL mentah: ${sqlKolom.size}`);
if (sqlCuriga.length) console.log(`  TIDAK DIKENAL: ${sqlCuriga.join(', ')}`);
assert.strictEqual(sqlCuriga.length, 0,
  `SQL mentah menulis kolom yang tidak ada di skema: ${sqlCuriga.join(', ')}`);
console.log('✅ semua kolom di SQL mentah ada di skema');

// ── 4. Kolom energi memang dipakai (bukan cuma ada di skema) ────────────────
console.log('\n=== 4. Kolom energi dipakai kode ===');
assert.ok(/pakaiEnergi|klaimBerEnergi/.test(rpg),
  'kolom energi ada di skema tapi tidak dipakai kode — hapus kalau memang tidak perlu');
assert.ok(/'energi'/.test(rpg) || /energi/.test(rpg), 'kolom energi tidak dirujuk kode');
console.log('✅ kolom energi dirujuk kode (skema & kode sinkron)');

console.log('\nsemua ok — kolom kode & skema sinkron');
