'use strict';
/**
 * test/load-semua.js
 *
 * Muat SEMUA modul lokal (config/, controllers/, engine/, plugins/) satu-satu.
 * Tujuannya nangkep `require` yang putus / salah nama ekspor SEBELUM deploy —
 * jenis kerusakan yang cuma kelihatan pas server dinyalain di VPS.
 *
 * Nggak nyambung DB dan nggak listen: modul yang butuh koneksi cuma bikin pool
 * (lazy), bukan connect. Yang gagal karena butuh env, dilaporkan terpisah.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'uji';
process.env.INTERNAL_KEY = process.env.INTERNAL_KEY || 'uji';

const fs = require('fs');
const path = require('path');

const AKAR = path.join(__dirname, '..');
const DIR = ['config', 'controllers', 'engine', 'plugins'];

let ok = 0, lewat = 0;
const gagal = [];

function sapu(dir, rel) {
  for (const nama of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, nama);
    const r = rel ? `${rel}/${nama}` : nama;
    if (fs.statSync(p).isDirectory()) {
      // engine/zapo = adapter zapo-js: butuh kredensial WA, diuji terpisah.
      if (r === 'engine/zapo') { lewat++; continue; }
      sapu(p, r);
      continue;
    }
    if (!nama.endsWith('.js')) continue;
    try {
      require(p);
      ok++;
    } catch (e) {
      gagal.push(`${r} → ${e.message}`);
    }
  }
}

for (const d of DIR) {
  const p = path.join(AKAR, d);
  if (fs.existsSync(p)) sapu(p, d);
}

console.log(`✅ ${ok} modul termuat`);
if (lewat) console.log(`⏭️  ${lewat} folder dilewati (engine/zapo)`);
if (gagal.length) {
  console.log(`\n❌ ${gagal.length} modul gagal dimuat:`);
  for (const g of gagal) console.log('   ' + g);
  process.exit(1);
}
console.log('\n=== SEMUA MODUL LOKAL TERMUAT ===');
