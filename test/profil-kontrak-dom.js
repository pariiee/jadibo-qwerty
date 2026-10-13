'use strict';
/**
 * test/profil-kontrak-dom.js
 * Kontrak DOM halaman Profil Saya (/profil).
 *
 * Kenapa ada: halaman ini JS-nya pegang banyak id (`#pf-*`, `#hp-*`, `#em-*`,
 * `#pw-*`). Kalau id di HTML hilang/berubah, `getElementById('x').value = ...`
 * meledak di dalam fungsi async — hasilnya cuma "tidak terjadi apa-apa", tanpa
 * error di mana pun. Pola yang sama sudah memakan waktu di halaman admin.
 *
 * Tes ini juga mengunci bentuk JARINGAN KARTU: `.grid-hp` (2 kolom) cuma boleh
 * dipakai kalau dua kartu isian (HP + Email) memang ada. Kalau salah satu
 * dihapus tanpa memperbarui CSS, kartunya balik jadi tumpukan panjang.
 *
 * Jalankan: node test/profil-kontrak-dom.js
 */
const fs = require('fs');
const path = require('path');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

const baca = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const html = baca('public/profil.html');
const js   = baca('public/js/profil.js');
const pageCss = baca('public/assets/page.css');

const jsKode = js.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

console.log('=== 1. Setiap id yang dipakai JS ada di HTML + partial ===');
const berkasHtml = ['public/profil.html',
  ...fs.readdirSync(path.join(__dirname, '..', 'public', 'partials')).map((f) => 'public/partials/' + f)];
const idHtml = new Set(
  berkasHtml.flatMap((p) => [...baca(p).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))
);
const idDinamis = [];
const idDipakai = new Set();
for (const m of jsKode.matchAll(/getElementById\(([^)]*)\)/g)) {
  const arg = m[1].trim();
  const literal = /^'(?:[^'\\]|\\.)*'$/.exec(arg) || /^"(?:[^"\\]|\\.)*"$/.exec(arg);
  if (literal) idDipakai.add(arg.slice(1, -1));
  else idDinamis.push(arg);
}
const idHilang = [...idDipakai].filter((id) => !idHtml.has(id));
cek(`semua id statis ada di profil.html + partial (${idDipakai.size} diperiksa)`,
  idHilang.length === 0, idHilang.map((i) => '#' + i).join(', '));
if (idDinamis.length) console.log(`   (id dinamis dilewati: ${idDinamis.length} — ${idDinamis[0]})`);

console.log('\n=== 2. Setiap form yang didengar JS punya <form>-nya ===');
const formJs = [...jsKode.matchAll(/getElementById\('([a-z]+-form)'\)\.addEventListener/g)].map((m) => m[1]);
const formHtml = [...html.matchAll(/id="([a-z]+-form)"/g)].map((m) => m[1]);
const formHilang = formJs.filter((f) => !formHtml.includes(f));
cek(`form cocok (${formJs.length} didengar: ${formJs.join(', ')})`,
  formHilang.length === 0, formHilang.join(', '));

console.log('\n=== 3. Endpoint yang dipanggil JS terdaftar di server.js ===');
const server = baca('server.js');
const endpoint = [...new Set([...jsKode.matchAll(/api\('(\/api\/[^'?]+)/g)].map((m) => m[1]))];
const endpointHilang = endpoint.filter((e) => !server.includes(e.split('?')[0]));
cek(`semua endpoint ada di server.js (${endpoint.length}: ${endpoint.join(', ')})`,
  endpointHilang.length === 0, endpointHilang.join(', '));

console.log('\n=== 4. Jaring kartu: .content jadi grid 2 kolom ===');
// Halaman ini punya 3 form (HP, Email, Password). Kalau semuanya ditumpuk
// vertikal, halamannya jadi panjang. `.content` dijadikan grid 2 kolom oleh
// page.css, dan yang perlu lebar penuh diberi `.span-all`.
cek('.content ada di profil.html', /<div class="content">/.test(html));
cek('kartu statistik diberi .span-all (biar tidak ikut 2 kolom)',
  /class="stats span-all"/.test(html));
cek('tepat 2 kartu isian => 2 kolom terisi',
  (html.match(/<div class="card">/g) || []).length === 2,
  `kartu ditemukan: ${(html.match(/<div class="card">/g) || []).length}`);
cek('grid 2 kolom untuk .content ada di page.css',
  /body\.page-profil \.content\{[^}]*grid-template-columns:repeat\(2/.test(pageCss.replace(/\s+/g, ' ')));
cek('ada breakpoint 1 kolom untuk layar kecil',
  /max-width:1000px[\s\S]{0,200}body\.page-profil \.content\{grid-template-columns:minmax\(0,1fr\)\}/.test(pageCss));
cek('kartu dikunci penuh 1 kolom (tidak setengah-setengah di >1000px)',
  /body\.page-profil \.content>\.card\{[^}]*margin:0/.test(pageCss.replace(/\s+/g, ' ')));

console.log('\n=== 4b. Tag HTML seimbang (div & form) ===');
const bukaDiv = (html.match(/<div\b/g) || []).length;
const tutupDiv = (html.match(/<\/div>/g) || []).length;
cek(`<div> seimbang (${bukaDiv} buka / ${tutupDiv} tutup)`, bukaDiv === tutupDiv);
const bukaForm = (html.match(/<form\b/g) || []).length;
const tutupForm = (html.match(/<\/form>/g) || []).length;
cek(`<form> seimbang (${bukaForm} buka / ${tutupForm} tutup)`, bukaForm === tutupForm);
cek('tidak ada sisa pembungkus .grid-hp yang telantar',
  !/class="grid-hp"/.test(html) || /<\/div>\s*<\/div>\s*<\/main>/.test(html));

console.log('\n=== 5. Endpoint email/HP/password tetap dipanggil ===');
for (const e of ['/api/auth/phone', '/api/auth/email', '/api/auth/password']) {
  cek(`${e} dipanggil JS`, jsKode.includes(e));
}

console.log('\n=== 6. Label input tetap terhubung (aksesibilitas) ===');
const forLabel = [...html.matchAll(/<label[^>]*for="([^"]+)"/g)].map((m) => m[1]);
const idInput = new Set([...html.matchAll(/<input[^>]*id="([^"]+)"/g)].map((m) => m[1]));
const labelMati = forLabel.filter((f) => !idInput.has(f));
cek(`semua <label for> menunjuk input yang ada (${forLabel.length})`,
  labelMati.length === 0, labelMati.join(', '));

console.log('');
console.log(gagal ? `=== GAGAL: ${gagal} masalah ===` : '=== SEMUA CEK LULUS ===');
process.exit(gagal ? 1 : 0);
