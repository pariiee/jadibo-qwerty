// Cek statis server.js: (1) tiap handler rute ada di controller-nya,
// (2) tiap halaman/partial yang dirujuk halaman() ada di disk.
// Nggak nyambung DB, nggak listen — murni baca file.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cek';
process.env.INTERNAL_KEY = process.env.INTERNAL_KEY || 'cek';

const fs = require('fs');
const path = require('path');
const root = process.cwd();
const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

let gagal = 0;

// ── 1. handler rute ───────────────────────────────────────────────────────────
// Cuma baris definisi rute yang dipindai: `app.get(...)`. Kalau seluruh file
// dipindai, badan handler inline (req.body.bot.daily_limit) ikut kebaca dan
// dilaporkan sebagai handler hilang — padahal itu field JSON, bukan fungsi.
const ctrls = {
  bot: require('../controllers/botController'),
  auth: require('../controllers/authController'),
  billing: require('../controllers/billingController'),
};
const barisRute = src.split('\n').filter((l) => /app\.(get|post|put|patch|delete)\(/.test(l));
// Harus '(' sesudahnya: `billing.daftarOrder(` itu handler, `billing.html` itu
// nama file halaman — tanpa `(?=\()` keduanya ikut kebaca sebagai handler.
const re = /\b(bot|auth|billing)\.([A-Za-z_$][\w$]*)(?=\s*\()/g;
const hilang = new Set();
for (const l of barisRute) {
  for (const m of l.matchAll(re)) {
    if (typeof ctrls[m[1]][m[2]] !== 'function') hilang.add(`${m[1]}.${m[2]}`);
  }
}
if (hilang.size) { gagal++; console.log('❌ handler hilang:', [...hilang].join(', ')); }
else console.log('✅ semua handler rute ada');

// ── 2. halaman & partial ──────────────────────────────────────────────────────
const pub = path.join(root, 'public');
const perlu = [...src.matchAll(/halaman\('([^']+)'/g)].map((x) => x[1]);
const uniq = [...new Set(perlu)];
for (const f of uniq) {
  const p = path.join(pub, f);
  if (!fs.existsSync(p)) { gagal++; console.log('❌ halaman hilang:', f); }
}
console.log(`✅ halaman: ${uniq.length} dirujuk, ${uniq.filter((f) => fs.existsSync(path.join(pub, f))).length} ada`);

// ── 3. include di dalam halaman ───────────────────────────────────────────────
const INC = /<!--\s*@include\s+([\w.\/-]+)\s*-->/g;
let incJumlah = 0, incHilang = 0;
for (const f of uniq) {
  const p = path.join(pub, f);
  if (!fs.existsSync(p)) continue;
  const isi = fs.readFileSync(p, 'utf8');
  for (const mm of isi.matchAll(INC)) {
    incJumlah++;
    if (!fs.existsSync(path.join(pub, 'partials', mm[1]))) { incHilang++; console.log(`❌ partial hilang: ${f} → partials/${mm[1]}`); }
  }
}
if (incHilang) gagal++;
console.log(`✅ include: ${incJumlah} rujukan, ${incJumlah - incHilang} ketemu`);

console.log(gagal ? `\n=== GAGAL: ${gagal} masalah ===` : '\n=== SEMUA CEK LULUS ===');
process.exit(gagal ? 1 : 0);
