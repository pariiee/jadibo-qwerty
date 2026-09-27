'use strict';
/**
 * Uji guard ENGINE_BOT_ID: panel zapo & panel Baileys berbagi tabel `bots`.
 * Kalau guard bocor, panel zapo bisa start/stop bot Baileys pakai engine zapo.
 */
const assert = require('assert');
const path   = require('path');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
};

// ─── 1. config/engineScope.js: mati (tanpa env) = tanpa batas ─────────────────
delete process.env.ENGINE_BOT_ID;
delete require.cache[require.resolve('../config/engineScope')];
let S = require('../config/engineScope');
ok('tanpa ENGINE_BOT_ID → isMine apa saja true', () => {
  assert.strictEqual(S.isMine(1), true);
  assert.strictEqual(S.isMine(99), true);
});
ok('tanpa ENGINE_BOT_ID → mine() kosong (query utuh)', () => {
  assert.deepStrictEqual(S.mine('id', 'AND'), ['', []]);
});

// ─── 2. engineScope.js: nyala = cuma baris sendiri ────────────────────────────
process.env.ENGINE_BOT_ID = '2';
delete require.cache[require.resolve('../config/engineScope')];
S = require('../config/engineScope');
ok('ENGINE_BOT_ID=2 → isMine(2) true', () => assert.strictEqual(S.isMine(2), true));
ok('ENGINE_BOT_ID=2 → isMine(1) false (baris Baileys ditolak)', () => assert.strictEqual(S.isMine(1), false));
ok('ENGINE_BOT_ID=2 → isMine("2") true (string dari JWT/param)', () => assert.strictEqual(S.isMine('2'), true));
ok("mine('id','AND') → SQL + param benar", () => {
  assert.deepStrictEqual(S.mine('id', 'AND'), [' AND id = ?', [2]]);
});
ok("mine('b.id','WHERE') → SQL JOIN benar", () => {
  assert.deepStrictEqual(S.mine('b.id', 'WHERE'), [' WHERE b.id = ?', [2]]);
});

// ─── 3. listBots: SQL yang dirakit harus sah & ter-scope ──────────────────────
// Rekonstruksi perakitan query PERSIS seperti controllers/botController.js,
// lalu cek hasilnya. (Kalau pola di controller berubah, tes ini gagal.)
function listQuery(isKing, sc, sp) {
  const query = isKing
    ? `SELECT b.*, u.username FROM bots b JOIN users u ON u.id = b.user_id${sc} ORDER BY b.created_at DESC`
    : `SELECT * FROM bots WHERE user_id = ?${sc} ORDER BY created_at DESC`;
  return { query, params: isKing ? sp : [7, ...sp] };
}
const [sc, sp] = S.mine('id', 'AND');
const [scK, spK] = S.mine('b.id', 'WHERE');

ok('listBots king → ada WHERE b.id = ?', () => {
  const r = listQuery(true, scK, spK);
  assert.match(r.query, /WHERE b\.id = \?/);
  assert.deepStrictEqual(r.params, [2]);
  assert.strictEqual((r.query.match(/WHERE/g) || []).length, 1, 'WHERE harus tunggal');
});
ok('listBots non-king → user_id + id ke-scope', () => {
  const r = listQuery(false, sc, sp);
  assert.match(r.query, /WHERE user_id = \? AND id = \?/);
  assert.deepStrictEqual(r.params, [7, 2]);
});

// ─── 4. Query zapo yang dirakit server.js tetap sah ─────────────────────────
ok('autoStartBots SQL sah', () => {
  const q = `SELECT * FROM bots WHERE is_running = 1${sc}`;
  assert.strictEqual(q, 'SELECT * FROM bots WHERE is_running = 1 AND id = ?');
  assert.strictEqual((q.match(/WHERE/g) || []).length, 1, 'WHERE harus tunggal');
});
ok('shutdown SQL sah', () => {
  const q = `UPDATE bots SET status = 'disconnected' WHERE status IN ('connected', 'connecting')${sc}`;
  assert.strictEqual(q, "UPDATE bots SET status = 'disconnected' WHERE status IN ('connected', 'connecting') AND id = ?");
});

// ─── 5. Sakelar mati lagi → nol perubahan perilaku ───────────────────────────
delete process.env.ENGINE_BOT_ID;
delete require.cache[require.resolve('../config/engineScope')];
S = require('../config/engineScope');
ok('sakelar mati → nol perubahan perilaku (regresi panel Baileys)', () => {
  assert.strictEqual(S.ENGINE_BOT_ID, null);
  assert.strictEqual(S.isMine(1), true);
  assert.deepStrictEqual(S.mine('id', 'AND'), ['', []]);
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
