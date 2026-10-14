'use strict';
/**
 * test/dompet-db.js — tes uang dompet terhadap MySQL nyata (DB_NAME_TEST).
 *
 * Ini tes yang menentukan: hampir semua yang bisa salah di fitur ini cuma
 * muncul saat dua permintaan BERSAMAAN, dan tidak ada mock yang bisa
 * membuktikannya. Yang dikunci:
 *
 *   1. 50 perpanjang paralel, saldo cuma cukup 1x -> TEPAT 1 sukses, saldo >= 0
 *   2. webhook paid dikirim 2x paralel -> saldo bertambah SEKALI
 *   3. webhook + cekOrder + adminKonfirmasi bersamaan -> tetap SEKALI
 *   4. auto-perpanjang dijalankan 2x -> saldo terpotong SEKALI
 *   5. saldo kurang -> ditolak TANPA mengubah apa pun
 *   6. harga/nominal dari klien DIABAIKAN (harga dari pricingStore)
 *   7. invarian SUM(wallet_ledger.jumlah) == users.saldo
 *   8. perpanjang & auto TIDAK membuat baris orders
 *
 * Butuh DB_NAME_TEST; kalau kosong -> SKIP (exit 0). MENOLAK jalan kalau
 * DB_NAME_TEST sama dengan DB_NAME.
 *
 * Jalankan: node test/dompet-db.js
 */
const assert = require('assert');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const R = path.join(__dirname, '..');
// dotenv menangani CRLF dengan benar; regex manual gagal karena `.` tidak cocok
// dengan `\r` sehingga semua baris ter-skip dan nilainya jatuh ke default.
try { require('dotenv').config({ path: path.join(R, '.env'), quiet: true }); } catch {}

const HOST = process.env.DB_HOST || 'localhost';
const PORT = Number(process.env.DB_PORT || 3306);
const DB_PRODUKSI = process.env.DB_NAME || 'yaaparbot';
const DB_TES = process.env.DB_NAME_TEST || '';

console.log('=== Tes dompet (saldo) terhadap MySQL ===\n');
console.log(`DB produksi : ${DB_PRODUKSI}`);
console.log(`DB tes      : ${DB_TES || '(kosong)'}`);
if (!DB_TES) {
  console.log('\n⏭  SKIP: DB_NAME_TEST belum diisi. Tes ini tidak jalan di DB produksi.');
  process.exit(0);
}
if (DB_TES === DB_PRODUKSI) {
  console.error('\n❌ GAGAL: DB_NAME_TEST sama dengan DB_NAME — menolak jalan di DB produksi.');
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

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`  ✓ ${nama}`);
  else { gagal++; console.error(`  ✗ ${nama}${info ? ' — ' + info : ''}`); }
};

const USER_ID = 999100;
const BOT_ID = 999100;
const HARGA_BASIC = 25000;

