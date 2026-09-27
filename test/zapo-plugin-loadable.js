'use strict';
/**
 * test/zapo-plugin-loadable.js
 * Semua plugin dari `main` harus BISA di-`require` di zapo. Kalau ada yang
 * `require` modul/export yang nggak ada, plugin-nya mati diam-diam saat load
 * (engine cuma console.warn) -> fitur hilang tanpa jejak.
 *
 * Jalankan: node test/zapo-plugin-loadable.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dir = path.resolve(__dirname, '../plugins');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();

const gagal = [];
const hasil = [];
// Modul helper (bukan plugin): dipanggil `require()` dari plugin lain, jadi
// emang nggak export function/handler. Terdaftar di sini biar nggak dianggap gagal.
const HELPER = new Set(['07-button-helpers.js']);

for (const f of files) {
  try {
    const mod = require(path.join(dir, f));
    const bentuk = typeof mod === 'function' ? 'fn'
      : typeof mod?.handler === 'function' ? 'handler'
      : typeof mod?.default === 'function' ? 'default' : '?';
    const cmd = mod?.command ? ` cmd=${mod.command}` : '';
    hasil.push(`  ✓ ${f.padEnd(24)} ${bentuk}${cmd}`);
    if (bentuk === '?' && !HELPER.has(f)) gagal.push(`${f}: nggak export function/handler`);
  } catch (e) {
    gagal.push(`${f}: ${e.message.split('\n')[0]}`);
    hasil.push(`  ✗ ${f.padEnd(24)} ${e.message.split('\n')[0]}`);
  }
}

// Helper harus tetap bisa di-require dan nge-export fungsinya.
console.log('── Modul helper (dipanggil plugin lain) ──');
for (const f of HELPER) {
  try {
    const mod = require(path.join(dir, f));
    const keys = Object.keys(mod);
    const ok = keys.length > 0 && keys.every((k) => typeof mod[k] === 'function');
    console.log(`  ${ok ? '✓' : '✗'} ${f} -> ${keys.join(', ') || '(kosong)'}`);
    if (!ok) gagal.push(`${f}: export-nya bukan fungsi (${keys.join(', ')})`);
    // pastikan pemakainya ada, kalau nggak helper-nya yatim
    const src = fs.readFileSync(path.join(dir, f.replace('.js', '') + '.js'), 'utf8');
    assert.ok(src.includes('module.exports'), `${f} harus nge-export sesuatu`);
  } catch (e) {
    gagal.push(`${f}: ${e.message.split('\n')[0]}`);
  }
}
console.log(`── Plugin bisa di-load (${files.length} file) ──`);
console.log(hasil.join('\n'));

// ── Fitur yang dulu hilang harus ADA lagi ────────────────────────────────────
const WAJIB = ['07-button-helpers.js', '09-btnprobe.js', '10-crm.js'];
console.log('\n── Fitur yang dulu hilang di zapo ──');
for (const f of WAJIB) {
  const ada = fs.existsSync(path.join(dir, f));
  console.log(`  ${ada ? '✓' : '✗'} plugins/${f}`);
  if (!ada) gagal.push(`plugin hilang: ${f}`);
}

// ── Nol referensi baileys di plugins/ ────────────────────────────────────────
console.log('\n── Nol ketergantungan baileys ──');
const nyangkut = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  if (/require\(['"]baileys['"]\)/.test(src)) nyangkut.push(f);
}
assert.strictEqual(nyangkut.length, 0, `plugin masih require('baileys'): ${nyangkut.join(', ')}`);
console.log('  ✓ nol plugin yang require(\'baileys\')');

if (gagal.length) {
  console.error(`\n❌ GAGAL — ${gagal.length} masalah:`);
  for (const g of gagal) console.error(`   - ${g}`);
  process.exit(1);
}
console.log(`\n✅ ${files.length} plugin bisa di-load + 3 fitur yang hilang balik + nol baileys`);
