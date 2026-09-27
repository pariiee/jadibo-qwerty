// Load-test statis: baca config.js + bot-stats.js, kumpulin semua id/class yang
// di-query, lalu cek ada nggak di HTML-nya. Nangkep ReferenceError & id nyasar
// tanpa perlu browser. Pola sama kayak test/dashboard-ui.js.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let gagal = 0;

function baca(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

// @include head.html dst → gabungin partial biar id di partial kehitung.
function rakit(html) {
  return html.replace(/<!--\s*@include\s+([\w.-]+)\s*-->/g,
    (_, f) => rakit(baca('public/partials/' + f)));
}

function cek(label, jsPath, htmlPath) {
  const js = baca(jsPath);
  const html = rakit(baca(htmlPath));

  const idHtml = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const idJs = [...js.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map(m => m[1]);
  const hilang = [...new Set(idJs)].filter(id => !idHtml.has(id));

  // window.foo = foo barengan deklarasi foo-nya harus ada.
  const ekspor = [...js.matchAll(/window\.(\w+)\s*=\s*(\w+)\s*;/g)]
    .filter(m => m[1] === m[2])
    .map(m => m[2]);
  const yatim = ekspor.filter(fn => !new RegExp('function\\s+' + fn + '\\b').test(js));

  if (hilang.length) { console.log('[FAIL] ' + label + ' → id nggak ada di HTML: ' + hilang.join(', ')); gagal++; }
  if (yatim.length) { console.log('[FAIL] ' + label + ' → window.X = X tapi ' + yatim.join(', ') + '() nggak didefinisikan'); gagal++; }
  if (!hilang.length && !yatim.length) console.log('[OK]   ' + label);
}

// config.js punya fungsi generateStats yang dipanggil lewat api() — objeknya
// harus punya `ringkas`, kalau nggak kartu statistiknya "undefined".
function cekStats() {
  const js = baca('public/js/bot-stats.js');
  for (const k of ['ringkas', 'cmd', 'user', 'harian']) {
    if (!js.includes('d.' + k)) { console.log('[FAIL] bot-stats.js nggak baca d.' + k); gagal++; }
  }
  if (!/function getBotStats/.test(baca('controllers/botController.js'))) { console.log('[FAIL] getBotStats hilang'); gagal++; }
  if (!/function exportConfig/.test(baca('controllers/botController.js'))) { console.log('[FAIL] exportConfig hilang'); gagal++; }
  if (!/bots\/:id\/config/.test(baca('server.js'))) { console.log('[FAIL] rute /api/bots/:id/config hilang'); gagal++; }
  if (!/bots\/:id\/stats/.test(baca('server.js'))) { console.log('[FAIL] rute /api/bots/:id/stats hilang'); gagal++; }
}

cek('config.html ↔ config.js', 'public/js/config.js', 'public/config.html');
cek('bot-detail.html ↔ bot-stats.js', 'public/js/bot-stats.js', 'public/bot-detail.html');
cekStats();

console.log(gagal ? '\n' + gagal + ' gagal' : '\nsemua ok');
process.exit(gagal ? 1 : 0);
