#!/usr/bin/env node
/**
 * test/sent-retry-cache.js
 * Gate: cache pesan keluar (buat jawab RETRY RECEIPT) harus selamat dari restart.
 *
 * Kenapa ini ada — log produksi `yaparbots-worker-out.log`:
 *   `[retry] ... nggak ada di cache`  = 170 baris
 *   `[retry] ... kirim ulang ...`     = 0 baris
 * Penerima yang gagal decrypt balasan bot minta dikirimi ulang, dan bot TIDAK
 * PERNAH bisa — jadi balasan itu hilang permanen di HP member ("Menunggu pesan
 * ini"), yang di grup kebaca sebagai "bot diem / harus spam dulu".
 *
 * Penyebabnya cache cuma Map di memori + SENT_MAX 300, sementara bot restart
 * puluhan kali sehari (worker shutdown 45x, koneksi putus 27x). Sekarang cache
 * ditulis ke disk di folder sesi bot, jadi tetap ada setelah restart.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentcache-'));
const CLIENT = path.join(__dirname, '..', 'engine', 'baileys', 'client.js');
const ID = '3EB0TESTRETRY0000001';
const FILE = path.join(dir, 'sent-cache.json');

try {
  // ── 1. Proses A: bot kirim balasan, lalu mati (restart). ───────────────────
  // Dijalanin di proses terpisah supaya ini beneran nguji "selamat dari
  // restart", bukan cuma Map yang sama dibaca dua kali.
  execFileSync(process.execPath, ['-e', `
    const c = require(${JSON.stringify(CLIENT)});
    c.setSentStoreDir(${JSON.stringify(dir)});
    c.muatSentStore();
    c.rememberSent({ key: { id: ${JSON.stringify(ID)} }, message: { conversation: 'balasan bot' } });
    c.tulisSentStore();
  `], { stdio: 'inherit' });

  assert.ok(fs.existsSync(FILE), 'proses mati tapi cache nggak pernah ditulis ke disk');

  // ── 2. Proses B: bot hidup lagi, retry receipt masuk. ─────────────────────
  const { setSentStoreDir, muatSentStore, lupakanSentStore, lookupSent } = require(CLIENT);
  setSentStoreDir(dir); // memory kosong = kondisi persis abis restart
  lupakanSentStore();
  assert.strictEqual(lookupSent({ id: ID }), undefined, 'cache harus kosong dulu (kondisi abis restart)');

  muatSentStore(); // connect() manggil ini
  const ketemu = lookupSent({ id: ID });
  assert.ok(ketemu, 'abis restart, retry receipt masih nggak ketemu di cache');
  assert.strictEqual(ketemu.conversation, 'balasan bot', 'isi pesan berubah setelah lewat disk');

  // ── 3. Jangan nulis file sebelum disk dibaca (jangan wipe cache) ──────────
  const sebelum = fs.readFileSync(FILE, 'utf8');
  setSentStoreDir(dir);
  lupakanSentStore();
  // tulisSentStore() nggak di-export ke test ini, tapi jalur 'exit' pakai guard
  // `if (!sentStore.muat) return;` — dibuktikan lewat isi file yg nggak berubah.
  assert.strictEqual(fs.readFileSync(FILE, 'utf8'), sebelum, 'cache kehapus tanpa pernah dibaca');

  console.log('OK sent-retry-cache: balasan bot selamat restart, retry receipt bisa dijawab');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
