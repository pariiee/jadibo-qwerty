'use strict';
/**
 * test/billing-wallet-live-db.js
 * Tes dengan MySQL asli (DB_NAME_TEST):
 * 1. Poin 2: user mengirim idempotency_key 'topup:<orderId>' -> ref terbentuk 'perpanjang:<userId>:topup:<orderId>'
 *    dan TIDAK menggagalkan kredit topup order itu di wallet_ledger.
 * 2. Poin 3: order ber-plan yang sudah tidak ada di pricing -> ditolak tandaiLunas, order diberi note 'paket gagal diterapkan'.
 * 3. Poin 4: adminAdjust memvalidasi order_id milik user, nilai negatif tidak bikin saldo < 0, alasan wajib,
 *    dan mencatat selisih nominal di orders.note.
 * 4. Poin 7 & 8: order topup yang di-adjust tidak bisa dikredit lagi lewat konfirmasi/webhook (saldo tidak bertambah 2x).
 */

require('dotenv').config({ quiet: true });
const mysql = require('mysql2/promise');
const assert = require('assert');
const path = require('path');

const DB_TEST = process.env.DB_NAME_TEST || 'yaaparbot_test';

(async () => {
  console.log(`=== Memulai pengujian live DB pada: ${DB_TEST} ===`);
  
  // Pastikan pool menggunakan DB_TEST
  process.env.DB_NAME = DB_TEST;
  const { pool } = require('../config/database');
  const billing = require('../controllers/billingController');
  const wallet = require('../controllers/walletController');

  // Bersihkan data tes terdahulu
  await pool.execute('DELETE FROM wallet_ledger WHERE user_id IN (99881, 99882)');
  await pool.execute('DELETE FROM orders WHERE user_id IN (99881, 99882)');
  await pool.execute('DELETE FROM users WHERE id IN (99881, 99882)');

  // Buat user tes
  await pool.execute(
    "INSERT INTO users (id, username, password, role, saldo) VALUES (99881, 'user_tes_1', 'hash', 'user', 50000), (99882, 'user_tes_2', 'hash', 'user', 0)"
  );

  console.log('\n--- 1. Poin 2: Key dengan teks "topup:TP123" pada perpanjang tidak bentrok dengan topup riil ---');
  // Topup order riil
  const orderIdTopup = 'TP-TEST-99881-A';
  await pool.execute(
    "INSERT INTO orders (order_id, user_id, plan, amount, status) VALUES (?, 99881, 'topup', 25000, 'pending')",
    [orderIdTopup]
  );
  
  // User mencoba memakai idempotency_key 'topup_TP-TEST-99881-A' di endpoint perpanjang
  // Format key valid: [A-Za-z0-9_-]{8,64}
  const keyPerpanjang = 'topup_TP-TEST-99881-A';
  const reqPerpanjang = {
    user: { id: 99881, username: 'user_tes_1' },
    body: { plan: 'basic', idempotency_key: keyPerpanjang }
  };
  let resJsonPerpanjang = null;
  const resPerpanjang = {
    status: (s) => ({ json: (j) => { resJsonPerpanjang = { status: s, ...j }; } }),
    json: (j) => { resJsonPerpanjang = { status: 200, ...j }; }
  };
  
  await wallet.perpanjang(reqPerpanjang, resPerpanjang);
  assert.strictEqual(resJsonPerpanjang.ok, true, 'Perpanjang harus berhasil');

  // Periksa ref yang tersimpan di wallet_ledger
  const [ledgerPerpanjang] = await pool.execute(
    'SELECT ref FROM wallet_ledger WHERE user_id = 99881 AND tipe = "perpanjang"'
  );
  assert.strictEqual(ledgerPerpanjang.length, 1);
  assert.strictEqual(ledgerPerpanjang[0].ref, `perpanjang:99881:${keyPerpanjang}`);
  console.log(`  ✓ Ref perpanjang tersimpan aman: ${ledgerPerpanjang[0].ref}`);

  // Sekarang lakukan tandaiLunas pada order topup sungguhan tersebut (ref: 'topup:TP-TEST-99881-A')
  await billing.tandaiLunas(orderIdTopup, { payment_reference_id: 'REF-TOPUP-1' });
  const [ledgerTopup] = await pool.execute(
    'SELECT ref FROM wallet_ledger WHERE user_id = 99881 AND tipe = "topup"'
  );
  assert.strictEqual(ledgerTopup.length, 1);
  assert.strictEqual(ledgerTopup[0].ref, `topup:${orderIdTopup}`);
  console.log(`  ✓ Ref topup tersimpan aman tanpa tabrakan: ${ledgerTopup[0].ref}`);

  console.log('\n--- 2. Poin 3: Order plan tidak ada di pricing -> ditolak & dicatat note ---');
  const orderIdHantu = 'ORD-HANTU-99882';
  await pool.execute(
    "INSERT INTO orders (order_id, user_id, plan, amount, status) VALUES (?, 99882, 'paket_ghaib', 50000, 'pending')",
    [orderIdHantu]
  );
  const hasilHantu = await billing.tandaiLunas(orderIdHantu, { payment_reference_id: 'PAY-HANTU' });
  assert.strictEqual(hasilHantu.sudah, false);
  assert.ok(hasilHantu.error.includes('paket_ghaib'));

  const [orderHantuRow] = await pool.execute(
    'SELECT status, note FROM orders WHERE order_id = ?',
    [orderIdHantu]
  );
  assert.strictEqual(orderHantuRow[0].status, 'pending', 'Status order tidak boleh jadi paid');
  assert.ok(orderHantuRow[0].note.includes('paket gagal diterapkan'), 'Note harus mencatat paket gagal diterapkan');
  console.log(`  ✓ Order plan hantu ditolak, note: "${orderHantuRow[0].note}"`);

  console.log('\n--- 3. Poin 4: adminAdjust validasi kepemilikan, saldo minus, dan selisih nominal ---');
  // Test 4a: Salah kepemilikan order
  let resAdj = null;
  const mockRes = () => ({
    status: (s) => ({ json: (j) => { resAdj = { status: s, ...j }; } }),
    json: (j) => { resAdj = { status: 200, ...j }; }
  });

  await wallet.adminAdjust({
    params: { userId: '99881' },
    user: { username: 'admin_bos' },
    body: { jumlah: 10000, alasan: 'tes salah order', order_id: orderIdHantu } // orderIdHantu milik 99882
  }, mockRes());
  assert.strictEqual(resAdj.status, 400);
  assert.strictEqual(resAdj.message, 'Order bukan milik user ini');
  console.log('  ✓ Menolak jika order_id bukan milik user');

  // Test 4b: Saldo minus ditolak
  await wallet.adminAdjust({
    params: { userId: '99882' },
    user: { username: 'admin_bos' },
    body: { jumlah: -10000, alasan: 'kurangi minus' } // saldo 99882 = 0
  }, mockRes());
  assert.strictEqual(resAdj.status, 400);
  assert.ok(resAdj.message.includes('Saldo tidak boleh minus'));
  console.log('  ✓ Menolak nilai penyesuaian yang membuat saldo negatif');

  // Test 4c: Alasan wajib
  await wallet.adminAdjust({
    params: { userId: '99882' },
    user: { username: 'admin_bos' },
    body: { jumlah: 5000, alasan: '' }
  }, mockRes());
  assert.strictEqual(resAdj.status, 400);
  assert.strictEqual(resAdj.message, 'Alasan wajib diisi');
  console.log('  ✓ Menolak penyesuaian tanpa alasan');

  // Test 4d: Penyesuaian berhasil dan mencatat selisih nominal
  const orderIdAdjust = 'TP-ADJ-99882';
  await pool.execute(
    "INSERT INTO orders (order_id, user_id, plan, amount, status) VALUES (?, 99882, 'topup', 20000, 'pending')",
    [orderIdAdjust]
  );
  // User transfer 25.000 padahal order 20.000 (selisih +5.000)
  await wallet.adminAdjust({
    params: { userId: '99882' },
    user: { username: 'admin_bos' },
    body: { jumlah: 25000, alasan: 'transfer lebih 5rb', order_id: orderIdAdjust }
  }, mockRes());
  assert.strictEqual(resAdj.status, 200);

  const [orderAdjRow] = await pool.execute(
    'SELECT status, note FROM orders WHERE order_id = ?',
    [orderIdAdjust]
  );
  assert.strictEqual(orderAdjRow[0].status, 'paid');
  assert.ok(orderAdjRow[0].note.includes('selisih nominal: +5000'), `Note harus memuat selisih nominal: ${orderAdjRow[0].note}`);
  console.log(`  ✓ Penyesuaian mencatat note selisih nominal: "${orderAdjRow[0].note}"`);

  console.log('\n--- 4. Poin 7 & 8: Order yang di-adjust tidak bisa dikredit ulang lewat webhook/konfirmasi ---');
  const [userRowSebelum] = await pool.execute('SELECT saldo FROM users WHERE id = 99882');
  const saldoSebelum = Number(userRowSebelum[0].saldo);

  // Coba jalankan tandaiLunas (simulasi webhook paid datang kemudian)
  const hasilWebhookUlang = await billing.tandaiLunas(orderIdAdjust, { payment_reference_id: 'WEBHOOK-LATE' });
  assert.strictEqual(hasilWebhookUlang.status, 'paid');
  assert.strictEqual(hasilWebhookUlang.sudah, true, 'Harus mendeteksi sudah paid');

  const [userRowSesudah] = await pool.execute('SELECT saldo FROM users WHERE id = 99882');
  const saldoSesudah = Number(userRowSesudah[0].saldo);

  assert.strictEqual(saldoSesudah, saldoSebelum, 'Saldo TIDAK BOLEH bertambah dua kali!');
  console.log(`  ✓ Webhook telat pada order yang sudah di-adjust tidak menambah saldo (Saldo tetap: ${saldoSesudah})`);

  // Cleanup
  await pool.execute('DELETE FROM wallet_ledger WHERE user_id IN (99881, 99882)');
  await pool.execute('DELETE FROM orders WHERE user_id IN (99881, 99882)');
  await pool.execute('DELETE FROM users WHERE id IN (99881, 99882)');

  console.log('\n✅ Seluruh skenario live DB MySQL berhasil 100%!');
  process.exit(0);
})().catch(err => {
  console.error('\n❌ GAGAL PENGUJIAN LIVE DB:', err);
  process.exit(1);
});
