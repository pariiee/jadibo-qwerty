'use strict';
/**
 * test/skema-dompet.js — penjaga skema dompet, tanpa DB.
 *
 * Kenapa ada: `schema.sql` dan `scripts/sync-schema.js` dua-duanya mendefinisikan
 * bentuk tabel yang sama, dan mereka SEMPAT berbeda — kolom langganan ada di
 * sync-schema tapi hilang dari schema.sql, jadi instalasi baru mati dengan
 * ER_BAD_FIELD_ERROR padahal DB lama baik-baik saja. Beda itu tidak kelihatan
 * dari mana pun sampai ada yang bikin DB baru.
 *
 * Yang dikunci di sini:
 *   1. schema.sql memuat SEMUA kolom users yang dibaca kode (langganan + dompet).
 *   2. schema.sql memuat tabel wallet_ledger dengan `ref` UNIK (penjaga idempotensi).
 *   3. ENUM role di schema.sql memuat ADMIN_ROLE dari kode.
 *   4. sync-schema.js hanya MENAMBAH: tiap kolom dompet di sana juga ada di
 *      schema.sql, dan tidak ada definisi kolom lama yang diubah.
 *   5. `jumlah`/`saldo` SIGNED (bukan UNSIGNED) — UNSIGNED bikin saldo minus
 *      wrap-around jadi miliaran, bukan ditolak.
 *
 * Jalankan: node test/skema-dompet.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..');
const baca = (p) => fs.readFileSync(path.join(R, p), 'utf8');

const schema = baca('schema.sql');
const sync = baca('scripts/sync-schema.js');
const { ADMIN_ROLE } = require('../config/plan');

let gagal = 0;
const ok = (nama, fn) => {
  try { fn(); console.log(`  ✓ ${nama}`); }
  catch (e) { gagal++; console.error(`  ✗ ${nama} — ${e.message}`); }
};

console.log('=== 1. schema.sql: kolom users lengkap ===');

// Blok CREATE TABLE users dari schema.sql
const blokUsers = schema.match(/CREATE TABLE IF NOT EXISTS users\s*\(([\s\S]*?)\n\)\s*ENGINE/);
assert.ok(blokUsers, 'blok CREATE TABLE users tidak ketemu di schema.sql');
const kolomUsers = [...blokUsers[1].matchAll(/^\s{2}([a-z_]+)\s+[A-Z]/gim)].map((m) => m[1]);

// Kolom yang benar-benar dibaca kode. Sengaja daftar tangan, bukan hasil grep:
// grep ikut menangkap `u.saldo` di komentar dan query tulisan.
const WAJIB = [
  'id', 'username', 'password', 'role', 'token_version', 'phone', 'email',
  // langganan — SEMPAT hilang, ini yang dijaga
  'plan', 'plan_expired_at', 'plan_slots', 'trial_used_at',
  'extra_owners', 'extra_quota',
  // dompet
  'saldo', 'auto_renew', 'auto_renew_status', 'auto_renew_status_at',
  'is_active',
];
ok(`semua ${WAJIB.length} kolom ada di schema.sql`, () => {
  const hilang = WAJIB.filter((k) => !kolomUsers.includes(k));
  assert.deepStrictEqual(hilang, [], `hilang: ${hilang.join(', ')}`);
});

console.log('\n=== 2. schema.sql: tipe kolom dompet ===');
ok('saldo BIGINT SIGNED (bukan UNSIGNED)', () => {
  const baris = blokUsers[1].match(/^\s*saldo\s+(.+)$/m);
  assert.ok(baris, 'kolom saldo tidak ketemu');
  assert.ok(/BIGINT/.test(baris[1]), `harus BIGINT, dapat: ${baris[1]}`);
  assert.ok(!/UNSIGNED/i.test(baris[1]), `tidak boleh UNSIGNED (wrap-around minus): ${baris[1]}`);
  assert.ok(/NOT NULL/.test(baris[1]), `harus NOT NULL: ${baris[1]}`);
  assert.ok(/DEFAULT 0/.test(baris[1]), `harus DEFAULT 0: ${baris[1]}`);
});
ok('auto_renew default 0 (default MATI)', () => {
  const baris = blokUsers[1].match(/^\s*auto_renew\s+(.+)$/m);
  assert.ok(baris, 'kolom auto_renew tidak ketemu');
  assert.ok(/DEFAULT 0/.test(baris[1]), `harus DEFAULT 0: ${baris[1]}`);
});

console.log('\n=== 3. schema.sql: tabel wallet_ledger ===');
const blokLedger = schema.match(/CREATE TABLE IF NOT EXISTS wallet_ledger\s*\(([\s\S]*?)\n\)\s*ENGINE/);
ok('tabel wallet_ledger ada', () => assert.ok(blokLedger, 'tidak ketemu di schema.sql'));

if (blokLedger) {
  const l = blokLedger[1];
  const kol = [...l.matchAll(/^\s{2}([a-z_]+)\s+[A-Z]/gim)].map((m) => m[1]);
  ok('kolom ledger lengkap', () => {
    const wajib = ['id', 'user_id', 'tipe', 'jumlah', 'saldo_sesudah', 'ref', 'created_at'];
    const hilang = wajib.filter((k) => !kol.includes(k));
    assert.deepStrictEqual(hilang, [], `hilang: ${hilang.join(', ')}`);
  });
  ok('ref UNIK — penjaga idempotensi di level DB', () => {
    assert.ok(/UNIQUE KEY\s+\w+\s*\(\s*ref\s*\)/i.test(l), 'ref harus UNIQUE; tanpa ini webhook ganda bisa menambah saldo 2x');
  });
  ok('jumlah BIGINT SIGNED (negatif = potong saldo)', () => {
    const baris = l.match(/^\s*jumlah\s+(.+)$/m);
    assert.ok(baris && /BIGINT/.test(baris[1]), `harus BIGINT: ${baris && baris[1]}`);
    assert.ok(!/UNSIGNED/i.test(baris[1]), `tidak boleh UNSIGNED: ${baris[1]}`);
  });
  ok('tipe memuat 4 nilai yang dipakai kode', () => {
    const t = (l.match(/tipe\s+ENUM\(([^)]*)\)/i) || [])[1] || '';
    for (const v of ['topup', 'perpanjang', 'auto', 'adjust']) {
      assert.ok(t.includes(`'${v}'`), `tipe '${v}' tidak ada di ENUM: ${t}`);
    }
  });
  ok('tidak ada kolom yang bisa di-update (jurnal INSERT-only)', () => {
    // Nggak ada kolom `updated_at` / `deleted_at` — sengaja, biar tidak ada
    // yang tergoda mengoreksi baris jurnal.
    assert.ok(!/updated_at|deleted_at|is_deleted/i.test(l), 'jurnal tidak boleh punya jejak ubah/hapus');
  });
}

console.log('\n=== 4. ENUM role cocok dengan kode ===');
ok(`role memuat ADMIN_ROLE '${ADMIN_ROLE}'`, () => {
  const role = (blokUsers[1].match(/role\s+ENUM\(([^)]*)\)/i) || [])[1] || '';
  assert.ok(role.includes(`'${ADMIN_ROLE}'`),
    `schema.sql role = ENUM(${role}) tidak memuat '${ADMIN_ROLE}' — instalasi baru kehilangan admin`);
  assert.ok(role.includes("'user'"), 'role harus memuat user');
});

console.log('\n=== 5. sync-schema.js: hanya menambah, tidak mengubah ===');
ok('kolom dompet di sync-schema juga ada di schema.sql', () => {
  const blokSync = sync.match(/users:\s*\[([\s\S]*?)\n  \],/);
  assert.ok(blokSync, 'TABLES.users tidak ketemu di sync-schema.js');
  const kolomSync = [...blokSync[1].matchAll(/\['([a-z_]+)'/g)].map((m) => m[1]);
  const beda = kolomSync.filter((k) => !kolomUsers.includes(k));
  assert.deepStrictEqual(beda, [], `sync-schema punya kolom yang tidak ada di schema.sql: ${beda.join(', ')}`);
  for (const k of ['saldo', 'auto_renew', 'auto_renew_status', 'auto_renew_status_at']) {
    assert.ok(kolomSync.includes(k), `sync-schema.js belum menambah kolom ${k}`);
  }
});
ok('sync-schema tidak mengubah kolom yang sudah ada — tanpa syarat', () => {
  // Skrip ini MEMANG punya ALTER ... MODIFY/CHANGE/DROP, tapi semuanya di
  // bagian "perbaikan skema lama" dan dijalankan DI BALIK SYARAT (mis.
  // `rpg_members.limit` cuma digabung kalau kolom `lim` belum ada). Yang tidak
  // boleh ada: alur TAMBAH KOLOM yang mengubah/menghapus kolom yang sudah ada,
  // karena itu jalan tanpa syarat setiap kali skrip dijalankan.
  //
  // Bagian kolom dompet diperiksa terpisah di bawah: pastikan tidak ada
  // MODIFY/CHANGE/DROP yang menyebut saldo/auto_renew.
  const alurTambah = sync.slice(sync.indexOf('async function ensureColumn'), sync.indexOf('async function run'));
  const nakal = alurTambah.match(/\b(MODIFY|CHANGE|DROP)\b/gi);
  assert.strictEqual(nakal, null,
    `ensureColumn TIDAK boleh mengubah/menghapus kolom: ${nakal && nakal.join(', ')}`);

  // ALTER yang menyentuh kolom dompet: hanya ADD COLUMN. Diperiksa dari array
  // TABLES.users — tiap entri harus dipakai lewat ensureColumn (ADD COLUMN).
  for (const kol of ['saldo', 'auto_renew', 'auto_renew_status', 'auto_renew_status_at']) {
    const polaUbah = new RegExp(`(MODIFY|CHANGE|DROP)\\s+(COLUMN\\s+)?\`?${kol}\`?`, 'i');
    assert.ok(!polaUbah.test(sync),
      `sync-schema.js mengubah/menghapus kolom ${kol} — kolom dompet tidak boleh diubah setelah ada data`);
  }
});
ok('perbaikan skema lama tetap di balik syarat (idempoten)', () => {
  // ALTER paling berbahaya = rpg_members DROP COLUMN `limit`. Dia harus berada
  // di dalam blok `else if` yang mengecek keberadaan `lim`, bukan jalan polos.
  const iDrop = sync.indexOf('DROP COLUMN `limit`');
  assert.ok(iDrop > -1, 'DROP COLUMN `limit` tidak ketemu — kalau memang dihapus, tes ini perlu disesuaikan');
  const sebelum = sync.slice(Math.max(0, iDrop - 1400), iDrop);
  assert.ok(/else if \(names\.includes\('limit'\) && names\.includes\('lim'\)\)/.test(sebelum),
    'DROP COLUMN `limit` harus di balik cek keberadaan kedua kolom');
  assert.ok(/information_schema\.COLUMNS/.test(sebelum),
    'DROP COLUMN `limit` harus didahului query information_schema (cek kondisi, bukan jalan buta)');
});
ok('wallet_ledger dibuat lewat CREATE_TABLES (bukan TABLES)', () => {
  const iCreate = sync.indexOf('const CREATE_TABLES');
  const iLedger = sync.indexOf('CREATE TABLE IF NOT EXISTS wallet_ledger');
  assert.ok(iLedger > iCreate, 'wallet_ledger harus di dalam array CREATE_TABLES');
});
ok('sync-schema tidak menyentuh kolom role', () => {
  // Role produksi sudah benar (diperiksa read-only); skrip ini tidak boleh
  // mengubahnya — perbaikannya cuma di schema.sql, buat DB baru.
  const blokSync = sync.match(/users:\s*\[([\s\S]*?)\n  \],/);
  const kolomSync = [...blokSync[1].matchAll(/\['([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(!kolomSync.includes('role'), "sync-schema.js tidak boleh menyentuh users.role");
});

console.log(`\n${'─'.repeat(50)}`);
if (gagal) { console.error(`❌ ${gagal} pemeriksaan GAGAL`); process.exit(1); }
console.log('✅ Skema dompet konsisten (schema.sql ↔ sync-schema.js ↔ kode)');