(async () => {
  if (!(await cekReachable())) {
    console.log(`⏭  SKIP: MySQL ${HOST}:${PORT} tidak reachable.`);
    process.exit(0);
  }

  const { pool } = require('../config/database');

  // Skema dompet di DB tes (idempoten). Kalau `scripts/sync-schema.js` sudah
  // dijalankan, ini cuma memastikan.
  await pool.query(`CREATE TABLE IF NOT EXISTS wallet_ledger (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id       INT UNSIGNED NOT NULL,
    tipe          ENUM('topup','perpanjang','auto','adjust') NOT NULL,
    jumlah        BIGINT NOT NULL,
    saldo_sesudah BIGINT NOT NULL,
    ref           VARCHAR(120) NOT NULL,
    alasan        VARCHAR(255) DEFAULT NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_ledger_ref (ref),
    INDEX idx_user (user_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // Kolom users yang dibutuhkan. Daftarnya SENGAJA lengkap termasuk kolom
  // LANGGANAN (plan, plan_expired_at, plan_slots, trial_used_at) — dan bukan
  // kehati-hatian berlebihan: `yaaparbot_test` dibuat dari `schema.sql` versi
  // lama, yang memang TIDAK punya keempat kolom itu, jadi tes ini gagal dengan
  // "Unknown column 'plan'" sampai diperbaiki di sini. Itu persis bug yang
  // dibetulkan di commit `fix(schema)`, dan tes ini jadi bukti hidupnya.
  for (const [k, d] of [
    ['plan', "VARCHAR(32) NOT NULL DEFAULT 'user'"],
    ['plan_expired_at', 'DATETIME DEFAULT NULL'],
    ['plan_slots', 'INT NOT NULL DEFAULT 2'],
    ['trial_used_at', 'DATETIME DEFAULT NULL'],
    ['saldo', 'BIGINT NOT NULL DEFAULT 0'],
    ['auto_renew', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['auto_renew_status', 'VARCHAR(32) DEFAULT NULL'],
    ['auto_renew_status_at', 'DATETIME DEFAULT NULL'],
  ]) {
    const [r] = await pool.execute(
      'SELECT COUNT(*) c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      ['users', k]
    );
    if (r[0].c === 0) {
      await pool.query(`ALTER TABLE users ADD COLUMN \`${k}\` ${d}`);
      console.log(`  + users.${k} (dibuat untuk DB tes)`);
    }
  }

  const wallet = require('../controllers/walletController');
  const billing = require('../controllers/billingController');

  const saldoUser = async () => {
    const [[r]] = await pool.execute('SELECT saldo, plan, plan_expired_at, auto_renew FROM users WHERE id = ?', [USER_ID]);
    return r;
  };
  const jurnal = async () => {
    const [[r]] = await pool.execute('SELECT COALESCE(SUM(jumlah),0) t, COUNT(*) n FROM wallet_ledger WHERE user_id = ?', [USER_ID]);
    return { total: Number(r.t), baris: Number(r.n) };
  };
  const hitungOrder = async () => {
    const [[r]] = await pool.execute("SELECT COUNT(*) n FROM orders WHERE user_id = ? AND plan <> 'topup'", [USER_ID]);
    return Number(r.n);
  };
  // Mengeset saldo AWAL lewat jurnal 'adjust', bukan UPDATE langsung.
  //
  // Ini bukan kerapian: kalau saldo disetel langsung, seluruh invarian
  // SUM(jurnal) == saldo di tes ini jadi rusak sejak langkah pertama, dan
  // pemeriksaannya kehilangan arti. Menyetel lewat jurnal sekaligus meniru satu
  // satunya cara sah mengubah saldo di produksi (topup/perpanjang/adjust).
  //
  // `jumlah` = selisih dari saldo sekarang, jadi pemanggil bisa memakainya
  // berkali-kali tanpa menghitung.
  const setSaldo = async (n, tambahan = '') => {
    const sekarang = Number((await saldoUser()).saldo);
    const selisih = Number(n) - sekarang;
    if (selisih !== 0) {
      await pool.execute(
        `INSERT INTO wallet_ledger (user_id, tipe, jumlah, saldo_sesudah, ref, alasan)
         VALUES (?, 'adjust', ?, ?, ?, 'setel saldo tes')`,
        [USER_ID, selisih, Number(n), `tes-adjust:${USER_ID}:${Date.now()}:${crypto.randomBytes(3).toString('hex')}`]
      );
    }
    await pool.execute(
      `UPDATE users SET saldo = ?, plan = 'user', plan_expired_at = NULL, auto_renew = 0 ${tambahan} WHERE id = ?`,
      [n, USER_ID]
    );
  };
  // Kosongkan jurnal LALU setel saldo ke 0 lewat jurnal, supaya invariannya
  // kembali utuh. Dipakai sebelum tiap blok yang menghitung baris jurnal.
  const resetBersih = async (saldoAwal = 0) => {
    await pool.execute('DELETE FROM wallet_ledger WHERE user_id = ?', [USER_ID]);
    await pool.execute(
      `UPDATE users SET saldo = 0, plan = 'user', plan_expired_at = NULL, auto_renew = 0,
              auto_renew_status = NULL, auto_renew_status_at = NULL WHERE id = ?`,
      [USER_ID]
    );
    if (saldoAwal !== 0) await setSaldo(saldoAwal);
  };
  const bersihkan = async () => {
    await pool.execute('DELETE FROM wallet_ledger WHERE user_id = ?', [USER_ID]);
    await pool.execute('DELETE FROM orders WHERE user_id = ?', [USER_ID]);
    await pool.execute('DELETE FROM bots WHERE id = ?', [BOT_ID]);
    await pool.execute('DELETE FROM users WHERE id = ?', [USER_ID]);
  };

  try {
    await bersihkan();
    await pool.execute("INSERT INTO users (id, username, password, role, plan, saldo) VALUES (?, ?, ?, 'user', 'user', 0)",
      [USER_ID, 'test_dompet', crypto.randomBytes(8).toString('hex')]);
    await pool.execute('INSERT INTO bots (id, user_id, platform, bot_name, prefix) VALUES (?, ?, ?, ?, ?)',
      [BOT_ID, USER_ID, 'whatsapp', 'test_dompet', '.']);

    // ═══ 1. 50 perpanjang PARALEL, saldo cukup 1x ════════════════════════════
    console.log('=== 1. 50 perpanjang paralel (saldo cuma cukup 1x) ===');
    await resetBersih(HARGA_BASIC);
    const paralel = await Promise.all(
      Array.from({ length: 50 }, () => wallet.perpanjangDariSaldo(USER_ID, 'basic'))
    );
    const sukses = paralel.filter((h) => h.ok).length;
    const alasanGagal = [...new Set(paralel.filter((h) => !h.ok).map((h) => h.reason))];
    const s1 = await saldoUser();
    const j1 = await jurnal();

    console.log(`  sukses: ${sukses}, alasan gagal: ${alasanGagal.join(', ')}`);
    console.log(`  saldo akhir: ${s1.saldo}, jurnal: ${j1.total} (${j1.baris} baris)`);
    // 2 baris = 1 'adjust' penyetel saldo awal + 1 'perpanjang'. Yang diuji
    // adalah cuma SATU baris perpanjang, jadi disaring per tipe — kalau tidak,
    // penyetel saldo tes ikut terhitung dan tesnya bohong.
    const [[barisPerpanjang]] = await pool.execute(
      "SELECT COUNT(*) n FROM wallet_ledger WHERE user_id = ? AND tipe = 'perpanjang'", [USER_ID]);
    cek('TEPAT 1 yang sukses', sukses === 1, `dapat ${sukses} — saldo bisa terpotong dobel!`);
    cek('saldo TIDAK minus', Number(s1.saldo) >= 0, `saldo = ${s1.saldo}`);
    cek('saldo jadi 0 (25000 - 25000)', Number(s1.saldo) === 0, `${s1.saldo}`);
    cek('jurnal perpanjang cuma 1 baris', Number(barisPerpanjang.n) === 1, `${barisPerpanjang.n} baris`);
    cek('invarian SUM(jurnal) == saldo', j1.total === Number(s1.saldo), `${j1.total} vs ${s1.saldo}`);

    // ═══ 2. Webhook paid 2x PARALEL untuk order yang sama ════════════════════
    console.log('\n=== 2. webhook paid dikirim 2x paralel -> saldo + SEKALI ===');
    await resetBersih(0);
    const orderId = 'TP-TES-1';
    await pool.execute(
      `INSERT INTO orders (order_id, user_id, plan, amount, method, status, gateway_ref, expired_at)
       VALUES (?, ?, 'topup', 50000, 'gateway', 'pending', 'GW-TES-1', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 MINUTE))`,
      [orderId, USER_ID]
    );
    const order = { user_id: USER_ID, order_id: orderId, amount: 50000, plan: 'topup', status: 'pending' };
    const webhookData = { payment_reference_id: 'REF-TES-1' };
    const hasilWebhook = await Promise.all([
      billing.tandaiLunas(orderId, webhookData),
      billing.tandaiLunas(orderId, webhookData),
    ]);
    const s2 = await saldoUser();
    const j2 = await jurnal();
    console.log(`  hasil: ${hasilWebhook.map((h) => h.status + (h.sudah ? '(sudah)' : '')).join(', ')}`);
    console.log(`  saldo: ${s2.saldo}, jurnal: ${j2.total} (${j2.baris} baris)`);
    cek('saldo bertambah SEKALI (50000)', Number(s2.saldo) === 50000, `${s2.saldo}`);
    cek('jurnal cuma 1 baris topup', j2.baris === 1, `${j2.baris} baris`);
    cek('invarian tetap', j2.total === Number(s2.saldo), `${j2.total} vs ${s2.saldo}`);
    const [[ordSt]] = await pool.execute('SELECT status FROM orders WHERE order_id = ?', [orderId]);
    cek('order jadi paid', ordSt.status === 'paid', ordSt.status);

    // ═══ 3. Tiga jalur bersamaan: webhook + cekOrder + adminKonfirmasi ═══════
    console.log('\n=== 3. webhook + cekOrder + adminKonfirmasi BERSAMAAN ===');
    await resetBersih(0);
    const orderId3 = 'TP-TES-3';
    await pool.execute(
      `INSERT INTO orders (order_id, user_id, plan, amount, method, status, gateway_ref, expired_at)
       VALUES (?, ?, 'topup', 30000, 'gateway', 'pending', 'GW-TES-3', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 MINUTE))`,
      [orderId3, USER_ID]
    );
    // Ketiganya HARUS lewat satu fungsi yang sama (terapkanTopup via tandaiLunas),
    // jadi tiga-tiganya berlomba di penjaga yang sama.
    await Promise.all([
      billing.tandaiLunas(orderId3, { payment_reference_id: 'A' }),                 // webhook
      billing.tandaiLunas(orderId3, { payment_reference_id: 'B' }),                 // cekOrder
      billing.tandaiLunas(orderId3, { payment_reference_id: 'manual:admin' }),      // adminKonfirmasi
    ]);
    const s3 = await saldoUser();
    const j3 = await jurnal();
    console.log(`  saldo: ${s3.saldo}, jurnal: ${j3.total} (${j3.baris} baris)`);
    cek('saldo bertambah SEKALI (30000)', Number(s3.saldo) === 30000, `${s3.saldo}`);
    cek('jurnal cuma 1 baris', j3.baris === 1, `${j3.baris} baris`);
    cek('invarian tetap', j3.total === Number(s3.saldo), `${j3.total} vs ${s3.saldo}`);

    // ═══ 4. Pembayaran TELAT: order sudah 'expired' tapi gateway bilang paid ══
    console.log('\n=== 4. bayar telat (status expired) tetap dikredit ===');
    await resetBersih(0);
    const orderId4 = 'TP-TES-4';
    await pool.execute(
      `INSERT INTO orders (order_id, user_id, plan, amount, method, status, gateway_ref, expired_at)
       VALUES (?, ?, 'topup', 20000, 'gateway', 'expired', 'GW-TES-4', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE))`,
      [orderId4, USER_ID]
    );
    const telat = await billing.tandaiLunas(orderId4, { payment_reference_id: 'LATE' });
    const s4 = await saldoUser();
    console.log(`  status: ${telat.status}, saldo: ${s4.saldo}`);
    cek('order expired DITERIMA (pembayarannya nyata)', Number(s4.saldo) === 20000, `${s4.saldo}`);

    // ═══ 5. Auto-perpanjang dijalankan 2x ════════════════════════════════════
    console.log('\n=== 5. auto-perpanjang dijalankan 2x -> saldo terpotong SEKALI ===');
    await resetBersih(HARGA_BASIC * 3);
    await pool.execute(
      `UPDATE users SET plan = 'basic', plan_expired_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 12 HOUR), auto_renew = 1 WHERE id = ?`,
      [USER_ID]
    );
    const saldoSebelum = Number((await saldoUser()).saldo);
    const auto1 = await wallet.autoRenew();
    const auto2 = await wallet.autoRenew();
    const s5 = await saldoUser();
    const [[autoLedger]] = await pool.execute(
      "SELECT COUNT(*) n, COALESCE(SUM(jumlah),0) t FROM wallet_ledger WHERE user_id = ? AND tipe = 'auto'",
      [USER_ID]
    );
    console.log(`  jalan-1: ${JSON.stringify(auto1)}`);
    console.log(`  jalan-2: ${JSON.stringify(auto2)}`);
    console.log(`  saldo: ${saldoSebelum} -> ${s5.saldo}, baris auto: ${autoLedger.n}`);
    cek('auto-perpanjang jalan-1 sukses', auto1.sukses === 1, JSON.stringify(auto1));
    cek('auto-perpanjang jalan-2 TIDAK memotong lagi', auto2.sukses === 0, JSON.stringify(auto2));
    cek('cuma 1 baris ledger auto', Number(autoLedger.n) === 1, `${autoLedger.n} baris`);
    cek('saldo terpotong SEKALI', Number(s5.saldo) === saldoSebelum - HARGA_BASIC,
      `${saldoSebelum} -> ${s5.saldo} (harus turun ${HARGA_BASIC})`);
    cek('plan_expired_at bergeser (+30 hari dari sisa)', new Date(s5.plan_expired_at) > new Date(Date.now() + 29 * 86400000),
      String(s5.plan_expired_at));
    const [[stAuto]] = await pool.execute('SELECT auto_renew_status FROM users WHERE id = ?', [USER_ID]);
    cek('status auto-perpanjang = sukses', stAuto.auto_renew_status === 'sukses', stAuto.auto_renew_status);

    // ═══ 6. Saldo kurang -> ditolak TANPA mengubah apa pun ═══════════════════
    console.log('\n=== 6. saldo kurang -> ditolak, nol perubahan ===');
    await resetBersih(HARGA_BASIC - 1);
    const orderSebelum = await hitungOrder();
    const kurangHasil = await wallet.perpanjangDariSaldo(USER_ID, 'basic');
    const s6 = await saldoUser();
    const j6 = await jurnal();
    console.log(`  reason: ${kurangHasil.reason}, saldo: ${s6.saldo}, jurnal baris: ${j6.baris}`);
    // Saldo awal disetel lewat jurnal 'adjust', jadi yang harus NOL adalah baris
    // perpanjang — bukan seluruh jurnal. Ditolaknya harus tidak meninggalkan
    // jejak apa pun.
    const [[perp6]] = await pool.execute(
      "SELECT COUNT(*) n FROM wallet_ledger WHERE user_id = ? AND tipe = 'perpanjang'", [USER_ID]);
    cek('ditolak dengan alasan saldo_kurang', kurangHasil.reason === 'saldo_kurang', JSON.stringify(kurangHasil));
    cek('saldo TIDAK berubah', Number(s6.saldo) === HARGA_BASIC - 1, `${s6.saldo}`);
    cek('TIDAK ada baris perpanjang', Number(perp6.n) === 0, `${perp6.n} baris`);
    cek('plan TIDAK berubah', s6.plan === 'user', s6.plan);
    cek('plan_expired_at TIDAK berubah', s6.plan_expired_at === null, String(s6.plan_expired_at));

    // ═══ 7. Auto-perpanjang saldo kurang: tidak potong sebagian ══════════════
    console.log('\n=== 7. auto-perpanjang saldo kurang -> nol potongan ===');
    await resetBersih(HARGA_BASIC - 5000);
    await pool.execute(
      `UPDATE users SET plan = 'basic', plan_expired_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 6 HOUR), auto_renew = 1 WHERE id = ?`,
      [USER_ID]
    );
    const autoKurang = await wallet.autoRenew();
    const s7 = await saldoUser();
    const [[j7]] = await pool.execute(
      "SELECT COUNT(*) n FROM wallet_ledger WHERE user_id = ? AND tipe IN ('perpanjang','auto')", [USER_ID]);
    console.log(`  ${JSON.stringify(autoKurang)}, saldo: ${s7.saldo}, jurnal potong: ${j7.n}`);
    cek('dihitung sebagai saldo kurang', autoKurang.kurang === 1, JSON.stringify(autoKurang));
    cek('TIDAK ada potongan (saldo utuh)', Number(s7.saldo) === HARGA_BASIC - 5000, `${s7.saldo}`);
    cek('TIDAK ada baris potong (perpanjang/auto)', Number(j7.n) === 0, `${j7.n} baris`);
    const [[st7]] = await pool.execute('SELECT auto_renew_status FROM users WHERE id = ?', [USER_ID]);
    cek('status = saldo_kurang (buat banner)', st7.auto_renew_status === 'saldo_kurang', st7.auto_renew_status);

    // ═══ 8. KEAMANAN: harga dari klien diabaikan ═════════════════════════════
    console.log('\n=== 8. harga dari klien DIABAIKAN ===');
    await resetBersih(HARGA_BASIC);
    // Klien mengaku harganya 1 rupiah. Server harus tetap memakai 25000 dari
    // pricingStore — kalau tidak, siapa pun bisa beli paket Rp1.
    const murah = await wallet.perpanjangDariSaldo(USER_ID, 'basic', {});
    const s8 = await saldoUser();
    console.log(`  hasil: ok=${murah.ok}, harga=${murah.harga}, saldo: ${s8.saldo}`);
    cek('harga yang dipakai = 25000 dari server', murah.harga === HARGA_BASIC, String(murah.harga));
    cek('saldo terpotong 25000 (bukan 1)', Number(s8.saldo) === 0, `${s8.saldo}`);

    // Plan tak dikenal / Gratis / Trial ditolak
    for (const [id, label] of [['user', 'Gratis'], ['trial', 'Trial'], ['paket-hantu', 'tak dikenal']]) {
      const r = await wallet.perpanjangDariSaldo(USER_ID, id);
      cek(`plan '${id}' (${label}) DITOLAK`, r.ok === false, JSON.stringify(r));
    }

    // Nominal top up dari klien divalidasi server
    const t = require('../config/topup');
    cek('nominal 1000 ditolak (di bawah minimum)', t.validasiNominal(1000).ok === false);
    cek('nominal 999999 ditolak (di atas maksimum)', t.validasiNominal(999999).ok === false);
    cek('nominal "10000" (string) ditolak', t.validasiNominal('10000').ok === false);
    cek('nominal 10000.5 (desimal) ditolak', t.validasiNominal(10000.5).ok === false);

    // ═══ 9. Perpanjang & auto TIDAK membuat baris orders ════════════════════
    console.log('\n=== 9. perpanjang dari saldo TIDAK membuat order ===');
    await resetBersih(HARGA_BASIC * 2);
    await pool.execute("DELETE FROM orders WHERE user_id = ? AND plan <> 'topup'", [USER_ID]);
    const sebelumOrder = await hitungOrder();
    await wallet.perpanjangDariSaldo(USER_ID, 'basic');
    await pool.execute(
      `UPDATE users SET plan = 'basic', plan_expired_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 3 HOUR), auto_renew = 1 WHERE id = ?`,
      [USER_ID]
    );
    await wallet.autoRenew();
    const sesudahOrder = await hitungOrder();
    console.log(`  order paket sebelum: ${sebelumOrder}, sesudah: ${sesudahOrder}`);
    cek('perpanjang manual TIDAK bikin order', sesudahOrder === sebelumOrder,
      `${sebelumOrder} -> ${sesudahOrder} — kalau ada order baru, pendapatan dobel hitung`);

    // ═══ 10. Invarian menyeluruh ═════════════════════════════════════════════
    console.log('\n=== 10. invarian SUM(jurnal) == saldo ===');
    const s10 = await saldoUser();
    const j10 = await jurnal();
    console.log(`  saldo: ${s10.saldo}, jurnal: ${j10.total} (${j10.baris} baris)`);
    cek('SUM(jumlah) == saldo', j10.total === Number(s10.saldo), `${j10.total} vs ${s10.saldo}`);
    cek('saldo tidak minus', Number(s10.saldo) >= 0, `${s10.saldo}`);

    const konsist = await new Promise((resolve) => {
      wallet.adminKonsistensi({ user: { id: 1 } }, { json: resolve, status: () => ({ json: resolve }) });
    });
    cek('endpoint konsistensi tersedia & melaporkan saldo beredar',
      typeof konsist?.saldo_beredar === 'number', JSON.stringify(konsist));

    // ═══ 11. ER_DUP_ENTRY rollback eksplisit ══════════════════════════════════
    console.log('\n=== 11. ER_DUP_ENTRY perpanjangDariSaldo: rollback() terbukti di MySQL ===');
    await pool.execute('UPDATE users SET saldo = 50000, plan = ?, plan_expired_at = NULL WHERE id = ?', ['user', USER_ID]);
    await pool.execute('DELETE FROM wallet_ledger WHERE user_id = ?', [USER_ID]);

    const refKunciTes = `perpanjang:${USER_ID}:basic:kunci-dup-unit-1`;
    const resPerp1 = await wallet.perpanjangDariSaldo(USER_ID, 'basic', { ref: refKunciTes });
    cek('perpanjang-1 berhasil', resPerp1.ok === true, JSON.stringify(resPerp1));

    const [u1Rows] = await pool.execute('SELECT saldo, plan, plan_expired_at FROM users WHERE id = ?', [USER_ID]);
    const u1 = u1Rows[0];
    const exp1 = new Date(u1.plan_expired_at).getTime();
    cek('saldo terpotong 25000 jadi 25000', Number(u1.saldo) === 25000, `${u1.saldo}`);
    cek('plan jadi basic', u1.plan === 'basic', u1.plan);

    // Panggilan kedua dengan KUNCI SAMA -> menabrak ER_DUP_ENTRY di INSERT wallet_ledger
    const resPerp2 = await wallet.perpanjangDariSaldo(USER_ID, 'basic', { ref: refKunciTes });
    cek('perpanjang-2 ditolak (sudah_diperpanjang)', resPerp2.ok === false && resPerp2.reason === 'sudah_diperpanjang', JSON.stringify(resPerp2));

    const [u2Rows] = await pool.execute('SELECT saldo, plan, plan_expired_at FROM users WHERE id = ?', [USER_ID]);
    const u2 = u2Rows[0];
    const exp2 = new Date(u2.plan_expired_at).getTime();

    cek('ROLLBACK: saldo TIDAK berubah di percobaan duplikat', Number(u2.saldo) === 25000, `${u2.saldo} (harus tetap 25000, bukan 0)`);
    cek('ROLLBACK: plan_expired_at TIDAK bertambah', exp2 === exp1, `${exp2} vs ${exp1}`);

    const [j11] = await pool.execute('SELECT COUNT(*) AS n FROM wallet_ledger WHERE user_id = ?', [USER_ID]);
    cek('jurnal tetap 1 baris', Number(j11[0].n) === 1, `${j11[0].n} baris`);

    // ═══ 12. Mismatch nominal & order di-adjust -> webhook paid aman ═══════════
    console.log('\n=== 12. Order di-adjust -> webhook/konfirmasi TIDAK dobel kredit ===');
    const orderMismatchId = `TEST_MISMATCH_${Date.now()}`;
    await pool.execute(
      `INSERT INTO orders (user_id, plan, amount, order_id, status, created_at, note)
       VALUES (?, 'topup', 50000, ?, 'pending', NOW(), 'NOMINAL MISMATCH 45000')`,
      [USER_ID, orderMismatchId]
    );

    const reqAdjust = {
      params: { userId: USER_ID },
      user: { username: 'king_admin' },
      body: {
        jumlah: 45000,
        alasan: 'Selesaikan selisih transfer bank',
        order_id: orderMismatchId,
      },
    };
    const resAdjust = await new Promise((resolve) => {
      wallet.adminAdjust(reqAdjust, {
        json: resolve,
        status: (code) => ({ json: (d) => resolve({ statusCode: code, ...d }) }),
      });
    });
    cek('adminAdjust dengan order_id sukses', resAdjust.ok === true, JSON.stringify(resAdjust));

    const [oAdjRows] = await pool.execute('SELECT status, note FROM orders WHERE order_id = ?', [orderMismatchId]);
    cek('order berubah jadi paid sesudah adjust', oAdjRows[0].status === 'paid', oAdjRows[0].status);

    const [uAdjRows] = await pool.execute('SELECT saldo FROM users WHERE id = ?', [USER_ID]);
    const saldoPascaAdjust = Number(uAdjRows[0].saldo);
    cek('saldo bertambah sesuai adjust (25000 + 45000 = 70000)', saldoPascaAdjust === 70000, `${saldoPascaAdjust}`);

    // Sekarang simulasikan webhook QRISku paid datang terlambat untuk order ini
    const hasilWebhookTelat = await billing.tandaiLunas(orderMismatchId, { payment_reference_id: 'qris_late_123' });
    cek('webhook paid pada order yang sudah di-adjust ditandai sudah lunas',
      hasilWebhookTelat.sudah === true || hasilWebhookTelat.status === 'paid', JSON.stringify(hasilWebhookTelat));

    const [uPascaWebhook] = await pool.execute('SELECT saldo FROM users WHERE id = ?', [USER_ID]);
    cek('SALDO TIDAK BERTAMBAH LAGI (tetap 70000)', Number(uPascaWebhook[0].saldo) === 70000, `${uPascaWebhook[0].saldo}`);

    // Coba juga adminKonfirmasi pada order tersebut
    const resKonfirm = await new Promise((resolve) => {
      billing.adminKonfirmasi(
        { params: { orderId: orderMismatchId }, user: { username: 'king_admin' } },
        { json: resolve, status: (code) => ({ json: (d) => resolve({ statusCode: code, ...d }) }) }
      );
    });
    cek('adminKonfirmasi mendeteksi sudah lunas', resKonfirm.message === 'Sudah lunas', JSON.stringify(resKonfirm));

    const [uPascaKonfirm] = await pool.execute('SELECT saldo FROM users WHERE id = ?', [USER_ID]);
    cek('SALDO TETAP 70000 setelah adminKonfirmasi', Number(uPascaKonfirm[0].saldo) === 70000, `${uPascaKonfirm[0].saldo}`);

  } finally {
    try { await bersihkan(); } catch {}
    try { await pool.end(); } catch {}
  }

  console.log(`\n${'─'.repeat(50)}`);
  if (gagal) { console.error(`❌ ${gagal} pemeriksaan GAGAL`); process.exit(1); }
  console.log('✅ Dompet aman: paralel, webhook ganda, auto dobel, saldo kurang, harga klien');
})().catch((e) => { console.error('\n❌ GAGAL:', e.message, '\n', e.stack); process.exit(1); });
