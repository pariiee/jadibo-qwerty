#!/usr/bin/env node
/**
 * test/pesan-basi.js
 * Gate: umur pesan dari `messageTimestamp` WA dihitung benar (detik vs ms).
 *
 * Kenapa: WA nge-flood ULANG pesan lama begitu HP member balik online. Engine
 * buang yang umurnya > 2 menit pakai `event.umurMs`. Kalau konversi detik->ms
 * salah, umur meleset ~1000x: bisa jadi semua pesan dianggap basi (bot diem
 * total) atau nggak ada yang kebuang (bot ngerjain backlog 2 jam).
 */
const assert = require('assert');
const { normalisasiPesan } = require('../engine/baileys/client.js');

const now = Math.floor(Date.now() / 1000);

// WA ngirim DETIK. Baru (10 dtk) -> bukan basi (< 2 menit).
const baru = normalisasiPesan({ messageTimestamp: now - 10 });
assert.strictEqual(baru.umurMs >= 9000 && baru.umurMs < 15000, true, 'umur pesan detik salah hitung');
assert.strictEqual(baru.timestamp > 1e12, true, 'detik harus dikonversi ke ms');

// Backlog 2 jam -> basi (ini yg dikeluhin: "delay nya 2 jam lebih").
const basi = normalisasiPesan({ messageTimestamp: now - 7200 });
assert.strictEqual(basi.umurMs > 120000, true, 'pesan 2 jam harus kebaca basi');

// Sebagian kiriman pakai MS langsung -> jangan dikali 1000 lagi.
const ms = normalisasiPesan({ messageTimestamp: Date.now() - 5000 });
assert.strictEqual(ms.umurMs >= 4000 && ms.umurMs < 10000, true, 'timestamp ms jangan dikali lagi');

// Tanpa timestamp -> umur 0, artinya JANGAN kebuang (fail-open, jangan diem).
assert.strictEqual(normalisasiPesan({}).umurMs, 0, 'tanpa timestamp jangan dianggap basi');
assert.strictEqual(normalisasiPesan({ messageTimestamp: 0 }).umurMs, 0, 'timestamp 0 jangan dianggap basi');

console.log('OK pesan-basi: umur pesan benar, backlog 2 jam kebuang, pesan baru lolos');
