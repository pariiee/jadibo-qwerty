'use strict';
/**
 * test/rute-dompet.js — penjaga RUTE, statis (baca source server.js).
 *
 * Kenapa ada: rute dompet itu jalur uang. Satu rute yang lupa `requireAuth`
 * = siapa pun bisa membuat tagihan atas nama orang lain; satu rute admin yang
 * lupa `requireKing` = user biasa bisa menambah saldonya sendiri; satu rute POST
 * yang lupa limiter = endpoint gratis untuk spam tagihan ke QRISku sampai akun
 * gateway-nya kena rate limit.
 *
 * Semua kesalahan itu TIDAK kelihatan dari tes unit mana pun — route-nya tetap
 * "ada" dan handler-nya tetap benar. Yang salah cuma lapisan di depannya. Jadi
 * yang diperiksa di sini memang teks pendaftaran rutenya.
 *
 * Yang dikunci:
 *   1. Tiap /api/wallet/* ada, dan SEMUANYA pakai requireAuth
 *   2. POST /api/wallet/* pakai limiter jalur uang (bukan apiLimiter saja)
 *   3. Tiap /api/admin/wallet/* pakai requireAuth + requireKing
 *   4. POST /api/admin/wallet/* juga pakai limiter
 *   5. Rute wallet TIDAK memakai `:id` telanjang (menghindari app.param('id')
 *      yang dipakai buat slug bot)
 *   6. csrf cekOrigin terpasang SEBELUM rute wallet, dan TIDAK setelah webhook
 *
 * Jalankan: node test/rute-dompet.js
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

/** Semua baris pendaftaran rute, dinormalkan jadi satu baris per rute. */
const rute = [...src.matchAll(/^app\.(get|post|put|patch|delete)\(\s*'([^']+)'([^;]*)\);/gims)]
  .map((m) => ({ method: m[1].toUpperCase(), jalur: m[2], rantai: m[3].replace(/\s+/g, ' ') }));

/** Cari rute by jalur persis. */
const cariRute = (jalur) => rute.filter((r) => r.jalur === jalur);

console.log('=== 1. Rute user /api/wallet/* ===');
console.log(`  (terdaftar: ${rute.filter((r) => r.jalur.startsWith('/api/wallet')).length} rute)`);
const USER_RUTE = [
  ['GET', '/api/wallet'],
  ['GET', '/api/wallet/ledger'],
  ['POST', '/api/wallet/topup'],
  ['POST', '/api/wallet/perpanjang'],
  ['POST', '/api/wallet/auto-renew'],
];

for (const [m, jalur] of USER_RUTE) {
  for (const r of cariRute(jalur)) {
    ok(`${m} ${jalur} (${r.method})`, () => {
      assert.strictEqual(r.method, m, `metodenya ${r.method}, harus ${m}`);
      assert.ok(/auth\.requireAuth/.test(r.rantai),
        'TIDAK ada auth.requireAuth — siapa pun bisa memanggil jalur uang ini');
    });
  }
}
for (const [m, jalur] of USER_RUTE) {
  ok(`${m} ${jalur} terdaftar`, () => {
    assert.ok(cariRute(jalur).length > 0, 'rute tidak ditemukan di server.js');
  });
}

console.log('\n=== 2. POST /api/wallet/* pakai limiter jalur uang ===');
for (const [m, jalur] of USER_RUTE.filter(([mm]) => mm === 'POST')) {
  ok(`POST ${jalur} punya limiter uang`, () => {
    const r = cariRute(jalur)[0];
    assert.ok(/\b(moneyLimiter|topupLimiter)\b/.test(r.rantai),
      `limiter-nya bukan jalur uang: ${r.rantai.slice(0, 90)}`);
    assert.ok(!/apiLimiter/.test(r.rantai),
      'POST uang tidak boleh cuma pakai apiLimiter (120/menit = jatah baca, bukan transaksi)');
  });
}
ok('topup pakai topupLimiter (lebih ketat — tiap panggilan bikin tagihan baru)', () => {
  const r = cariRute('/api/wallet/topup')[0];
  assert.ok(/topupLimiter/.test(r.rantai), r.rantai.slice(0, 90));
});

console.log('\n=== 3. Rute admin /api/admin/wallet/* ===');
const ADMIN_RUTE = [
  ['GET', '/api/admin/wallet/users'],
  ['GET', '/api/admin/wallet/users/:userId/ledger'],
  ['POST', '/api/admin/wallet/users/:userId/adjust'],
  ['GET', '/api/admin/wallet/konsistensi'],
  ['GET', '/api/admin/wallet/pendapatan'],
];
for (const [m, jalur] of ADMIN_RUTE) {
  ok(`${m} ${jalur} terdaftar`, () => {
    assert.ok(cariRute(jalur).length > 0, 'rute tidak ditemukan di server.js');
  });
  ok(`${m} ${jalur} wajib requireAuth + requireKing`, () => {
    const r = cariRute(jalur)[0];
    assert.strictEqual(r.method, m, `metodenya ${r.method}, harus ${m}`);
    assert.ok(/auth\.requireAuth/.test(r.rantai), 'tanpa requireAuth');
    assert.ok(/auth\.requireKing/.test(r.rantai),
      'TANPA requireKing — user biasa bisa mengubah saldonya sendiri');
  });
}
ok('POST adjust juga pakai limiter', () => {
  const r = cariRute('/api/admin/wallet/users/:userId/adjust')[0];
  assert.ok(/\b(moneyLimiter|topupLimiter)\b/.test(r.rantai), r.rantai.slice(0, 90));
});

console.log('\n=== 4. Tidak memakai `:id` telanjang ===');
ok('rute dompet pakai `:userId`, bukan `:id`', () => {
  const dompet = rute.filter((r) => r.jalur.includes('/wallet'));
  const nakal = dompet.filter((r) => /(^|\/):id(\/|$)/.test(r.jalur));
  assert.deepStrictEqual(nakal.map((r) => r.jalur), [],
    '`app.param(\'id\')` di server.js dipakai me-resolve slug bot; pakai :userId supaya tidak pernah tertukar');
});

console.log('\n=== 5. CSRF: dipasang di tempat yang benar ===');
ok('cekOrigin dipasang sebagai middleware app.use', () => {
  assert.ok(/app\.use\(cekOrigin\.cekOrigin\)/.test(src),
    'lapis kedua CSRF tidak terpasang sama sekali');
});
ok('cekOrigin dipasang SETELAH webhook (webhook tidak boleh diperiksa)', () => {
  const iWebhook = src.indexOf("'/api/payment/webhook'");
  const iCek = src.indexOf('app.use(cekOrigin.cekOrigin)');
  assert.ok(iWebhook > -1, 'rute webhook tidak ketemu');
  assert.ok(iCek > -1, 'cekOrigin tidak ketemu');
  assert.ok(iCek > iWebhook,
    'cekOrigin dipasang SEBELUM webhook — pembayaran sah akan ditolak karena webhook tidak punya Origin');
});
ok('cekOrigin dipasang SEBELUM rute dompet', () => {
  const iCek = src.indexOf('app.use(cekOrigin.cekOrigin)');
  const iWallet = src.indexOf("'/api/wallet/topup'");
  assert.ok(iWallet > iCek, 'rute dompet didaftarkan sebelum cekOrigin — tidak akan terlindungi');
});
ok('cekOrigin dipasang SETELAH cookieParser (butuh req.cookies)', () => {
  const iCookie = src.indexOf('app.use(cookieParser())');
  const iCek = src.indexOf('app.use(cekOrigin.cekOrigin)');
  assert.ok(iCek > iCookie, 'cekOrigin butuh req.cookies sudah terisi');
});

console.log('\n=== 6. Cron auto-perpanjang tiap jam ===');
ok('cron auto-perpanjang pakai jadwal tiap jam', () => {
  assert.ok(/cron\.schedule\('0 \* \* \* \*'/.test(src), "jadwal '0 * * * *' (tiap jam) tidak ditemukan");
});
ok('cron memanggil wallet.autoRenew', () => {
  assert.ok(/wallet\.autoRenew\(\)/.test(src), 'cron tidak memanggil wallet.autoRenew()');
});
ok('cron dibungkus try/catch (error tidak mematikan proses)', () => {
  const i = src.indexOf("cron.schedule('0 * * * *'");
  const blok = src.slice(i, i + 400);
  assert.ok(/try\s*\{/.test(blok) && /catch/.test(blok), 'tidak ada try/catch di sekitar autoRenew()');
});

console.log('\n=== 7. Halaman /saldo ===');
ok('halaman /saldo terdaftar', () => {
  assert.ok(/app\.get\('\/saldo'/.test(src), "rute halaman '/saldo' tidak ada");
});

console.log(`\n${'─'.repeat(50)}`);
if (gagal) { console.error(`❌ ${gagal} pemeriksaan GAGAL`); process.exit(1); }
console.log('✅ Rute dompet: guard, limiter, dan posisi CSRF benar');
