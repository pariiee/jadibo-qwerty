'use strict';
// .uptime harus ngukur umur BOT, bukan umur proses Node.
// Command .restart cuma mutus koneksi satu bot — prosesnya tetap jalan, jadi
// process.uptime()/START_TIME nggak pernah kek-reset dan .uptime bakal bilang
// "1 hari" terus walau bot baru aja di-restart.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const eng = require('../engine/whatsappEngine');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// 1. Engine nyediain sumber waktu per-bot
assert.strictEqual(typeof eng.getBotConnectedAt, 'function', 'getBotConnectedAt harus di-export');
assert.ok(!eng.getBotConnectedAt(999999), 'bot yang belum pernah connect -> nggak ada waktu');

// 2. .uptime / .runtime / .info pakai itu, bukan START_TIME
const info = read('plugins/01-info.js');
assert.ok(/function botUptimeMs/.test(info), 'botUptimeMs harus ada di 01-info.js');
assert.ok(/getBotConnectedAt/.test(info), 'botUptimeMs harus baca getBotConnectedAt');
assert.ok(!/formatUptime\(Date\.now\(\) - START_TIME\)/.test(info),
  'masih ada formatUptime(Date.now() - START_TIME) — itu umur proses, bukan umur bot');

// 3. Tombol .ping ikut sumber yang sama
assert.ok(/getBotConnectedAt/.test(read('plugins/07-button.js')), '.ping harus pakai getBotConnectedAt');

// 4. Bot mati -> waktunya dibuang, jangan laporkan umur basi
const engSrc = read('engine/whatsappEngine.js');
assert.ok(/botConnectedAt\.delete\(botId\)/.test(engSrc), 'stopWhatsAppBot harus buang botConnectedAt');
assert.ok(/botConnectedAt\.set\(botId, Date\.now\(\)\)/.test(engSrc), "koneksi 'open' harus nyetel botConnectedAt");

console.log('✓ uptime: umur bot (per koneksi), bukan umur proses Node');
