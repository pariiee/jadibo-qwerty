'use strict';
/**
 * test/guard-boot.js — kunci guard boot env wajib.
 *
 * Kenapa ada: server.js wajib exit(1) kalau JWT_SECRET / INTERNAL_KEY /
 * KING_PASSWORD / KING_USERNAME kosong. Yang terakhir dulu punya default
 * 'king123' dan 'admin' yang bocor ke publik — auto-scanner mencoba
 * admin/king123 dalam menit pertama VPS online. Guard mencegah hal itu.
 *
 * Yang diuji:
 *   1. server.js: ada guard untuk 4 env (JWT_SECRET, INTERNAL_KEY,
 *      KING_PASSWORD, KING_USERNAME).
 *   2. TIDAK ada fallback hardcode 'king123' atau 'admin' di source.
 *   3. TIDAK ada fallback `|| 'king'` / `|| 'admin'` di seedDefaults.
 *   4. .env.example: KING_USERNAME & KING_PASSWORD tidak berisi nilai
 *      default publik yang bisa langsung jalan.
 *
 * Statis (baca source + .env.example). Tanpa boot beneran — boot DB butuh
 * MySQL yang tidak selalu ada di mesin dev.
 *
 * Jalankan: node test/guard-boot.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const base = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(base, 'server.js'), 'utf8');
const envEx  = fs.readFileSync(path.join(base, '.env.example'), 'utf8');
const billing = fs.readFileSync(path.join(base, 'controllers/billingController.js'), 'utf8');

// ── 1. Guard untuk keempat env ────────────────────────────────────────────────
console.log('=== 1. Guard env wajib ===');
const ENV_WAJIB = [
  { var: 'JWT_SECRET',     label: 'JWT_SECRET' },
  { var: 'INTERNAL_KEY',    label: 'INTERNAL_KEY' },
  { var: 'KING_PASSWORD',   label: 'KING_PASSWORD' },
  { var: 'KING_USERNAME',   label: 'KING_USERNAME' },
];
for (const { var: v, label } of ENV_WAJIB) {
  // Pola: ada `if (!process.env.${v})` sebelum `process.exit(1)` di server.js.
  const ada = new RegExp(
    `if\\s*\\(!\\s*process\\.env\\.${v}\\b[\\s\\S]{0,200}?process\\.exit\\(1\\)`
  ).test(server);
  assert.ok(ada, `${label}: guard boot tidak ditemukan di server.js`);
}
console.log(`✅ ${ENV_WAJIB.length} guard boot ada`);

// ── 2. Tidak ada fallback publik 'king123' ────────────────────────────────────
console.log('\n=== 2. Tidak ada fallback hardcode "king123" / "admin" ===');
// "king123" — password publik terkenal
assert.ok(!server.includes("'king123'") && !server.includes('"king123"'),
  'server.js masih memuat "king123" — fallback publik harus dihapus');
// "admin" — username publik
assert.ok(!server.includes("|| 'admin'") && !server.includes('|| "admin"'),
  'server.js masih memuat "|| \'admin\'" — fallback publik harus dihapus');
// 'king' sebagai default username di source — cek pola yang lebih longgar
const fallbackKing = /KING_USERNAME\s*\?[^)]*['"]king['"]/;
assert.ok(!fallbackKing.test(server),
  'server.js masih punya fallback KING_USERNAME default "king"');
console.log('✅ tidak ada fallback publik "king123" / "admin" / "king"');

// ── 3. seedDefaults tidak punya default publik ──────────────────────────────
console.log('\n=== 3. seedDefaults: tidak ada default publik ===');
const seedFn = server.match(/seedDefaults\s*\(\s*process\.env\.KING_USERNAME\s*,\s*hashed\s*\)/);
assert.ok(seedFn,
  'server.js tidak memanggil seedDefaults(process.env.KING_USERNAME, hashed) — kedua env dipakai langsung');
console.log('✅ seedDefaults dipanggil dengan env langsung, tanpa fallback');

// ── 4. .env.example: placeholder, bukan nilai default publik ───────────────
console.log('\n=== 4. .env.example: placeholder, bukan default publik ===');
const lines = envEx.split('\n');
for (const ln of lines) {
  if (/^KING_USERNAME=/.test(ln)) {
    const val = ln.split('=', 2)[1].trim();
    assert.ok(!['admin', 'king'].includes(val.toLowerCase()),
      `.env.example: KING_USERNAME=${val} — masih default publik`);
    assert.ok(val.length >= 8,
      `.env.example: KING_USERNAME="${val}" — terlalu pendek untuk placeholder yang jelas`);
  }
  if (/^KING_PASSWORD=/.test(ln)) {
    const val = ln.split('=', 2)[1].trim();
    assert.ok(val !== 'ganti_password_ini' && !/king123/i.test(val),
      `.env.example: KING_PASSWORD="${val}" — placeholder terlalu mirip nilai asli`);
  }
}
console.log('✅ .env.example: KING_USERNAME & KING_PASSWORD placeholder jelas');

// ── 5. Bonus: guard ada SEBELUM import runtime ───────────────────────────────
console.log('\n=== 5. Guard ada SEBELUM require lain ===');
// Pola: guard KING_PASSWORD muncul sebelum require('./config/database') /
// boot(). Tanpa ini, kode jalan dulu lalu exit — efeknya sama, tapi guard
// harus di top-of-file biar jelas.
const guardIdx     = server.search(/KING_PASSWORD\s+kosong/);
const requireDbIdx = server.search(/require\(['"]\.\/config\/database['"]\)/);
assert.ok(guardIdx > 0 && requireDbIdx > 0, 'guard atau require DB tidak ketemu');
assert.ok(guardIdx < requireDbIdx,
  'guard KING_PASSWORD muncul SETELAH require DB — urutannya salah (lihat komentar)');
console.log('✅ guard boot muncul sebelum require config/database');

console.log('\nsemua ok — env wajib terkunci');
