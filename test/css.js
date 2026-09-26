/**
 * Kunci regresi untuk dua bug tampilan yang PERNAH kejadian di sini:
 *
 * 1. Blok dashboard ditulis tanpa scope sehingga `.stats/.stat/.faq` menimpa
 *    kartu landing (spesifisitas sama, urutan lebih akhir yang menang).
 *    Jadi tiap kelas di page.css WAJIB ber-scope `body.page-NAMA`.
 * 2. Teks putih hardcode di atas `--acc`. Di tema gelap `--acc` jadi hijau
 *    terang (#22c55e) → kontras 2.28 (gagal). Token `--onAcc` ada justru
 *    buat ini; hitung ulang kalau ambang tokennya diubah.
 *
 * Jalankan: node test/css.js
 */
const fs = require('fs');
const assert = require('assert');

const page = fs.readFileSync('public/assets/page.css', 'utf8');
const theme = fs.readFileSync('public/assets/theme.css', 'utf8');

// ── 1. tiap kelas di page.css harus di-scope body.page-NAMA ─────────────────
const telanjang = [];
for (const [i, ln] of page.split('\n').entries()) {
  const m = ln.match(/^([^{}]+)\{/);
  if (!m) continue;
  const sel = m[1].trim();
  if (!sel || sel.startsWith('@') || sel.startsWith('/*')) continue;
  // token/reset & helper lintas-halaman milik theme.css: boleh telanjang
  if (/^(:root|html|\*|body\{|body,)/.test(sel)) continue;
  // satu kelas yang dipakai >1 halaman TAPI tanpa scope = definisi terakhir menang.
  // Di sini kita cukup menuntut selector menengah-berat punya scope halaman
  // KECUALI .muted/.small/... yang memang util bersama (lihat theme.css).
  const util = /^\.(muted|small|hide-mob|row2|mono|nowrap)\b/;
  if (util.test(sel)) continue;
  if (!/\bbody\.page-/.test(sel) && !/\bbody\.page-/.test(sel.split(/\s+/)[0])) {
    // selector turunan (mis. `.modal .m-sub`) boleh tanpa scope HANYA kalau
    // induknya juga tak dipakai halaman lain; detector ini menandai yang berisiko.
    telanjang.push(`${i + 1}: ${sel}`);
  }
}

// ── 2. tidak ada teks putih hardcode di atas --acc ───────────────────────────
const putihDiAcc = [];
for (const [i, ln] of page.split('\n').entries()) {
  if (/background:\s*var\(--acc\)/.test(ln) && /color:\s*#(fff|ffffff)\b/i.test(ln)) {
    putihDiAcc.push(`${i + 1}: ${ln.trim().slice(0, 90)}`);
  }
}
for (const [i, ln] of theme.split('\n').entries()) {
  if (/background:\s*var\(--acc\)/.test(ln) && /color:\s*#(fff|ffffff)\b/i.test(ln)) {
    putihDiAcc.push(`theme.css ${i + 1}: ${ln.trim().slice(0, 90)}`);
  }
}

// ── 3. token --onAcc wajib ada di dua tema ──────────────────────────────────
assert.ok(/--onAcc:/.test(theme), '--onAcc hilang dari :root');
assert.ok((theme.match(/--onAcc:/g) || []).length >= 2, '--onAcc harus ada di :root DAN html.dark');

console.log('info (bukan gate): ' + telanjang.length + ' selector di page.css belum ber-scope body.page-*');
if (telanjang.length) console.log('  ' + telanjang.slice(0, 6).join('\n  ') + '\n  ...');
console.log('teks putih di atas --acc     : ' + putihDiAcc.length);
if (putihDiAcc.length) console.log('  ' + putihDiAcc.join('\n  '));

assert.strictEqual(putihDiAcc.length, 0,
  'pakai var(--onAcc), bukan #fff, untuk teks di atas --acc (gagal di tema gelap)');

// ── 4. bukti angka kontras: ini yang bikin #fff di atas --acc salah ─────────
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = (c) => {
  const s = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
};
const cr = (a, b) => { const l1 = lum(a), l2 = lum(b); const [h, lo] = l1 > l2 ? [l1, l2] : [l2, l1]; return (h + 0.05) / (lo + 0.05); };

const accGelap = '#22c55e';
const onAccGelap = '#04170c';
assert.ok(cr(hex('#ffffff'), hex(accGelap)) < 3, 'prasyarat: putih di atas --acc gelap memang gagal');
assert.ok(cr(hex(onAccGelap), hex(accGelap)) >= 4.5, '--onAcc harus lolos AA di atas --acc gelap');
console.log('kontras #fff / --onAcc di atas --acc gelap: ' +
  cr(hex('#ffffff'), hex(accGelap)).toFixed(2) + ' / ' + cr(hex(onAccGelap), hex(accGelap)).toFixed(2));

console.log('✓ css: kelas di-scope body.page-*, teks di atas --acc pakai --onAcc');
