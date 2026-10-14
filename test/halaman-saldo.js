'use strict';
/**
 * test/halaman-saldo.js — penjaga halaman /saldo + tab Saldo admin.
 *
 * Kenapa statis: halaman ini jalur uang, dan kesalahan yang paling mahal di sini
 * bukan "salah warna" tapi:
 *   - harga/nominal dihitung di UI (dua sumber angka -> bisa beda dari server)
 *   - riwayat dibaca dari orders (perpanjang dari saldo HILANG dari riwayat)
 *   - tombol perpanjang tanpa idempotency (dobel-klik = bayar dua kali)
 *   - admin bisa mengubah saldo tanpa alasan (uang muncul tanpa penjelasan)
 *
 * Semua itu tidak kelihatan dari tes unit server. Yang diperiksa di sini adalah
 * ISI berkasnya — jadi halaman baru yang lupa hal-hal ini langsung merah.
 *
 * Jalankan: node test/halaman-saldo.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..');
const baca = (p) => fs.readFileSync(path.join(R, p), 'utf8');

const html = baca('public/saldo.html');
const js = baca('public/js/saldo.js');
const server = baca('server.js');
const sidebar = baca('public/partials/sidebar.html');
const adminHtml = baca('public/admin.html');
const adminJs = baca('public/js/admin.js');

let gagal = 0;
const ok = (nama, fn) => {
  try { fn(); console.log(`  ✓ ${nama}`); }
  catch (e) { gagal++; console.error(`  ✗ ${nama} — ${e.message}`); }
};

console.log('=== 1. Halaman terdaftar & bisa dibuka ===');
ok('/saldo terdaftar di server.js', () => {
  assert.ok(/app\.get\('\/saldo'\s*,\s*halaman\('saldo\.html'\)\)/.test(server),
    "rute halaman '/saldo' tidak memakai halaman('saldo.html')");
});
ok('public/saldo.html ada', () => assert.ok(html.length > 500, 'berkas kosong'));
ok('include partial wajib ada (head/sidebar/topbar)', () => {
  for (const p of ['head.html', 'sidebar.html', 'topbar.html']) {
    assert.ok(html.includes(`@include ${p}`), `@include ${p} hilang — halaman akan rusak`);
  }
});
ok('memuat saldo.js', () => assert.ok(/src="\/js\/saldo\.js"/.test(html), 'saldo.js tidak dimuat'));
ok('link Saldo ada di sidebar', () => {
  assert.ok(/href="\/saldo"/.test(sidebar), 'sidebar tidak punya tautan /saldo — halamannya tidak bisa ditemukan');
});

console.log('\n=== 2. Yang ditampilkan sesuai permintaan ===');
ok('menampilkan saldo', () => assert.ok(/saldo-angka/.test(html) && /saldo_text/.test(js)));
ok('tombol top up dengan PILIHAN nominal dari server', () => {
  assert.ok(/pilihan-cepat/.test(html), 'blok pilihan cepat tidak ada di HTML');
  assert.ok(/batas\.cepat/.test(js), 'pilihan cepat tidak diambil dari respons server');
});
ok('riwayat dibaca dari wallet_ledger, BUKAN orders', () => {
  assert.ok(/\/api\/wallet\/ledger/.test(js), 'tidak memanggil /api/wallet/ledger');
  assert.ok(!/\/api\/billing\/orders/.test(js.replace(/cekTopup[\s\S]{0,400}/g, '') || ''),
    'memakai daftar order sebagai riwayat saldo — perpanjang dari saldo akan hilang');
  assert.ok(/wallet_ledger|wallet\/ledger/.test(js), 'sumber riwayat tidak jelas');
});
ok('toggle auto-perpanjang ada', () => {
  assert.ok(/id="auto-renew"/.test(html), 'checkbox auto-renew tidak ada');
  assert.ok(/\/api\/wallet\/auto-renew/.test(js), 'tidak memanggil endpoint toggle');
});
ok('tombol perpanjang per paket ada', () => {
  assert.ok(/perpanjang\(/.test(js), 'tidak ada tombol perpanjang');
  assert.ok(/\/api\/wallet\/perpanjang/.test(js), 'tidak memanggil endpoint perpanjang');
});
ok('banner status auto-perpanjang (saldo_kurang) ada', () => {
  assert.ok(/banner-auto/.test(html), 'blok banner tidak ada');
  assert.ok(/auto_renew_status === 'saldo_kurang'/.test(js), 'banner tidak membaca status saldo_kurang');
});
ok('memakai gaya halaman yang sudah ada (card/tbl/btn/m-sub)', () => {
  for (const kls of ['card', 'tbl', 'btn', 'm-sub']) {
    assert.ok(new RegExp(`class="[^"]*\\b${kls}\\b`).test(html), `kelas standar '${kls}' tidak dipakai`);
  }
});

console.log('\n=== 3. Keamanan & idempotensi di UI ===');
ok('semua fetch pakai credentials: include', () => {
  assert.ok(/credentials:\s*'include'/.test(js), 'cookie auth tidak dikirim');
});
ok('perpanjang mengirim idempotency_key', () => {
  assert.ok(/idempotency_key/.test(js), 'tanpa kunci, dobel-klik bisa memotong saldo dua kali');
});
ok('kunci dibuat per klik (crypto.randomUUID)', () => {
  assert.ok(/crypto\.randomUUID/.test(js), 'kunci tidak unik per klik');
});
ok('tombol dinonaktifkan selama request', () => {
  assert.ok(/sedangKirim/.test(js), 'tidak ada penjaga anti dobel-klik di UI');
  assert.ok(/\.disabled\s*=\s*true/.test(js), 'tombol tidak dinonaktifkan');
});
ok('nominal dikirim apa adanya — TIDAK dihitung ulang di UI', () => {
  // Yang dilarang: UI mengalikan/menambah sendiri nominal atau harga.
  assert.ok(!/price\s*\*\s*|nominal\s*\*\s*|harga\s*\*\s*/.test(js),
    'UI menghitung nominal/harga sendiri — bisa beda dari server');
});
ok('harga paket diambil dari respons server', () => {
  assert.ok(/p\.price_text|p\.price/.test(js), 'harga tidak diambil dari server');
});

