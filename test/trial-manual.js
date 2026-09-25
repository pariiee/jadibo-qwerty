// Trial = hak yang DIKLAIM user di /pricing, bukan hadiah otomatis saat daftar.
// Kalau ada yang nempelkin lagi `klaimTrial` ke jalur daftar atau /api/auth/me,
// akun baru langsung jadi "Unreal" + dapat slot tanpa pernah minta. Tes ini nangkap itu.
const fs = require('fs');
const path = require('path');

const baca = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const auth = baca('controllers/authController.js');

// 1. Nggak ada auto-klaim di jalur daftar / profil.
const klaim = [...auth.matchAll(/klaimTrial/g)].map((m) => m.index);
const komentar = (i) => {
  const baris = auth.slice(0, i).split('\n').pop();
  return /^\s*(\/\/|\*|\/\*)/.test(baris);
};
const klaimHidup = klaim.filter((i) => !komentar(i));
if (klaimHidup.length) {
  console.error('✗ masih ada panggilan klaimTrial() hidup di authController.js');
  process.exit(1);
}

// 2. Kartu dashboard = slot yang DIBELI (paket), bukan jatah operasi (slotsOf/admin).
const slot = auth.match(/slots_beli:\s*(.+)/);
if (!slot || !/paketOf/.test(slot[1])) {
  console.error('✗ slots_beli harus dari paketOf(), dapat: ' + (slot ? slot[1] : 'nggak ada'));
  process.exit(1);
}

// 3. Bawaan DB: akun baru nggak dikasih slot.
for (const f of ['schema.sql', 'scripts/sync-schema.js']) {
  const m = baca(f).match(/plan_slots['"]?\s*[,:]?\s*["'`]?[^"'`\n]*DEFAULT\s+(\d+)/i);
  if (!m || m[1] !== '0') {
    console.error(`✗ ${f}: plan_slots default harus 0, dapat ${m ? m[1] : '?'}`);
    process.exit(1);
  }
}

// 4. Tombol klaim manual harus ada di /pricing.
const lgn = baca('public/js/pricing.js');
if (!/btn-trial/.test(lgn) || !/\/api\/billing\/trial/.test(lgn)) {
  console.error('✗ /pricing nggak punya jalur klaim trial manual');
  process.exit(1);
}

// 5. Rute + label halaman: "langganan" sudah pensiun, semua harus "pricing".
//    Kalau ada file/link yang ketinggalan, halaman jadi 404 — tes ini yang nahan.
const server = baca('server.js');
if (!/app\.get\('\/pricing'/.test(server)) {
  console.error('✗ server.js nggak punya rute /pricing');
  process.exit(1);
}
for (const f of ['public/pricing.html', 'public/js/pricing.js', 'public/partials/sidebar.html', 'public/js/dashboard.js']) {
  if (/\/langganan|page-langganan|Langganan/.test(baca(f))) {
    console.error(`✗ ${f} masih menyebut langganan`);
    process.exit(1);
  }
}

console.log('✓ trial: nggak ada auto-klaim, kartu pakai slot paket, klaim manual di /pricing');
