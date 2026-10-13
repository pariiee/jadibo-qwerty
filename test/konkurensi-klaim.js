'use strict';
/**
 * test/konkurensi-klaim.js — tes konkurensi Cluster A (klaim ber-cooldown).
 *
 * Kenapa perlu: claim/hourly/weekly/dailymisi/mancing/kerja/gajian dulu
 * `cek last_x` di JS → hitung reward → `UPDATE`. Dua request bersamaan
 * dua-duanya lolos cek → reward dobel. Sudah diganti UPDATE bersyarat
 * (klaimBerkala / klaimBerEnergi); tes ini membuktikan tidak dobel.
 *
 * Yang diuji:
 *   1. klaimBerkala: 50× paralel → TEPAT 1 menang (affectedRows=1).
 *   2. klaimBerkala: money naik sekali saja; last_x ter-set.
 *   3. klaimBerEnergi: energi kurang → 0 menang (tidak ada yang berubah).
 *   4. klaimBerEnergi: 50× paralel dari energi cukup → tepat 1 menang,
 *      energi terpotong SEKALI (bukan 50×).
 *   5. klaimBerEnergi: energi tidak pernah negatif.
 *
 * Butuh DB_NAME_TEST; kalau kosong → SKIP (exit 0).
 * Jalankan: node test/konkurensi-klaim.js
 */
const assert = require('assert');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const R = path.join(__dirname, '..');
try { require('dotenv').config({ path: path.join(R, '.env'), quiet: true }); } catch {}

const HOST = process.env.DB_HOST || 'localhost';
const PORT = Number(process.env.DB_PORT || 3306);
const DB_PRODUKSI = process.env.DB_NAME || 'yaaparbot';
const DB_TES = process.env.DB_NAME_TEST || '';

console.log('=== Tes konkurensi Cluster A: klaim ber-cooldown ===\n');
console.log(`DB produksi : ${DB_PRODUKSI}`);
console.log(`DB tes      : ${DB_TES || '(kosong)'}`);
if (!DB_TES) {
  console.log('\n⏭  SKIP: DB_NAME_TEST belum diisi. Tes ini tidak jalan di DB produksi.');
  process.exit(0);
}
if (DB_TES === DB_PRODUKSI) {
  console.error('\n❌ GAGAL: DB_NAME_TEST sama dengan DB_NAME.');
  process.exit(1);
}
process.env.DB_NAME = DB_TES;
console.log(`✅ pakai DB tes: ${DB_TES}\n`);

function cekReachable() {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(2000);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => { s.destroy(); resolve(false); });
    s.connect(PORT, HOST);
  });
}

const JAM = 3600 * 1000;

