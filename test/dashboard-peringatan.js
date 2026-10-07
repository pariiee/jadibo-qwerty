'use strict';
/**
 * test/dashboard-peringatan.js
 *
 * Banner kuota di /dashboard adalah kanal SATU-SATUNYA yang tidak bergantung
 * pada bot user: peringatan WhatsApp dikirim lewat bot milik user sendiri
 * (engine/notify.js), jadi tepat saat kuota habis — bot diam — kabarnya ikut
 * hilang. Kalau banner ini salah hitung, user tetap tidak tahu apa-apa, dan
 * kesalahannya SENYAP (tidak ada error, cuma banner yang tidak muncul).
 *
 * Logikanya diuji dengan MENJALANKAN SUMBER ASLINYA dari public/js/dashboard.js
 * (bukan cocok-cocokan teks): fungsinya diambil utuh, lalu dijalankan dengan
 * `bots`/`me`/`document` tiruan. Kalau ambangnya diubah di berkasnya, tes ini
 * ikut berubah — persis yang diinginkan.
 */

const fs = require('fs');
const path = require('path');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'dashboard.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');

/**
 * Ambil satu deklarasi fungsi utuh dari sumber (dengan mencocokkan kurung
 * kurawal). Dipakai supaya tes menjalankan KODE ASLINYA, bukan salinannya.
 */
function ambilFungsi(teks, nama) {
  const awal = teks.indexOf(`function ${nama}(`);
  if (awal < 0) return null;
  let i = teks.indexOf('{', awal);
  let dalam = 0;
  for (let j = i; j < teks.length; j++) {
    if (teks[j] === '{') dalam++;
    else if (teks[j] === '}') { dalam--; if (dalam === 0) return teks.slice(awal, j + 1); }
  }
  return null;
}

const sumberPeringatan = ambilFungsi(src, 'renderPeringatan');
// `esc` di dashboard.js didefinisikan sebagai `const esc = (s) => ...`, bukan
// `function esc()`. Jadi harus diambil sebagai EKSPRESI — dan disuntikkan
// sebagai argumen `new Function`, karena `new Function` hanya melihat scope
// global (variabel di berkas ini tidak kelihatan dari dalamnya).
const sumberEsc = (() => {
  const i = src.indexOf('function esc(');
  if (i >= 0) return ambilFungsi(src, 'esc');
  const m = /const esc\s*=\s*(\([^)]*\)\s*=>[\s\S]*?);\n/.exec(src);
  return m ? m[1] : null;
})();

console.log('=== 0. Fungsi aslinya berhasil diambil ===');
// Kalau pengambilan gagal, tes di bawah akan "lulus" tanpa menguji apa pun.
cek('renderPeringatan ketemu & utuh', !!sumberPeringatan && sumberPeringatan.includes('kuota-alert'),
  String(sumberPeringatan).slice(0, 60));
cek('esc ketemu', !!sumberEsc, String(sumberEsc).slice(0, 60));

/** Jalankan renderPeringatan dengan data tiruan; balikin hasil render-nya. */
function jalankan(bots, me) {
  const el = { style: {}, className: '', innerHTML: '' };
  const document = { getElementById: (id) => (id === 'kuota-alert' ? el : null) };
  // eslint-disable-next-line no-new-func
  const fn = new Function('bots', 'me', 'document', 'esc', 'el',
    `${sumberPeringatan}\nrenderPeringatan();\nreturn { html: el.innerHTML, display: el.style.display, className: el.className };`);
  return fn(bots, me, document, (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), el);
}

const PAKET_OK = { plan_aktif: true, plan_expired_at: null, trial_used: true };
const botKu = (pakai, batas, nama = 'QWERTY') =>
  ({ id: 4, bot_name: nama, received_count: pakai, receive_limit: batas });

console.log('\n=== 1. Kuota aman: banner TIDAK muncul ===');
let h = jalankan([botKu(10, 100)], PAKET_OK);
cek('tidak ada isi', h.html === '', h.html.slice(0, 80));
cek('disembunyikan', h.display === 'none', String(h.display));

