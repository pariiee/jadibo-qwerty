#!/usr/bin/env node
/**
 * test/limit-potong.js
 * Nguji PERILAKU potong limit sekarang: yang kepotong cuma role user, dan
 * saldo nggak bisa nembus negatif. Dites di DB sementara (CREATE DATABASE
 * tmp_xxx) — TIDAK nyentuh DB produksi.
 *
 * Dulu (`server.js` + engine) ada tiga lubang yang bikin `lim` kelihatan
 * nggak pernah berkurang:
 *   1. auto-register nulis `ON DUPLICATE KEY UPDATE ... lim = ?` -> saldo user
 *      lama balik ke default tiap kali dia kirim command
 *   2. `.limit` (perintah INFO) ikut masuk limitedCmds -> user kehabisan limit
 *      cuma gara-gara ngecek sisa limitnya (`.base64` kena masalah serupa:
 *      ada di limitedCmds tapi handler-nya cuma `case 'encode'`)
 *   3. pre-check `curLim <= 0` tanpa gerbang SQL `lim >= 1` -> bisa jadi negatif
 *
 * Catatan: SEMUA query di sini lewat SATU koneksi (`db`). `USE tmp_xxx` cuma
 * nempel di koneksi itu — kalau pakai pool, query berikutnya bisa nyasar ke DB
 * default dan nyisa baris uji `bot_id=9` di DB yang dipakai bot beneran.
 *
 * Jalankan: node test/limit-potong.js   (atau lewat `npm test`)
 */
'use strict';

const assert = require('assert');
const path   = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { pool } = require('../config/database');

// DB sementara — jangan pernah nyentuh DB yang dipakai bot.
const TMP = `tmp_limtest_${process.pid}`;
// Salinan SQL diekstrak dari engine, bukan ditulis ulang: kalau engine berubah,
// tes ini yang gagal — bukan diam-diam lolos.
const engine = require('fs').readFileSync(path.join(__dirname, '..', 'engine/whatsappEngine.js'), 'utf8');

function ambilPola(re) {
  const m = engine.match(re);
  assert.ok(m, `pola nggak ketemu di engine: ${re}`);
  return m[0];
}

