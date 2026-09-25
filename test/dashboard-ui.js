// Dashboard: kartu ringkasan + FAQ.
// Nggak butuh server/DB — cuma baca file. Yang dijaga: id yang ditulis
// dashboard.js harus ada di dashboard.html, kalau nggak kartunya jadi null.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PUB = path.join(__dirname, '..', 'public');
const baca = (p) => fs.readFileSync(path.join(PUB, p), 'utf8');

// Rangkai persis kayak halaman() di server.js.
const html = baca('dashboard.html')
  .replace(/<!--\s*@include\s+([\w.-]+)\s*-->/g, (_, f) => baca(path.join('partials', f)));
assert.ok(!/@include/.test(html), 'ada @include yang gagal dirangkai');

// ── Kartu ringkasan ─────────────────────────────────────────────────────────
const KARTU = ['st-role', 'st-exp', 'st-online', 'st-slot'];
for (const id of KARTU) {
  assert.ok(html.includes(`id="${id}"`), `kartu hilang: ${id}`);
  assert.ok(html.includes(`id="${id}-sub"`), `sub-label kartu hilang: ${id}-sub`);
}
for (const lbl of ['Role', 'Kedaluwarsa', 'Bot Online', 'Total Slot']) {
  assert.ok(html.includes(`>${lbl}<`), `label kartu hilang: ${lbl}`);
}

// ── FAQ ─────────────────────────────────────────────────────────────────────
assert.ok(/FAQ/.test(html) && /Pertanyaan yang sering ditanyakan/.test(html), 'judul FAQ ilang');
const jumlahFaq = (html.match(/<summary>/g) || []).length;
assert.ok(jumlahFaq >= 8, `FAQ cuma ${jumlahFaq} item`);
assert.ok(/@BotFather/.test(html), 'FAQ Telegram ilang — harus ada versi Telegram, bukan cuma WA');
assert.ok(/nomor WhatsApp utama/.test(html), 'FAQ nomor utama ilang');

// ── CSS ─────────────────────────────────────────────────────────────────────
assert.ok(/assets\/page\.css/.test(html), 'page.css nggak dilink');
const css = baca(path.join('assets', 'page.css'));
for (const sel of ['.stats{', '.stat .val{', '.faq details{', '.faq summary::after{']) {
  assert.ok(css.includes(sel), `CSS ilang: ${sel}`);
}

// ── JS: tiap id yang dibaca harus ada di HTML ───────────────────────────────
const js = baca(path.join('js', 'dashboard.js'));
assert.ok(/function renderStats\(\)/.test(js), 'renderStats nggak ada');
assert.ok((js.match(/renderStats\(\)/g) || []).length >= 3, 'renderStats kurang dipanggil');
for (const id of [...js.matchAll(/getElementById\('(st-[\w-]+)'\)/g)].map(m => m[1])) {
  assert.ok(html.includes(`id="${id}"`), `dashboard.js baca #${id} tapi nggak ada di HTML`);
}
// trial_hari ditampilin di sub Kedaluwarsa — pastiin servernya emang ngirim.
assert.ok(/trial_hari/.test(js) && /trial_hari/.test(fs.readFileSync(
  path.join(__dirname, '..', 'controllers', 'authController.js'), 'utf8')),
  'trial_hari dipakai FE tapi nggak dikirim /api/auth/me');

console.log(`✓ dashboard: ${KARTU.length} kartu + ${jumlahFaq} FAQ, id nyambung HTML↔JS`);
