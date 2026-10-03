'use strict';
/**
 * test/admin-kontrak-dom.js
 *
 * Kelas bug yang paling mahal di halaman admin: JS dan HTML tidak cocok, dan
 * TIDAK ADA error di mana pun.
 *
 *   - `getElementById('x').innerHTML = ...` dengan `#x` yang tidak ada →
 *     TypeError di dalam fungsi async, tampil sebagai "tidak terjadi apa-apa".
 *   - `data-act="foo"` sementara `window.foo` tidak pernah di-export →
 *     `act.js` cuma `console.warn`, tombolnya mati tanpa pesan.
 *
 * Dua-duanya lolos `node --check` (sintaksnya benar) dan lolos tes backend
 * (servernya tidak tahu apa-apa). Jadi harus diperiksa di sini, sebagai teks.
 */

const fs = require('fs');
const path = require('path');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

const baca = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const html = baca('public/admin.html');
const js   = baca('public/js/admin.js');

// Buang komentar JS supaya contoh di komentar tidak ikut terhitung.
const jsKode = js.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

console.log('=== 1. Setiap id yang dipakai JS ada di HTML ===');
// Partial (`<!-- @include sidebar.html -->`) juga sumber id — `#side-avatar`,
// `#nav-admin`, dll. datang dari situ, bukan dari admin.html.
const berkasHtml = ['public/admin.html',
  ...fs.readdirSync(path.join(__dirname, '..', 'public', 'partials')).map((f) => 'public/partials/' + f)];
const idHtml = new Set(
  berkasHtml.flatMap((p) => [...baca(p).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))
);
// `getElementById('a')` dan `getElementById('a' + id)` (id dinamis) — yang
// terakhir tidak bisa diperiksa statis, jadi dilewati dengan sadar.
const idDinamis = [];
const idDipakai = new Set();
for (const m of jsKode.matchAll(/getElementById\(([^)]*)\)/g)) {
  const arg = m[1].trim();
  const literal = /^'(?:[^'\\]|\\.)*'$/.exec(arg) || /^"(?:[^"\\]|\\.)*"$/.exec(arg);
  if (literal) idDipakai.add(arg.slice(1, -1));
  else idDinamis.push(arg);
}
const idHilang = [...idDipakai].filter((id) => !idHtml.has(id));
cek(`semua id statis ada di admin.html + partial (${idDipakai.size} diperiksa, ${berkasHtml.length} berkas)`,
  idHilang.length === 0, idHilang.map((i) => '#' + i).join(', '));
if (idDinamis.length) console.log(`   (id dinamis dilewati: ${idDinamis.length} — ${idDinamis[0]})`);

