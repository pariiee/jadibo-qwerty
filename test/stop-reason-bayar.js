'use strict';
/**
 * test/stop-reason-bayar.js — kunci reset stop_reason='expired' di billing.
 *
 * Kenapa ada: cron 1-menit (server.js:628) set `bots.stop_reason='expired'`
 * saat paket habis. `autoStartBots` (server.js:514) skip bot dengan
 * stop_reason='expired'. Sebelumnya `terapkanPaket()` (billingController.js)
 * menyalakan bot via `engineBus.start()`, yang DI-AWAL reset stop_reason
 * (engine/whatsappEngine.js:319). TAPI kalau start gagal (QR timeout, zapo
 * error) DAN user restart server, bot yang sudah bayar tapi gagal start
 * akan di-skip di boot berikutnya. Reset harus terjadi di billing, tidak
 * boleh andalkan start.
 *
 * Yang diuji (statis, baca source):
 *   1. billingController: terapkanPaket melakukan UPDATE stop_reason=NULL
 *      untuk bot yang ditemukan `stop_reason='expired'`.
 *   2. Update itu terjadi SEBELUM pemanggilan engineBus.start().
 *   3. Query update dibatasi `stop_reason = 'expired'` — bot dengan
 *      stop_reason lain (mis. 'logout') tidak ikut di-reset (mereka punya
 *      alasan lain untuk mati).
 *   4. Pola yang sama juga ada di adminTopupKuota (penanda top-up kuota).
 *
 * Jalankan: node test/stop-reason-bayar.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const base = path.join(__dirname, '..');
const billing = fs.readFileSync(path.join(base, 'controllers/billingController.js'), 'utf8');

// ── 1. terapkanPaket: reset stop_reason ──────────────────────────────────────
console.log('=== 1. terapkanPaket: UPDATE stop_reason = NULL ===');
// Ambil blok dari deklarasi 'matiKarenaPaket' (baris `const [...] = await
// pool.execute`) sampai .catch pertama. Komentar di atas mungkin menyebut
// "engineBus.start" — jadi kita match dengan konteks yang unik: "UPDATE bots
// SET stop_reason = NULL" HARUS muncul di dalam blok.
const idxDec = billing.indexOf("const [matiKarenaPaket]");
assert.ok(idxDec >= 0, "deklarasi 'const [matiKarenaPaket]' tidak ditemukan");
const idxCatch = billing.indexOf('.catch(', idxDec);
assert.ok(idxCatch > idxDec, ".catch setelah deklarasi tidak ditemukan");
const blok = billing.slice(idxDec, idxCatch);

// Update harus di antara SELECT dan pemanggilan engineBus.start
const idxSelect  = blok.search(/SELECT id FROM bots[\s\S]{0,200}?stop_reason\s*=\s*'expired'/);
const idxUpdate  = blok.search(/UPDATE bots SET stop_reason\s*=\s*NULL/i);
const idxStart    = blok.search(/engineBus\W+start\(/);

assert.ok(idxSelect >= 0, 'SELECT stop_reason=expired tidak ditemukan di blok');
assert.ok(idxUpdate >= 0, 'UPDATE stop_reason=NULL tidak ditemukan di blok');
assert.ok(idxStart  >= 0, 'engineBus.start tidak ditemukan di blok');
assert.ok(idxUpdate > idxSelect,
  'UPDATE stop_reason=NULL muncul SEBELUM SELECT — urutannya salah');
assert.ok(idxUpdate < idxStart,
  'UPDATE stop_reason=NULL muncul SETELAH engineBus.start — reset harus dulu, baru start');
console.log('✅ UPDATE stop_reason=NULL ada di antara SELECT dan engineBus.start');

// ── 2. Query update punya filter stop_reason = 'expired' ────────────────────
console.log('\n=== 2. WHERE stop_reason = "expired" (bukan reset semua) ===');
// Update yang kita tambahkan: "UPDATE bots SET stop_reason = NULL WHERE ... AND stop_reason = 'expired'"
assert.ok(/UPDATE\s+bots\s+SET\s+stop_reason\s*=\s*NULL[\s\S]{0,200}?AND\s+stop_reason\s*=\s*'expired'/i.test(blok),
  'UPDATE tidak difilter stop_reason=expired — bisa reset bot yang mati karena alasan lain');
console.log('✅ UPDATE dibatasi stop_reason=\'expired\' (aman untuk bot logout/dll)');

// ── 3. Pola sama di adminTopupKuota (sebelumnya sudah ada) ───────────────────
console.log('\n=== 3. Pola sama di adminTopupKuota (referensi) ===');
assert.ok(/adminTopupKuota[\s\S]{0,1500}?UPDATE\s+bots\s+SET\s+stop_reason\s*=\s*NULL[\s\S]{0,200}?AND\s+stop_reason\s*=\s*'expired'/i.test(billing),
  'adminTopupKuota: pola UPDATE stop_reason=NULL WHERE stop_reason=expired tidak ada');
console.log('✅ adminTopupKuota masih pakai pola yang sama');

// ── 4. Reset terjadi saat user bayar, BUKAN saat startBot manual ────────────
console.log('\n=== 4. Reset ada di jalur pembayaran (bukan andalkan startBot) ===');
// Pola kita ada di billingController. engineBus.start ada di whatsappEngine,
// yang juga reset stop_reason (line 319). Itu boleh — defense in depth — tapi
// jalur pembayaran TIDAK boleh hanya andalkan reset di engine.
const adaDiBilling = idxUpdate >= 0;
assert.ok(adaDiBilling,
  'reset stop_reason HILANG dari billingController — andalkan engineBus.start saja');
console.log('✅ reset ada di billing (defense in depth)');

console.log('\nsemua ok — stop_reason reset terkunci');
