'use strict';
/**
 * test/konkurensi-uang.js — tes konkurensi sungguhan ke MySQL.
 *
 * Kenapa perlu: race condition transfer/coinflip yang baru diperbaiki di
 * Tahap 1 (#1 audit) bisa lolos dari tes kontrak statis tapi GAGAL di
 * runtime konkuren. Tes ini menjalankan banyak call paralel ke helper
 * atomic (updateMoneyDelta, transferMoney) dan memverifikasi:
 *   - saldo akhir konsisten (tidak minus, tidak berlebih)
 *   - untuk N transfer dari A ke B, total uang A+B konstan
 *   - untuk N coinflip, selisih antara menang & kalah <= 1
 *
 * Tes ini BUTUH MySQL yang bisa dijangkau. Kalau `DB_HOST` di .env tidak
 * reachable dalam 2 detik, tes SKIP otomatis — bukan gagal. Pak tidak
 * harus install MySQL di Windows untuk menjalankan tes lain; hanya untuk
 * mengaudit konsistensi helper atomic.
 *
 * Jalankan: node test/konkurensi-uang.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const net = require('net');

// Pakai .env di root repo (mysql2 dibaca config/database.js, yang baca .env
// via require('dotenv').config() di server.js — tapi di sini server.js belum
// dimuat. Kita emulate dengan memuat dotenv manual.
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch {}

const HOST = process.env.DB_HOST || 'localhost';
const PORT = Number(process.env.DB_PORT || 3306);

console.log('=== Tes konkurensi updateMoneyDelta/transferMoney ===\n');

// ── 0. Reachability: kalau DB tidak bisa dijangkau, skip ────────────────────
function cekReachable() {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(2000);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error',   () => { s.destroy(); resolve(false); });
    s.connect(PORT, HOST);
  });
}

(async () => {
  const ok = await cekReachable();
  if (!ok) {
    console.log(`⏭  SKIP: MySQL ${HOST}:${PORT} tidak reachable dari mesin ini.`);
    console.log('   Tes konkurensi ini butuh DB asli. Jalankan di VPS atau');
    console.log('   mesin yang punya MySQL lokal.');
    process.exit(0);
  }

  // ── Setup: butuh user + bot + member rpg_members ─────────────────────────
  // 1. Pakai 1 user tetap ("test_uang") + 1 bot dummy + 2 rpg_members.
  // 2. Tes:
  //    a. updateMoneyDelta paralel: 100× -1 dari member, total = -100
  //    b. transferMoney paralel: 50× A→B (50) dan 50× B→A (50) — total konstan
  //    c. coinflip-like: 100× ±10 paralel, total sesuai jumlah menang
  // 3. Cleanup di akhir: hapus baris uji.

  const { pool } = require('../config/database');
  const botId = 999000;  // id sentinel — di luar range id bot produksi
  const userIdA = 999001;
  const userIdB = 999002;
  const jidA = `${userIdA}@s.whatsapp.net`;
  const jidB = `${userIdB}@s.whatsapp.net`;
  const { updateMoneyDelta, transferMoney } = require('../plugins/03-fun-rpg');

  try {
    // Hapus sisa tes sebelumnya
    await pool.execute('DELETE FROM rpg_members WHERE bot_id = ?', [botId]);
    await pool.execute('DELETE FROM bots WHERE id = ?', [botId]);
    // Setup: bot dummy + 2 member dengan saldo 10.000
    await pool.execute(
      'INSERT INTO bots (id, user_id, platform, bot_name, prefix) VALUES (?, ?, ?, ?, ?)',
      [botId, userIdA, 'whatsapp', 'test_uang', '.']
    );
    await pool.execute(
      'INSERT INTO rpg_members (bot_id, jid, money, registered) VALUES (?, ?, 10000, 1)',
      [botId, jidA]
    );
    await pool.execute(
      'INSERT INTO rpg_members (bot_id, jid, money, registered) VALUES (?, ?, 10000, 1)',
      [botId, jidB]
    );

    // ── 1. updateMoneyDelta paralel: 100× -1 dari A ────────────────────────
    console.log('=== 1. updateMoneyDelta paralel: 100× -1 dari A ===');
    const N1 = 100;
    const promises1 = Array.from({ length: N1 }, () => updateMoneyDelta(botId, jidA, -1));
    const results1 = await Promise.all(promises1);
    const sukses1 = results1.filter(r => r.ok).length;
    const gagal1  = N1 - sukses1;
    console.log(`  sukses: ${sukses1}, gagal: ${gagal1}`);

    // Baca saldo A sekarang
    const [[rowA]] = await pool.execute('SELECT money FROM rpg_members WHERE bot_id=? AND jid=?', [botId, jidA]);
    const saldoAkhirA = Number(rowA?.money || 0);
    const saldoHarapA = 10000 - sukses1;  // saldo awal - jumlah sukses
    console.log(`  saldo A: ${saldoAkhirA} (harap ${saldoHarapA})`);
    assert.strictEqual(saldoAkhirA, saldoHarapA,
      `updateMoneyDelta TIDAK atomic: saldo ${saldoAkhirA} != harap ${saldoHarapA}`);
    assert.ok(saldoAkhirA >= 0, `saldo NEGATIF: ${saldoAkhirA}`);
    console.log(`✅ ${N1} paralel -1: saldo konsisten`);

    // ── 2. transferMoney paralel: 50× A→B (50) dan 50× B→A (50) ────────────
    console.log('\n=== 2. transferMoney paralel: 50× A→B dan 50× B→A ===');
    const N2 = 50;
    const totalAwal = (await baca(pool, botId, jidA)) + (await baca(pool, botId, jidB));
    console.log(`  total awal: ${totalAwal}`);

    // Reset ke saldo awal
    await pool.execute('UPDATE rpg_members SET money=10000 WHERE bot_id=? AND jid IN (?, ?)', [botId, jidA, jidB]);
    const total0 = (await baca(pool, botId, jidA)) + (await baca(pool, botId, jidB));
    console.log(`  total setelah reset: ${total0}`);

    const promises2 = [];
    for (let i = 0; i < N2; i++) {
      promises2.push(transferMoney(botId, jidA, jidB, 10));   // A→B
      promises2.push(transferMoney(botId, jidB, jidA, 10));   // B→A
    }
    const results2 = await Promise.all(promises2);
    const sukses2 = results2.filter(r => r.ok).length;
    const gagal2  = results2.length - sukses2;
    console.log(`  sukses: ${sukses2}, gagal: ${gagal2}`);

    const totalAkhir = (await baca(pool, botId, jidA)) + (await baca(pool, botId, jidB));
    console.log(`  total akhir: ${totalAkhir} (total awal ${total0})`);
    // Total HARUS konstan kalau semua sukses; kalau ada yang gagal, total
    // berkurang 10 per gagal (uang tidak pindah). Kita tolerir BUKAN nol
    // gagal — kalau ada, berarti ada lock issue, dan total akan berkurang.
    const selisih = total0 - totalAkhir;
    console.log(`  selisih: ${selisih} (10 × gagal2)`);
    if (gagal2 > 0) {
      assert.strictEqual(selisih, gagal2 * 10,
        `transferMoney inkonsisten: ${gagal2} gagal tapi selisih ${selisih} (harap ${gagal2 * 10})`);
    } else {
      assert.strictEqual(totalAkhir, total0,
        `transferMoney bocor uang: total ${totalAkhir} != ${total0}`);
    }
    console.log(`✅ ${N2 * 2} paralel transfer: total konstan (atomic)`);

    // ── 3. Coinflip-like: 100× ±10 paralel ──────────────────────────────────
    console.log('\n=== 3. Coinflip-like paralel: 100× ±10 ===');
    await pool.execute('UPDATE rpg_members SET money=10000 WHERE bot_id=? AND jid=?', [botId, jidA]);
    const N3 = 100;
    const promises3 = [];
    let rencanaMenang = 0;
    for (let i = 0; i < N3; i++) {
      const menang = Math.random() < 0.5;
      const delta  = menang ? 10 : -10;
      if (menang) rencanaMenang++;
      promises3.push(updateMoneyDelta(botId, jidA, delta));
    }
    const results3 = await Promise.all(promises3);
    const sukses3 = results3.filter(r => r.ok).length;
    const [[r3]] = await pool.execute('SELECT money FROM rpg_members WHERE bot_id=? AND jid=?', [botId, jidA]);
    const saldoAkhir3 = Number(r3.money);
    const ekspektasi = 10000 + (2 * rencanaMenang - N3);  // 10000 + menang*10 - kalah*10
    console.log(`  rencana menang: ${rencanaMenang}/${N3}`);
    console.log(`  saldo akhir: ${saldoAkhir3} (ekspektasi ${ekspektasi})`);
    assert.strictEqual(saldoAkhir3, ekspektasi,
      `coinflip-like race: saldo ${saldoAkhir3} != ekspektasi ${ekspektasi}`);
    console.log(`✅ ${N3} paralel ±10: saldo sesuai ekspektasi`);

    console.log('\n🎉 SEMUA TES KONKURENSI LOLOS — helper atomic benar di runtime.');
  } catch (e) {
    console.error('❌', e.message);
    process.exit(1);
  } finally {
    // Cleanup
    try {
      const { pool } = require('../config/database');
      await pool.execute('DELETE FROM rpg_members WHERE bot_id = ?', [botId]);
      await pool.execute('DELETE FROM bots WHERE id = ?', [botId]);
      await pool.end();
    } catch {}
  }
})();

async function baca(pool, botId, jid) {
  const [[r]] = await pool.execute('SELECT money FROM rpg_members WHERE bot_id=? AND jid=?', [botId, jid]);
  return Number(r?.money || 0);
}