console.log('\n=== 2. Setiap data-act punya fungsinya di window ===');
// `data-act` muncul di DUA tempat: HTML statis DAN string HTML yang dibangun JS
// (tombol per baris tabel). Keduanya harus punya fungsinya di `window`.
const actHtml = [...html.matchAll(/data-act="([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
const actJs = [...jsKode.matchAll(/data-act=\\?"([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
const actSemua = new Set([...actHtml, ...actJs]);
const diekspor = new Set([...jsKode.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]));
const actHilang = [...actSemua].filter((n) => !diekspor.has(n));
cek(`semua data-act diekspor (${actSemua.size} unik: ${actHtml.length} di HTML, ${actJs.length} dari JS)`,
  actHilang.length === 0, actHilang.length ? 'belum diekspor: ' + actHilang.join(', ') : '');

console.log('\n=== 3. Setiap export menunjuk fungsi yang BENAR-BENAR ada ===');
// `window.foo = foo` dengan `foo` yang tidak didefinisikan → `act.js` cuma
// `console.warn`, tombolnya mati tanpa pesan. Dicek dari nama fungsinya, BUKAN
// dari dipakai-tidaknya di HTML: sebagian besar tombol dibangun di JS.
const didefinisikan = new Set([
  ...[...jsKode.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
  ...[...jsKode.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]),
]);
const exportHilang = [...diekspor].filter((n) => !didefinisikan.has(n));
cek(`semua export menunjuk fungsi yang ada (${diekspor.size} export)`,
  exportHilang.length === 0, exportHilang.length ? 'tidak ada fungsinya: ' + exportHilang.join(', ') : '');

console.log('\n=== 4. Tab yang dipanggil JS ada elemen pane-nya ===');
const tabNama = [...jsKode.matchAll(/'(\w+)',\s*'(\w+)',\s*'(\w+)',\s*'(\w+)'(?:,\s*'(\w+)')?\]\.forEach\(\(t\) => \{[\s\S]{0,120}?pane-/g)]
  .flatMap((m) => m.slice(1).filter(Boolean));
const paneAda = [...html.matchAll(/id="pane-(\w+)"/g)].map((m) => m[1]);
cek(`semua tab punya pane-nya (${tabNama.length} tab, ${paneAda.length} pane)`,
  tabNama.every((t) => paneAda.includes(t)) && tabNama.length === paneAda.length,
  `tab: ${tabNama.join(',')} | pane: ${paneAda.join(',')}`);

console.log('\n=== 5. Endpoint yang dipanggil JS benar-benar terdaftar di server ===');
const server = baca('server.js');
const endpointJs = [...jsKode.matchAll(/api\('(\/api\/[^'?]+)/g)].map((m) => m[1]);
const endpointHilang = [...new Set(endpointJs)].filter((e) => {
  // Cocokkan path apa adanya; `:id` di server diganti apa pun saat runtime.
  const pola = e.replace(/\/\d+/g, '/:id').replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '*' ? '.*' : '\\' + c));
  return !new RegExp(`'/api/[^']*${pola.split('/api')[1] || ''}'`).test(server) &&
         !server.includes(e.split('?')[0]);
});
cek(`semua endpoint JS ada di server.js (${new Set(endpointJs).size} unik)`,
  endpointHilang.length === 0, endpointHilang.join(', '));

console.log('\n=== 6. Link ke halaman lain benar-benar ada rutenya ===');
// Tombol `Kontrol`/`Statistik` di tabel Bot mengarah ke `/config/:id` dan
// `/bot/:id`. Kalau rutenya hilang/di-rename, link-nya jadi 404 yang cuma
// ketahuan setelah diklik — tidak ada error, tidak ada tes backend yang
// memerahkan. Persis pola yang dua bagian sebelumnya kunci.
// Ambil href baik dari HTML statis maupun dari string HTML yang dibangun JS.
// Yang dibangun JS berbentuk `href="/config/' + b.id + '"` — regex harus ikut
// menelan bagian `' + expr + '` baru ketemu `:id`-nya. Kalau tidak, yang
// tertangkap cuma `/config/` dan tesnya salah menuduh.
const hrefJs = [...js.matchAll(/href=\\?"(\/[^"]*?)\\?"/g)]
  .map((m) => m[1].replace(/' \+ [^+]+ \+ '/g, ':id'));
const hrefHtml = [...html.matchAll(/href="(\/[^"#?]*)"/g)].map((m) => m[1]);
const ruteHalaman = new Set(
  [...server.matchAll(/app\.get\('(\/[^']*)'/g)]
    .map((m) => m[1].replace(/:[A-Za-z]+/g, ':id'))
);
const hrefHilang = [...new Set([...hrefJs, ...hrefHtml])]
  .map((h) => h.replace(/\/\d+/g, '/:id'))
  .filter((h) => !ruteHalaman.has(h) && !ruteHalaman.has(h.replace(/\/$/, '')));
cek(`semua link JS+HTML punya rutenya (${new Set([...hrefJs, ...hrefHtml]).size} unik)`,
  hrefHilang.length === 0, hrefHilang.join(', '));
cek('link Kontrol -> /config/:id ada', ruteHalaman.has('/config/:id'));
cek('link Statistik -> /bot/:id ada', ruteHalaman.has('/bot/:id'));

console.log('');
console.log(gagal ? `=== GAGAL: ${gagal} masalah ===` : '=== SEMUA CEK LULUS ===');
process.exit(gagal ? 1 : 0);