(async () => {
  if (!(await cekReachable())) {
    console.log(`⏭  SKIP: MySQL ${HOST}:${PORT} tidak reachable.`);
    process.exit(0);
  }

  const { pool } = require('../config/database');
  const { klaimBerkala, klaimBerEnergi } = require('../plugins/03-fun-rpg');
  const botId = 999200;
  const userId = 999201;
  const jid = `${userId}@s.whatsapp.net`;

  const ambil = async () => {
    const [[r]] = await pool.execute(
      'SELECT money, energi, last_hourly, last_kerja FROM rpg_members WHERE bot_id=? AND jid=?',
      [botId, jid]
    );
    return r;
  };

  try {
    await pool.execute('DELETE FROM rpg_members WHERE bot_id = ?', [botId]);
    await pool.execute('DELETE FROM bots WHERE id = ?', [botId]);
    await pool.execute('DELETE FROM users WHERE id = ?', [userId]);
    await pool.execute("INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, 'user')",
      [userId, 'test_klaim', crypto.randomBytes(8).toString('hex')]);
    await pool.execute('INSERT INTO bots (id, user_id, platform, bot_name, prefix) VALUES (?, ?, ?, ?, ?)',
      [botId, userId, 'whatsapp', 'test_klaim', '.']);
    await pool.execute(
      'INSERT INTO rpg_members (bot_id, jid, money, energi, registered) VALUES (?, ?, 1000, 100, 1)',
      [botId, jid]
    );

    // ── 1. klaimBerkala: 50× paralel → tepat 1 menang ──────────────────────
    console.log('=== 1. klaimBerkala: 50× paralel (reward +500) ===');
    const N = 50;
    const hasil = await Promise.all(
      Array.from({ length: N }, () => klaimBerkala(botId, jid, 'last_hourly', JAM, { money: 500 }))
    );
    const menang = hasil.filter(Boolean).length;
    console.log(`  menang: ${menang} (harus tepat 1)`);
    assert.strictEqual(menang, 1, `harus tepat 1 menang, dapat ${menang} — reward bisa dobel!`);

    const s1 = await ambil();
    console.log(`  money: ${s1.money} (harus 1500), last_hourly: ${s1.last_hourly ? 'ter-set' : 'KOSONG'}`);
    assert.strictEqual(Number(s1.money), 1500, `money harus 1500, dapat ${s1.money}`);
    assert.ok(s1.last_hourly, 'last_hourly harus ter-set');
    console.log('✅ tepat 1 menang, money naik sekali');

    // ── 2. klaimBerkala lagi setelah cooldown lewat (manipulasi last_x) ───
    console.log('\n=== 2. klaimBerkala lagi setelah cooldown lewat ===');
    await pool.execute('UPDATE rpg_members SET last_hourly = NULL WHERE bot_id=? AND jid=?', [botId, jid]);
    const lagi = await klaimBerkala(botId, jid, 'last_hourly', JAM, { money: 500 });
    const s2 = await ambil();
    assert.strictEqual(lagi, true, 'setelah cooldown lewat harus bisa klaim');
    assert.strictEqual(Number(s2.money), 2000, `money harus 2000, dapat ${s2.money}`);
    console.log('✅ klaim berikutnya menambah money lagi');

    // ── 3. klaimBerEnergi: energi kurang → 0 menang ────────────────────────
    console.log('\n=== 3. klaimBerEnergi: energi kurang → 0 menang ===');
    await pool.execute('UPDATE rpg_members SET energi = 5, last_kerja = NULL, money = 1000 WHERE bot_id=? AND jid=?', [botId, jid]);
    const gagal = await klaimBerEnergi(botId, jid, {
      kolomWaktu: 'last_kerja', ambangMs: JAM, biayaEnergi: 25, energiBaru: -20,
      tambah: { money: 100 },
    });
    const s3 = await ambil();
    assert.strictEqual(gagal, false, 'energi kurang harus gagal');
    assert.strictEqual(Number(s3.money), 1000, 'money tidak boleh berubah');
    assert.strictEqual(Number(s3.energi), 5, 'energi tidak boleh berubah');
    console.log('✅ energi kurang: 0 menang, tidak ada yang berubah');

    // ── 4. klaimBerEnergi: 50× paralel → tepat 1, energi -25 ───────────────
    console.log('\n=== 4. klaimBerEnergi: 50× paralel (energi 100, biaya 25) ===');
    await pool.execute('UPDATE rpg_members SET energi = 100, last_kerja = NULL, money = 1000 WHERE bot_id=? AND jid=?', [botId, jid]);
    const hasil4 = await Promise.all(
      Array.from({ length: 50 }, () => klaimBerEnergi(botId, jid, {
        kolomWaktu: 'last_kerja', ambangMs: JAM, biayaEnergi: 25, energiBaru: 75,
        tambah: { money: 100 },
      }))
    );
    const menang4 = hasil4.filter(Boolean).length;
    const s4 = await ambil();
    console.log(`  menang: ${menang4}, energi: ${s4.energi}, money: ${s4.money}`);
    assert.strictEqual(menang4, 1, `harus tepat 1 menang, dapat ${menang4}`);
    assert.strictEqual(Number(s4.energi), 75, `energi harus 75 (dipotong SEKALI), dapat ${s4.energi}`);
    assert.strictEqual(Number(s4.money), 1100, `money harus 1100, dapat ${s4.money}`);
    console.log('✅ energi terpotong sekali, money naik sekali');

    // ── 5. Energi tidak pernah negatif walau dispam ────────────────────────
    console.log('\n=== 5. Energi tidak negatif walau dispam ===');
    await pool.execute('UPDATE rpg_members SET energi = 30, last_kerja = NULL WHERE bot_id=? AND jid=?', [botId, jid]);
    await Promise.all(Array.from({ length: 20 }, () => klaimBerEnergi(botId, jid, {
      kolomWaktu: 'last_kerja', ambangMs: JAM, biayaEnergi: 25, energiBaru: 5,
      tambah: { money: 0 },
    })));
    const s5 = await ambil();
    console.log(`  energi akhir: ${s5.energi}`);
    assert.ok(Number(s5.energi) >= 0, `energi NEGATIF: ${s5.energi}`);
    console.log('✅ energi tetap >= 0');

    console.log('\n🎉 SEMUA TES KONKURENSI CLUSTER A LOLOS');
  } catch (e) {
    console.error('❌', e.message);
    process.exit(1);
  } finally {
    try {
      const { pool } = require('../config/database');
      await pool.execute('DELETE FROM rpg_members WHERE bot_id = ?', [botId]);
      await pool.execute('DELETE FROM bots WHERE id = ?', [botId]);
      await pool.execute('DELETE FROM users WHERE id = ?', [userId]);
      await pool.end();
    } catch {}
  }
})();
