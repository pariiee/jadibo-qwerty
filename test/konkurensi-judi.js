'use strict';
/**
 * test/konkurensi-judi.js — tes konkurensi Cluster B (slot & gacha).
 *
 * Kenapa perlu: slot & gacha dulu baca `member.money` → hitung hasil →
 * `updateMember({money})`. Dua request bersamaan bisa dua kali lolos cek
 * saldo → saldo negatif / dapat item gratis. Sekarang keduanya lewat
 * `updateMoneyDelta` (kunci baris, cek saldo atomik).
 *
 * Yang diuji:
 *   1. Slot: 200× taruhan 100 paralel dari saldo 10.000 → saldo TIDAK
 *      pernah negatif, dan jumlah yang lolos × 100 ≤ saldo awal.
 *   2. Gacha: pola sama, taruhan 50.
 *   3. Saldo akhir = saldo awal - (jumlah sukses × biaya) + (total hadiah).
 *      Diuji lewat helper langsung supaya deterministik.
 *
 * Butuh DB_NAME_TEST; kalau kosong → SKIP (exit 0).
 * Jalankan: node test/konkurensi-judi.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const R = path.join(__dirname, '..');
// dotenv menangani CRLF dengan benar; regex manual gagal karena `.` tidak
// cocok dengan `\r` sehingga semua baris ter-skip dan nilai jatuh ke default.
try { require('dotenv').config({ path: path.join(R, '.env'), quiet: true }); } catch {}

const HOST = process.env.DB_HOST || 'localhost';
const PORT = Number(process.env.DB_PORT || 3306);
const DB_PRODUKSI = process.env.DB_NAME || 'yaaparbot';
const DB_TES = process.env.DB_NAME_TEST || '';

console.log('=== Tes konkurensi Cluster B: slot & gacha ===\n');
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

(async () => {
  if (!(await cekReachable())) {
    console.log(`⏭  SKIP: MySQL ${HOST}:${PORT} tidak reachable.`);
    process.exit(0);
  }

  const { pool } = require('../config/database');
  const { updateMoneyDelta } = require('../plugins/03-fun-rpg');
  const botId = 999100;
  const userId = 999101;
  const jid = `${userId}@s.whatsapp.net`;

  try {
    await pool.execute('DELETE FROM rpg_members WHERE bot_id = ?', [botId]);
    await pool.execute('DELETE FROM bots WHERE id = ?', [botId]);
    await pool.execute('DELETE FROM users WHERE id = ?', [userId]);
    await pool.execute("INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, 'user')",
      [userId, 'test_judi', crypto.randomBytes(8).toString('hex')]);
    await pool.execute('INSERT INTO bots (id, user_id, platform, bot_name, prefix) VALUES (?, ?, ?, ?, ?)',
      [botId, userId, 'whatsapp', 'test_judi', '.']);
    await pool.execute('INSERT INTO rpg_members (bot_id, jid, money, registered) VALUES (?, ?, 10000, 1)',
      [botId, jid]);

    const saldo = async () => {
      const [[r]] = await pool.execute('SELECT money FROM rpg_members WHERE bot_id=? AND jid=?', [botId, jid]);
      return Number(r.money);
    };

    // ── 1. Slot: 200× taruhan 100 paralel dari saldo 10.000 ────────────────
    // Slot = -100 + hadiah. Di sini kita modelkan hadiah 0 (kasus terburuk)
    // supaya yang diuji murni: 200 request TIDAK boleh bikin saldo negatif.
    console.log('=== 1. Slot: 200× taruhan 100 (hadiah 0) dari saldo 10.000 ===');
    const N1 = 200, BIAYA = 100;
    const hasil1 = await Promise.all(
      Array.from({ length: N1 }, () => updateMoneyDelta(botId, jid, -BIAYA))
    );
    const sukses1 = hasil1.filter((r) => r.ok).length;
    const saldo1 = await saldo();
    console.log(`  sukses: ${sukses1} (maks seharusnya 100), saldo: ${saldo1}`);
    assert.ok(saldo1 >= 0, `saldo NEGATIF: ${saldo1}`);
    assert.strictEqual(sukses1, 100, `harus tepat 100 sukses (10.000/100), dapat ${sukses1}`);
    assert.strictEqual(saldo1, 0, `saldo harus 0, dapat ${saldo1}`);
    console.log(`✅ tepat ${sukses1} sukses, saldo 0, tidak pernah negatif`);

    // ── 2. Gacha: 300× taruhan 50 dari saldo 5.000 ─────────────────────────
    console.log('\n=== 2. Gacha: 300× taruhan 50 dari saldo 5.000 ===');
    await pool.execute('UPDATE rpg_members SET money = 5000 WHERE bot_id=? AND jid=?', [botId, jid]);
    const N2 = 300, BIAYA2 = 50;
    const hasil2 = await Promise.all(
      Array.from({ length: N2 }, () => updateMoneyDelta(botId, jid, -BIAYA2))
    );
    const sukses2 = hasil2.filter((r) => r.ok).length;
    const saldo2 = await saldo();
    console.log(`  sukses: ${sukses2} (maks seharusnya 100), saldo: ${saldo2}`);
    assert.strictEqual(sukses2, 100, `harus tepat 100 sukses (5.000/50), dapat ${sukses2}`);
    assert.strictEqual(saldo2, 0, `saldo harus 0, dapat ${saldo2}`);
    console.log(`✅ tepat ${sukses2} sukses, saldo 0`);

    // ── 3. Slot dengan hadiah: campuran ±paralel, total konsisten ──────────
    console.log('\n=== 3. Slot campuran: 100× (-100 lalu +hadiah) paralel ===');
    await pool.execute('UPDATE rpg_members SET money = 10000 WHERE bot_id=? AND jid=?', [botId, jid]);
    const operasi = [];
    let totalDiharapkan = 10000;
    for (let i = 0; i < 100; i++) {
      const menang = Math.floor(Math.random() * 6) * 100;  // 0..500
      totalDiharapkan += -100 + menang;
      operasi.push(async () => {
        const r = await updateMoneyDelta(botId, jid, -100);
        if (r.ok && menang > 0) await updateMoneyDelta(botId, jid, menang);
        return r.ok;
      });
    }
    await Promise.all(operasi.map((f) => f()));
    const saldo3 = await saldo();
    console.log(`  saldo akhir: ${saldo3} (harap ${totalDiharapkan})`);
    assert.strictEqual(saldo3, totalDiharapkan,
      `slot campuran tidak konsisten: ${saldo3} != ${totalDiharapkan}`);
    console.log('✅ saldo konsisten dengan jumlah operasi');

    console.log('\n🎉 SEMUA TES KONKURENSI CLUSTER B LOLOS');
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
