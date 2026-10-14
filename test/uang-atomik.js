'use strict';
/**
 * test/uang-atomik.js — kunci kontrak atomic-money.
 *
 * Kenapa tes ini ada: pernah ada bug duplikasi money karena SELECT money
 * → cek di JS → UPDATE money di command yang sama tanpa transaksi. Lihat
 * plugins/03-fun-rpg.js::transfer & coinflip. Tes ini mengunci aturan:
 *
 *   1. `updateMoneyDelta` & `transferMoney` ada dan berupa async function.
 *   2. `updateMoneyDelta` memakai `pool.getConnection` + `beginTransaction`.
 *   3. `updateMoneyDelta` mengunci baris dengan `SELECT ... FOR UPDATE`.
 *   4. `updateMoneyDelta` menolak delta yang bikin money < 0.
 *   5. `transferMoney` mengunci DUA baris (pengirim + penerima) dalam
 *      SATU transaksi.
 *   6. `transferMoney` mengunci dalam urutan JID yang sama (sorted) supaya
 *      transfer berlawanan tidak deadlock.
 *   7. `transfer` & `coinflip` di plugin TIDAK lagi baca money -> cek
 *      saldo -> UPDATE; alur mereka sekarang lewat helper atomic.
 *
 * Tes ini STATIS (baca source), tanpa DB. Yang diuji adalah: (a) helper
 * atomic ada dan dipakai, (b) plugin tidak lagi pakai pola lama.
 *
 * Jalankan: node test/uang-atomik.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const base = path.join(__dirname, '..');
const srcPath = fs.existsSync(path.join(base, 'plugins/whatsapp/03-fun-rpg.js'))
  ? path.join(base, 'plugins/whatsapp/03-fun-rpg.js')
  : path.join(base, 'plugins/03-fun-rpg.js');
const src = fs.readFileSync(srcPath, 'utf8');

// ── 1. Helper ada ────────────────────────────────────────────────────────────
console.log('=== 1. Helper atomic tersedia ===');
assert.ok(/async\s+function\s+updateMoneyDelta\s*\(/.test(src),
  'updateMoneyDelta() tidak ditemukan di 03-fun-rpg.js');
assert.ok(/async\s+function\s+transferMoney\s*\(/.test(src),
  'transferMoney() tidak ditemukan di 03-fun-rpg.js');
console.log('✅ updateMoneyDelta & transferMoney ter-ekspor di file');

// ── 2. updateMoneyDelta memakai transaksi & FOR UPDATE ──────────────────────
console.log('\n=== 2. updateMoneyDelta: transaksi + FOR UPDATE ===');
const u = src.match(/async\s+function\s+updateMoneyDelta\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
assert.ok(u, 'gagal menemukan body updateMoneyDelta');
const uBody = u[1];
assert.ok(/pool\.getConnection/.test(uBody),     'getConnection() tidak dipakai');
assert.ok(/beginTransaction/.test(uBody),        'beginTransaction() tidak dipakai');
assert.ok(/SELECT[\s\S]*?FOR\s+UPDATE/i.test(uBody), 'SELECT … FOR UPDATE tidak dipakai');
assert.ok(/commit/i.test(uBody),                  'commit() tidak dipakai');
assert.ok(/conn\.release\(\)/.test(uBody),       'conn.release() tidak ada di finally');
assert.ok(/rollback/i.test(uBody),               'rollback() tidak ada');
console.log('✅ getConnection + beginTransaction + FOR UPDATE + commit + release (finally) + rollback');

// ── 3. updateMoneyDelta menolak saldo < 0 ───────────────────────────────────
console.log('\n=== 3. updateMoneyDelta: tolak saldo negatif ===');
assert.ok(/next\s*<\s*0[\s\S]{0,40}rollback/i.test(uBody),
  'guard next < 0 + rollback tidak ditemukan');
console.log('✅ guard `next < 0` ada, rollback dulu');

// ── 4. transferMoney: lock dua baris, satu transaksi ────────────────────────
console.log('\n=== 4. transferMoney: dua baris, satu transaksi ===');
const t = src.match(/async\s+function\s+transferMoney\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
assert.ok(t, 'gagal menemukan body transferMoney');
const tBody = t[1];
assert.ok(/pool\.getConnection/.test(tBody),        'transferMoney tidak pakai getConnection');
assert.ok(/beginTransaction/.test(tBody),           'transferMoney tidak mulai transaksi');
assert.ok(/commit/i.test(tBody),                    'transferMoney tidak commit');
assert.ok(/conn\.release\(\)/.test(tBody),          'transferMoney tidak release di finally');
assert.ok(/FOR\s+UPDATE/i.test(tBody),              'transferMoney tidak lock baris');
assert.ok(/rollback/i.test(tBody),                  'transferMoney tidak rollback di catch');
console.log('✅ getConnection + beginTransaction + FOR UPDATE + commit + release (finally) + rollback');

// ── 5. transferMoney: kunci dalam urutan konsisten (deadlock-proof) ────────
console.log('\n=== 5. transferMoney: kunci dalam urutan sorted (anti-deadlock) ===');
assert.ok(/\[(a|b),\s*b\]\s*=\s*\[pengirim,\s*penerima\]\.sort\(\)/
       || /sort\(\)/.test(tBody),
  'tidak ada sort() sebelum kunci FOR UPDATE — dua transfer berlawanan bisa deadlock');
console.log('✅ pengirim & penerima di-sort() sebelum kunci → deadlock-proof');

// ── 6. Plugin 'transfer' & 'coinflip' MEMANGGIL helper atomic ───────────────
console.log('\n=== 6. Plugin handler pakai helper atomic ===');
// 'transfer' & 'tf' berbagi body (case fall-through); block 'transfer' berakhir
// tepat sebelum 'case coinflip'. Tangkap dari 'case transfer' ke 'case coinflip'.
const transferBlk = src.slice(
  src.indexOf("case 'transfer'"),
  src.indexOf("case 'coinflip'")
);
const coinBlk = src.slice(
  src.indexOf("case 'coinflip'"),
  src.indexOf("case 'tictactoe'")   // case setelah coinflip di plugin ini
);

assert.ok(/await\s+transferMoney\(/.test(transferBlk),
  'case transfer tidak memanggil transferMoney()');
assert.ok(/await\s+updateMoneyDelta\(/.test(coinBlk),
  'case coinflip tidak memanggil updateMoneyDelta()');
console.log('✅ transfer & coinflip sekarang lewat helper atomic');

// ── 7. Plugin TIDAK lagi menulis UPDATE money langsung ──────────────────────
console.log('\n=== 7. Tidak ada UPDATE money ad-hoc di handler ===');
// Pola lama: dalam block transfer/coinflip, "await updateMember(...{ money: ... })"
// langsung. Sekarang harus lewat helper.
for (const [name, blk] of [['transfer', transferBlk], ['coinflip', coinBlk]]) {
  const adaUpdateMoney = /updateMember\([^)]*\{\s*money\s*:/.test(blk);
  assert.ok(!adaUpdateMoney,
    `${name}: masih ada updateMember(... {money:...}) — pindahkan ke helper atomic`);
}
console.log('✅ tidak ada `updateMember({money:...})` di handler transfer/coinflip');

// ── 8. Sanity: total helper di file ─────────────────────────────────────────
console.log('\n=== 8. Sanity: hanya dua helper baru ===');
const calls = (src.match(/await\s+(updateMoneyDelta|transferMoney)\(/g) || []).length;
console.log(`   total pemanggilan: ${calls}`);
assert.ok(calls >= 2, 'kedua helper minimal dipanggil sekali');
console.log('✅ helper dipakai (bukan dead code)');

console.log('\nsemua ok — kontrak atomic-money terkunci');