console.log('\n=== 2. Ambang 80% ===');
h = jalankan([botKu(79, 100)], PAKET_OK);
cek('79% -> diam (belum mengganggu)', h.html === '');
h = jalankan([botKu(80, 100)], PAKET_OK);
cek('80% -> muncul', h.html.includes('QWERTY'), h.html.slice(0, 80));
cek('80% -> menyebut sisa 20', h.html.includes('20'), h.html.slice(0, 200));
cek('80% -> peringatan (icon), bukan kritis', (h.html.includes('path') || h.html.includes('⚠️')) && !h.html.includes('circle cx="12"'));
cek('80% -> tidak ditandai kritis di kelasnya', !h.className.includes('kritis'), h.className);

console.log('\n=== 3. Kuota HABIS = kritis ===');
h = jalankan([botKu(100, 100)], PAKET_OK);
cek('menyebut "habis"', /habis/i.test(h.html), h.html.slice(0, 200));
cek('pakai ikon kritis svg/⛔', h.html.includes('circle cx="12"') || h.html.includes('⛔'));
cek('elemen dapat kelas kritis', h.className.includes('kritis'), h.className);

console.log('\n=== 4. Tanpa batas (receive_limit 0) JANGAN dihitung ===');
// 0 = tanpa batas (lihat batasKuota()). Kalau dianggap batas, 0/0 jadi NaN dan
// setiap bot tanpa batas akan memunculkan banner palsu.
h = jalankan([botKu(99999, 0)], PAKET_OK);
cek('receive_limit 0 -> banner tetap tersembunyi', h.html === '' && h.display === 'none',
  `html=${h.html.slice(0, 60)} display=${h.display}`);

console.log('\n=== 5. Masa aktif paket ===');
const besok = new Date(Date.now() + 2 * 86400000).toISOString();
h = jalankan([], { ...PAKET_OK, plan_expired_at: besok });
cek('sisa 2 hari -> muncul', h.html.includes('2 hari'), h.html.slice(0, 160));
const jauh = new Date(Date.now() + 30 * 86400000).toISOString();
h = jalankan([], { ...PAKET_OK, plan_expired_at: jauh });
cek('sisa 30 hari -> diam', h.html === '');
const kemarin = new Date(Date.now() - 86400000).toISOString();
h = jalankan([], { ...PAKET_OK, plan_expired_at: kemarin });
cek('sudah lewat -> kritis svg/⛔', (h.html.includes('circle cx="12"') || h.html.includes('⛔')) && h.className.includes('kritis'));

console.log('\n=== 6. Paket tidak aktif ===');
h = jalankan([], { plan_aktif: false, trial_used: true, plan_expired_at: null });
cek('paket habis & trial terpakai -> muncul', h.html.includes('tidak aktif'), h.html.slice(0, 160));
h = jalankan([], { plan_aktif: false, trial_used: false, plan_expired_at: null });
cek('belum pernah ambil paket -> JANGAN muncul (bukan kesalahan)', h.html === '');

console.log('\n=== 7. Kritis diurut paling atas ===');
h = jalankan([botKu(85, 100, 'HAMPIR')], { ...PAKET_OK, plan_expired_at: kemarin });
const iKritis = h.html.indexOf('circle cx="12"');
const iPeringatan = h.html.indexOf('path d="M10.29');
cek('kritis muncul sebelum peringatan', iKritis >= 0 && iPeringatan >= 0 && iKritis < iPeringatan,
  `kritis@${iKritis} peringatan@${iPeringatan}`);

console.log('\n=== 8. Jalur ke perbaikan ada ===');
h = jalankan([botKu(100, 100)], PAKET_OK);
cek('ada link ke /pricing', h.html.includes('/pricing'));
cek('ada link ke /kuota', h.html.includes('/kuota'));

console.log('\n=== 9. Kontrak DOM: elemennya benar-benar ada ===');
// Tanpa ini, renderPeringatan() `return` diam-diam dan banner tidak pernah
// muncul — tanpa error apa pun di console.
cek('dashboard.html punya #kuota-alert', /id="kuota-alert"/.test(html));
cek('renderPeringatan dipanggil dari renderStats (ikut jalan di jalur gagal)',
  /renderPeringatan\(\);/.test(src.slice(src.indexOf('function renderStats'))));
cek('CSS .kuota-alert ada', fs.readFileSync(path.join(ROOT, 'public', 'assets', 'page.css'), 'utf8')
  .includes('.kuota-alert{'));

console.log('');
console.log(gagal ? `=== GAGAL: ${gagal} masalah ===` : '=== SEMUA CEK LULUS ===');
process.exit(gagal ? 1 : 0);
