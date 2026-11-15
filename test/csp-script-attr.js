'use strict';
/**
 * test/csp-script-attr.js — CSP scriptSrcAttr tidak lagi 'unsafe-inline'.
 *
 * onclick="" di HTML dicabut dari seluruh public/*.html, diganti
 * data-act="..." (lihat public/js/act.js). Kalau ada onclick="" yang
 * lolos review berikutnya, dia akan silently gagal (CSP block) alih-alih
 * kelihatan di review — makanya dikunci di sini: scriptSrcAttr HARUS
 * tetap ketat, dan HTML HARUS tetap bersih dari onclick=.
 *
 * Nggak nyentuh DB/network, nggak nge-boot server.
 * Jalankan: node test/csp-script-attr.js
 */
const fs = require('fs');
const path = require('path');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`  ✓ ${nama}`);
  else { gagal++; console.error(`  ✗ ${nama}${info ? ' — ' + info : ''}`); }
};

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
cek("scriptSrcAttr TIDAK 'unsafe-inline'", !/scriptSrcAttr:\s*\[[^\]]*unsafe-inline/.test(server));
cek("scriptSrcAttr diset ('none')", /scriptSrcAttr:\s*\["'none'"\]/.test(server));

const pub = path.join(__dirname, '..', 'public');
const sentuh = [];
for (const f of fs.readdirSync(pub)) {
  if (!f.endsWith('.html')) continue;
  // Buang isi <script>...</script> dulu — komentar JS yang MENYEBUT
  // "onclick=" (dokumentasi, seperti di offline.html) bukan pelanggaran;
  // yang dicari adalah atribut sungguhan di markup HTML-nya.
  const isi = fs.readFileSync(path.join(pub, f), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  if (/\son(click|load|error|change|input|submit)\s*=/.test(isi)) sentuh.push(f);
}
cek('tidak ada onclick=/onload=/dll di public/*.html', sentuh.length === 0, sentuh.join(', '));

console.log(gagal ? `\n❌ ${gagal} gagal` : '\n✅ CSP scriptSrcAttr ketat, HTML bebas inline event handler');
process.exitCode = gagal ? 1 : 0;
