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

console.log('web-hardening OK');
