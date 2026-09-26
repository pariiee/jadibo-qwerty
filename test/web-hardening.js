'use strict';
// Fix cepat web: JWT tanpa fallback, registrasi publik default tutup,
// stat total_bots_online jangan dobel turun, stop bot telegram jangan nunggu 3 detik.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..');
const auth = fs.readFileSync(path.join(dir, 'controllers', 'authController.js'), 'utf8');
const botc = fs.readFileSync(path.join(dir, 'controllers', 'botController.js'), 'utf8');
const srv  = fs.readFileSync(path.join(dir, 'server.js'), 'utf8');
const wa   = fs.readFileSync(path.join(dir, 'engine', 'whatsappEngine.js'), 'utf8');

assert.ok(!/'changeme'/.test(auth) && !/'changeme'/.test(srv),
  "fallback JWT_SECRET 'changeme' harus hilang dari auth & server");
assert.ok(/if \(!process\.env\.JWT_SECRET\) \{[\s\S]*?process\.exit\(1\)/.test(srv),
  'server harus nolak boot kalau JWT_SECRET kosong');

assert.ok(/process\.env\.ALLOW_REGISTER !== '1'[\s\S]{0,80}403/.test(auth),
  'registrasi publik harus default tutup (ALLOW_REGISTER=1 buat buka)');

assert.ok(!/await decrementStat\(/.test(botc),
  'botController jangan turunin stat sendiri — engine yang pegang');

assert.ok(/typeof inst\.disconnect !== 'function'\) closeWaited = true/.test(wa),
  'stop bot telegram jangan nunggu close 3 detik');

const db = fs.readFileSync(path.join(dir, 'config', 'database.js'), 'utf8');
assert.ok(/COUNT\(\*\) AS n FROM bots WHERE is_running = 1/.test(db),
  'total_bots_online harus dihitung dari tabel bots, bukan dari counter yang drift');

// Role di token itu snapshot waktu login. Kalau role diubah setelah itu, admin
// yang sah ditolak 403 dan cuma kelihatan "balik sendiri ke /dashboard".
assert.ok(/async function requireKing[\s\S]{0,400}SELECT role, is_active FROM users/.test(auth),
  'requireKing harus baca role dari DB, bukan dari payload token');

// Catch-all dulu menyajikan landing page dengan status 200: URL salah ketik
// kelihatan "berhasil" dan user cuma bingung. Sekarang harus 404 sungguhan —
// dan `/` wajib punya rute sendiri, kalau tidak landing page ikut 404.
assert.ok(/app\.get\('\/',\s+halaman\('index\.html'\)\)/.test(srv),
  "rute '/' harus eksplisit, kalau tidak landing page kebawa catch-all 404");
assert.ok(/app\.get\('\*',\s+halaman\('404\.html',\s*404\)\)/.test(srv),
  'catch-all harus menyajikan 404.html dengan status 404');
assert.ok(/const halaman = \(nama, kode = 200\)/.test(srv),
  'halaman() harus bisa menerima status HTTP');

// Nav landing dipakai juga oleh 404.html. Anchor tanpa '/' mati begitu
// halamannya bukan landing.
const nav = fs.readFileSync(path.join(dir, 'public', 'partials', 'nav.html'), 'utf8');
assert.ok(!/href="#[a-z]/.test(nav),
  'anchor nav harus absolut ke /#... supaya jalan dari halaman selain landing');
assert.ok(/href="\/#features"/.test(nav), 'anchor nav harus menunjuk ke /#features');

console.log('web-hardening OK');
