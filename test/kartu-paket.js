'use strict';
/**
 * test/kartu-paket.js
 * Isi kartu paket ditulis DUA kali (landing `/` + `/pricing`) dan isinya sempat
 * beda walau paketnya sama. Sekarang keduanya memanggil `daftarPaket()` di
 * public/js/act.js — file yang memang sudah dimuat dua halaman itu, jadi nggak
 * ada file baru yang perlu dijaga urutan muatannya.
 *
 * Yang diuji (fungsi murni, jalan di Node tanpa DOM):
 *   1. barisnya PERSIS format yang diminta Pak, urutannya juga
 *   2. angka besar pakai titik ribuan (10.000, bukan 10000)
 *   3. `max_fitur` TIDAK dipakai — itu angka pajangan
 *   4. dua halaman benar-benar memanggil fungsi ini (bukan nulis sendiri lagi)
 */
const fs = require('fs');
const path = require('path');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

// ── Muat act.js apa adanya (dia nempel ke `window`, jadi disediakan) ────────
const akar = path.join(__dirname, '..');
global.window = {};
global.document = { addEventListener() {} };
require(path.join(akar, 'public', 'js', 'act.js'));
const daftarPaket = global.window.daftarPaket;

cek('daftarPaket() ada di act.js', typeof daftarPaket === 'function');

// ── 1 & 2. Format + urutan ─────────────────────────────────────────────────
const basic = { id: 'basic', name: 'Basic', price: 25000, days: 30, owner_max: 1, receive_limit: 10000, max_fitur: 100 };
const k = daftarPaket(basic, 440);

cek('urutan baris persis seperti yang diminta', JSON.stringify(k.baris) === JSON.stringify([
  'Online 24 jam',
  '440 fitur',
  '1 Owner Bot',
  '10.000 Received Limit',
  'Masa aktif 30 hari',
]), JSON.stringify(k.baris));
cek('angka ribuan pakai titik', k.baris[3] === '10.000 Received Limit');
cek('"Customize Bot" tetap ada', k.extra === 'Customize Bot');

// ── 3. max_fitur tidak dipakai ─────────────────────────────────────────────
const pajangan = { ...basic, max_fitur: 99999 };
cek('max_fitur diabaikan (bukan angka pajangan)',
  JSON.stringify(daftarPaket(pajangan, 440).baris) === JSON.stringify(k.baris));
cek('tidak ada "slot bot" lagi di kartu',
  !k.baris.some((b) => /slot bot/i.test(b)));
cek('jumlah fitur datang dari argumen, bukan dari paket',
  daftarPaket(basic, 7).baris.includes('7 fitur'));

// ── 4. Dua halaman memanggil fungsi ini ────────────────────────────────────
const landing = fs.readFileSync(path.join(akar, 'public', 'js', 'index.js'), 'utf8');
const pricing = fs.readFileSync(path.join(akar, 'public', 'js', 'pricing.js'), 'utf8');
cek('landing `/` memakai daftarPaket()', /daftarPaket\(/.test(landing));
cek('`/pricing` memakai daftarPaket()', /daftarPaket\(/.test(pricing));
cek('landing tidak lagi menulis daftarnya sendiri',
  !/Jumlah Fitur|Owner Number :/.test(landing));
cek('`/pricing` tidak lagi menulis daftarnya sendiri',
  !/owner number'|pesan \/ hari/.test(pricing));
cek('daftarPaket dimuat sebelum index.js & pricing.js (act.js di head)',
  fs.readFileSync(path.join(akar, 'public', 'partials', 'head.html'), 'utf8')
    .includes('/js/act.js'));

console.log(gagal ? `\n=== GAGAL: ${gagal} masalah ===` : '\n=== SEMUA CEK LULUS ===');
process.exit(gagal ? 1 : 0);
