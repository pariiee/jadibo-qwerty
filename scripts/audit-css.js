// Cari DEFECT nyata di page.css, bukan komponen bersama yang emang global:
//   A. kelas unscoped yang didefinisi >1x  → definisi terakhir menang di SEMUA halaman
//   B. warna literal (nggak ikut dark mode)
const fs = require('fs');
const css = fs.readFileSync('public/assets/page.css', 'utf8');

// ── A. definisi ganda, tanpa scope ───────────────────────────────────────────
const bersih = css.replace(/\/\*[\s\S]*?\*\//g, '');
const baris = css.split('\n');
const aturan = [];
bersih.split('\n').forEach((ln, i) => {
  const m = ln.match(/^([^{}]+)\{/);
  if (!m) return;
  const sel = m[1].trim();
  if (!sel || sel.startsWith('@')) return;
  aturan.push({ sel, line: i + 1 });
});

const perKelas = {};
for (const { sel, line } of aturan) {
  if (/^body\.page-/.test(sel)) continue;                    // sudah di-scope
  if (/^(:root|html|html\.dark|\*)/.test(sel)) continue;     // token/reset
  for (const k of sel.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
    (perKelas[k[1]] ||= []).push({ sel, line });
  }
}

console.log('=== A. KELAS UNSCoped DIDEFINISI >1x (definisi terakhir menang) ===');
let adaA = false;
for (const [k, defs] of Object.entries(perKelas)) {
  const unik = [...new Set(defs.map(d => d.sel))];
  // cuma peduli kalau nama kelas yang sama muncul di selector BERBEDA
  const dasar = unik.filter(s => new RegExp(`(^|[ ,>])\\.${k}(?![\\w-])`).test(s));
  if (dasar.length < 2) continue;
  // base rule vs varian (:hover, b, span) — varian itu sah
  const base = unik.filter(s => s === `.${k}`);
  if (base.length < 2) continue;
  adaA = true;
  console.log(`  .${k}`);
  for (const d of defs.filter(d => d.sel === `.${k}`)) console.log(`     baris ${d.line}`);
}
if (!adaA) console.log('  (kosong)');

// ── B. warna literal ─────────────────────────────────────────────────────────
console.log('\n=== B. WARNA LITERAL (tidak ikut toggle dark) ===');
let adaB = false;
baris.forEach((ln, i) => {
  if (/^\s*(:root|html\.dark)/.test(ln)) return;             // token, sah
  const m = ln.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/);
  if (m && ln.includes('{') === false) return;
  if (m) {
    adaB = true;
    console.log(`  ${String(i + 1).padStart(4)}: ${ln.trim().slice(0, 96)}`);
  }
});
if (!adaB) console.log('  (kosong)');