const SQL_CEK      = ambilPola(/SELECT lim FROM rpg_members WHERE bot_id = \?[^']*/);
const SQL_POTONG   = ambilPola(/UPDATE rpg_members SET lim = lim - \?[^']*/);
const SQL_DUPLIKAT = ambilPola(/ON DUPLICATE KEY UPDATE name = VALUES\(name\), registered = 1(, lim = \?)?/);

// Koneksi tunggal untuk seluruh tes — lihat catatan di header.
let db = null;

let lulus = 0;
async function cek(nama, fn) {
  try { await fn(); lulus++; console.log(`  \u2705 ${nama}`); }
  catch (e) { console.error(`  \u274c ${nama}\n     ${e.message}`); process.exitCode = 1; }
}

async function bisaKonek() {
  try {
    const c = await pool.getConnection();
    try { await c.query('SELECT 1'); } finally { c.release(); }
    return true;
  } catch (e) { return false; }
}

async function setup() {
  db = await pool.getConnection();
  await db.query(`DROP DATABASE IF EXISTS \`${TMP}\``);
  await db.query(`CREATE DATABASE \`${TMP}\``);
  await db.query(`USE \`${TMP}\``);
  await db.query(
    `CREATE TABLE rpg_members (
       id INT AUTO_INCREMENT PRIMARY KEY,
       bot_id INT NOT NULL, jid VARCHAR(100) NOT NULL,
       name VARCHAR(100) NULL, level INT NOT NULL DEFAULT 0,
       xp BIGINT NOT NULL DEFAULT 0, money BIGINT NOT NULL DEFAULT 0,
       lim INT NOT NULL DEFAULT 100, healt INT NOT NULL DEFAULT 100,
       registered TINYINT NOT NULL DEFAULT 0, premium TINYINT NOT NULL DEFAULT 0
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
}

/** Jalankan gate potong limit persis seperti engine. */
async function potong(role, command, isLimited = true, satuan = 1) {
  if (!['user'].includes(role) || !isLimited) return 'skip';
  const [rows] = await db.execute(SQL_CEK, [9, 'a@s.whatsapp.net']);
  const cur = rows[0]?.lim ?? 0;
  if (cur < satuan) return 'habis';
  await db.execute(SQL_POTONG, [satuan, 9, 'a@s.whatsapp.net', satuan]);
  return 'potong';
}
const lim = async () => (await db.execute('SELECT lim FROM rpg_members WHERE bot_id=9 AND jid=?', ['a@s.whatsapp.net']))[0][0]?.lim;

(async () => {
  console.log('test/limit-potong.js  (DB sementara, bukan DB produksi)');
  if (!await bisaKonek()) {
    console.log('  \u23ed\ufe0f  dilewati: MySQL lokal nggak jalan (tes ini butuh DB)');
    await pool.end();
    return;
  }
  try {
    await setup();
    await db.execute('INSERT INTO rpg_members (bot_id, jid, name, registered, lim) VALUES (9, ?, ?, 1, 5)',
      ['a@s.whatsapp.net', 'Uji']);

    await cek('user: 5 limit → 3x command → sisa 2', async () => {
      assert.strictEqual(await potong('user', 'ai'), 'potong');
      assert.strictEqual(await potong('user', 'ai'), 'potong');
      assert.strictEqual(await potong('user', 'ai'), 'potong');
      assert.strictEqual(await lim(), 2);
    });

    await cek('dev & owner: limit nggak kesentuh', async () => {
      await db.execute('UPDATE rpg_members SET lim = 7 WHERE bot_id=9');
      assert.strictEqual(await potong('dev', 'ai'), 'skip');
      assert.strictEqual(await potong('owner', 'ai'), 'skip');
      assert.strictEqual(await potong('premium', 'ai'), 'skip');
      assert.strictEqual(await lim(), 7, 'limit kepotong padahal role-nya skip');
    });

    await cek('`.limit` (perintah info) nggak makan limit', async () => {
      const { buildLimitedCmds } = require('../engine/limitedCmds');
      assert.ok(!buildLimitedCmds().has('limit'),
        '`limit` balik masuk daftar yang kepotong — ngecek sisa limit malah ngurangin');
    });

    await cek('command yang nggak butuh limit: saldo tetap', async () => {
      assert.strictEqual(await potong('user', 'menu', false), 'skip');
      assert.strictEqual(await lim(), 7);
    });

    await cek('limit 0: ditolak, saldo nggak jadi -1', async () => {
      await db.execute('UPDATE rpg_members SET lim = 0 WHERE bot_id=9');
      assert.strictEqual(await potong('user', 'ai'), 'habis');
      assert.strictEqual(await lim(), 0);
    });

    await cek('dua command barengan di limit 1: cuma satu yang kepotong', async () => {
      await db.execute('UPDATE rpg_members SET lim = 1 WHERE bot_id=9');
      const hasil = await Promise.all([potong('user', 'ai'), potong('user', 'ai')]);
      assert.ok(hasil.includes('potong'), 'dua-duanya nggak potong');
      assert.strictEqual(await lim(), 0,
        `saldo jadi ${await lim()} — UPDATE tanpa gerbang \`lim >= ?\` nembus negatif`);
    });

    await cek('auto-register user lama: saldo TIDAK balik ke default', async () => {
      await db.execute('UPDATE rpg_members SET lim = 3 WHERE bot_id=9');
      // ini INSERT yang jalan tiap command (gerbang registrasi di engine)
      await db.execute(
        `INSERT INTO rpg_members (bot_id, jid, name, registered, lim)
         VALUES (9, ?, ?, 1, 20) ${SQL_DUPLIKAT}`,
        ['a@s.whatsapp.net', 'Uji Baru']
      );
      assert.strictEqual(await lim(), 3,
        'saldo user lama ke-reset ke default — ini yang bikin limit kelihatan nggak pernah berkurang');
    });

    await cek('auto-register user baru: dapat limit default', async () => {
      await db.execute(
        `INSERT INTO rpg_members (bot_id, jid, name, registered, lim)
         VALUES (9, ?, ?, 1, 20) ${SQL_DUPLIKAT}`,
        ['b@s.whatsapp.net', 'Baru']
      );
      const [r] = await db.execute('SELECT lim FROM rpg_members WHERE bot_id=9 AND jid=?', ['b@s.whatsapp.net']);
      assert.strictEqual(r[0].lim, 20, 'user baru nggak dapat limit default');
    });
  } catch (e) {
    console.error('  \u274c setup gagal:', e.message);
    process.exitCode = 1;
  } finally {
    if (db) {
      await db.query(`DROP DATABASE IF EXISTS \`${TMP}\``).catch(() => {});
      db.release();
    }
    console.log(`\n${lulus} lulus${process.exitCode ? ', ADA GAGAL' : ''}`);
    await pool.end();
  }
})();