console.log('\n=== 4. Tab Saldo admin ===');
ok('tab Saldo terdaftar di admin.html', () => {
  assert.ok(/data-act="tab\('saldo'\)"/.test(adminHtml), 'tombol tab tidak ada');
  assert.ok(/id="pane-saldo"/.test(adminHtml), 'pane saldo tidak ada');
});
ok('pane saldo masuk daftar navigasi admin.js', () => {
  assert.ok(/'user', 'bot', 'order', 'harga', 'saldo', 'sistem'/.test(adminJs),
    'pane lain akan tetap tampil saat tab saldo dibuka');
  assert.ok(/if \(nama === 'saldo'\) muatSaldo\(\)/.test(adminJs), 'tab saldo tidak memuat datanya');
});
ok('menampilkan rincian pendapatan top up vs paket langsung', () => {
  assert.ok(/\/api\/admin\/wallet\/pendapatan/.test(adminJs), 'tidak memanggil endpoint pendapatan');
  assert.ok(/top up saldo/i.test(adminJs) && /paket langsung/i.test(adminJs),
    'rincian top up vs paket langsung tidak ditampilkan');
});
ok('menampilkan saldo beredar', () => {
  assert.ok(/saldo_beredar/.test(adminJs), 'saldo beredar tidak ditampilkan');
  assert.ok(/kewajiban platform, bukan pendapatan/i.test(adminJs),
    'tanpa penjelasan, saldo beredar mudah disalahartikan sebagai pendapatan');
});
ok('menampilkan pemeriksaan konsistensi jurnal', () => {
  assert.ok(/\/api\/admin\/wallet\/konsistensi/.test(adminJs), 'tidak memanggil endpoint konsistensi');
  assert.ok(/menyimpang/.test(adminJs), 'daftar yang menyimpang tidak ditampilkan');
});
ok('penyesuaian saldo WAJIB beralasan (UI)', () => {
  assert.ok(/Alasan <b>\(wajib\)<\/b>/.test(adminHtml), 'label alasan wajib tidak ada');
  assert.ok(/if \(!alasan\)/.test(adminJs), 'UI tidak menahan penyesuaian tanpa alasan');
});
ok('penyesuaian memakai konfirmasi sebelum kirim', () => {
  assert.ok(/confirm\(/.test(adminJs), 'tidak ada konfirmasi — salah ketik langsung mengubah uang');
});
ok('admin hanya bisa lihat & sesuaikan — tidak ada tarik/transfer', () => {
  assert.ok(!/\/tarik|\/withdraw|\/transfer/i.test(adminJs + adminHtml + js + html),
    'ada fitur tarik/transfer, padahal ruang lingkupnya cuma topup/perpanjang');
});

console.log(`\n${'─'.repeat(50)}`);
if (gagal) { console.error(`❌ ${gagal} pemeriksaan GAGAL`); process.exit(1); }
console.log('✅ Halaman /saldo & tab admin: sumber angka dari server, riwayat dari jurnal, tanpa tarik/transfer');
