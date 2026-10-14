'use strict';
/**
 * test/billing-tandailunas-transaction-db.js
 * Memverifikasi pada MySQL asli (DB_NAME_TEST):
 * 1. Jika terapkanPaket melempar error -> transaksi ROLLBACK.
 *    Order tetap 'pending' (tidak jadi 'paid'), dan note mencatat 'paket gagal diterapkan'.
 * 2. Retry webhook kedua (setelah masalah diselesaikan) -> berhasil menandai 'paid' dan paket aktif.
 */

require('dotenv').config({ quiet: true });
const assert = require('assert');

const DB_TEST = process.env.DB_NAME_TEST || 'yaaparbot_test';

(async () => {
  console.log(`=== Uji Transaksi Atomik tandaiLunas di: ${DB_TEST} ===`);
  process.env.DB_NAME = DB_TEST;

  const { pool } = require('../config/database');
  const billing = require('../controllers/billingController');

  // Bersihkan data tes
  await pool.execute('DELETE FROM orders WHERE user_id = 99883');
  await pool.execute('DELETE FROM users WHERE id = 99883');

  // Buat user tes
  await pool.execute(
    "INSERT INTO users (id, username, password, role, saldo) VALUES (99883, 'user_trx_test', 'hash', 'user', 0)"
  );

  const orderId = 'ORD-TRX-FAIL-RETRY';
  await pool.execute(
    "INSERT INTO orders (order_id, user_id, plan, amount, status) VALUES (?, 99883, 'basic', 25000, 'pending')",
    [orderId]
  );

  // Monkey patch terapkanPaket agar sengaja melempar error pada percobaan pertama
  const terapkanAsli = billing.terapkanPaket;
  let forceThrow = true;
  billing.terapkanPaket = async function (...args) {
    if (forceThrow) {
      throw new Error('Simulasi DB/logic error saat terapkan paket');
    }
    return terapkanAsli.apply(this, args);
  };

  console.log('\n1. Simulasi kegagalan pada terapkanPaket...');
  let melempar = false;
  try {
    await billing.tandaiLunas(orderId, { payment_reference_id: 'REF-ERR-1' });
  } catch (err) {
    melempar = true;
    console.log(`   ✓ Error berhasil ditangkap: "${err.message}"`);
  }
  assert.strictEqual(melempar, true, 'tandaiLunas harus melempar error jika terapkanPaket gagal');

  // Periksa kondisi database setelah rollback
  const [orderAfterRollback] = await pool.execute(
    'SELECT status, note, paid_at FROM orders WHERE order_id = ?',
    [orderId]
  );
  assert.strictEqual(orderAfterRollback[0].status, 'pending', 'Status order harus TETAP pending setelah rollback!');
  assert.strictEqual(orderAfterRollback[0].paid_at, null, 'paid_at tidak boleh terisi!');
  assert.ok(
    orderAfterRollback[0].note.includes('paket gagal diterapkan: Simulasi DB/logic error'),
    `Note order harus memuat 'paket gagal diterapkan', actual: ${orderAfterRollback[0].note}`
  );
  console.log(`   ✓ Database konsisten: status=${orderAfterRollback[0].status}, note="${orderAfterRollback[0].note}"`);

  console.log('\n2. Simulasi retry webhook kedua (masalah selesai)...');
  forceThrow = false; // Normal kembali
  const hasilRetry = await billing.tandaiLunas(orderId, { payment_reference_id: 'REF-SUCCESS-2' });
  assert.strictEqual(hasilRetry.plan, 'basic');

  const [orderAfterSuccess] = await pool.execute(
    'SELECT status, paid_at FROM orders WHERE order_id = ?',
    [orderId]
  );
  assert.strictEqual(orderAfterSuccess[0].status, 'paid', 'Status order harus menjadi paid pada retry yang sukses');
  assert.ok(orderAfterSuccess[0].paid_at !== null, 'paid_at harus terisi');

  const [userAfterSuccess] = await pool.execute(
    'SELECT plan FROM users WHERE id = 99883'
  );
  assert.strictEqual(userAfterSuccess[0].plan, 'basic', 'User harus mendapatkan paket basic');
  console.log('   ✓ Retry webhook berhasil 100%, order paid dan paket aktif!');

  // Cleanup
  billing.terapkanPaket = terapkanAsli;
  await pool.execute('DELETE FROM orders WHERE user_id = 99883');
  await pool.execute('DELETE FROM users WHERE id = 99883');

  console.log('\n✅ Seluruh pengujian transaksi tandaiLunas berhasil!');
  process.exit(0);
})().catch(err => {
  console.error('\n❌ Gagal uji transaksi tandaiLunas:', err);
  process.exit(1);
});
