'use strict';
/**
 * scripts/uji-rebuild-sync.js
 * Poin (c):
 * 1. Buat ulang DB tes (yaaparbot_test) dari schema.sql baru.
 * 2. Buat DB kedua (yaaparbot_old_test) berskema lama.
 * 3. Jalankan sync-schema.js 2x pada masing-masing.
 * 4. Tampilkan bukti kolom terbentuk dan idempoten.
 */

require('dotenv').config({ quiet: true });
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

(async () => {
  const rootConn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    multipleStatements: true,
  });

  try {
    const dbUtama = (process.env.DB_NAME || 'yaaparbot').trim();
    function pastikanBolehDrop(namaDb) {
      if (!namaDb.endsWith('_test')) {
        throw new Error(`KEAMANAN: Menolak DROP database '${namaDb}' karena nama tidak berakhiran '_test'`);
      }
      if (namaDb === dbUtama) {
        throw new Error(`KEAMANAN: Menolak DROP database '${namaDb}' karena persis sama dengan DB_NAME utama ('${dbUtama}')`);
      }
    }

    console.log('=== 1. Buat ulang yaaparbot_test dari schema.sql baru ===');
    pastikanBolehDrop('yaaparbot_test');
    await rootConn.query('DROP DATABASE IF EXISTS yaaparbot_test');
    await rootConn.query('CREATE DATABASE yaaparbot_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    
    const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
    await rootConn.changeUser({ database: 'yaaparbot_test' });
    await rootConn.query(schemaSql);
    console.log('  ✓ yaaparbot_test dibuat ulang dari schema.sql');

    console.log('\n=== 2. Jalankan sync-schema.js 2x pada yaaparbot_test ===');
    const outT1 = execSync('node scripts/sync-schema.js', {
      env: { ...process.env, DB_NAME: 'yaaparbot_test' },
      encoding: 'utf8',
    });
    console.log('  [Pass 1]\n' + outT1.trim().split('\n').map(l => '    ' + l).join('\n'));

    const outT2 = execSync('node scripts/sync-schema.js', {
      env: { ...process.env, DB_NAME: 'yaaparbot_test' },
      encoding: 'utf8',
    });
    console.log('  [Pass 2]\n' + outT2.trim().split('\n').map(l => '    ' + l).join('\n'));

    console.log('\n=== 3. Buat DB kedua berskema lama (yaaparbot_old_test) ===');
    pastikanBolehDrop('yaaparbot_old_test');
    await rootConn.query('DROP DATABASE IF EXISTS yaaparbot_old_test');
    await rootConn.query('CREATE DATABASE yaaparbot_old_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    await rootConn.changeUser({ database: 'yaaparbot_old_test' });

    // Skema lama: users tanpa kolom saldo & auto_renew, tanpa tabel wallet_ledger
    await rootConn.query(`
      CREATE TABLE users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        role ENUM('user', 'king') NOT NULL DEFAULT 'user',
        daily_limit INT NOT NULL DEFAULT 50,
        limit_reset_at DATE DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      CREATE TABLE bots (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        name VARCHAR(100) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('  ✓ yaaparbot_old_test dibuat dengan skema lama (tanpa saldo/ledger)');

    console.log('\n=== 4. Jalankan sync-schema.js 2x pada yaaparbot_old_test ===');
    const outOld1 = execSync('node scripts/sync-schema.js', {
      env: { ...process.env, DB_NAME: 'yaaparbot_old_test' },
      encoding: 'utf8',
    });
    console.log('  [Pass 1: Tambah kolom & tabel]\n' + outOld1.trim().split('\n').map(l => '    ' + l).join('\n'));

    const outOld2 = execSync('node scripts/sync-schema.js', {
      env: { ...process.env, DB_NAME: 'yaaparbot_old_test' },
      encoding: 'utf8',
    });
    console.log('  [Pass 2: Idempoten]\n' + outOld2.trim().split('\n').map(l => '    ' + l).join('\n'));

    console.log('\n=== 5. Buktikan kolom & tabel di kedua DB ===');
    for (const db of ['yaaparbot_test', 'yaaparbot_old_test']) {
      await rootConn.changeUser({ database: db });
      const [colRows] = await rootConn.query(`
        SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users'
          AND COLUMN_NAME IN ('saldo', 'auto_renew', 'auto_renew_status', 'auto_renew_status_at')
        ORDER BY COLUMN_NAME
      `, [db]);
      const [tblRows] = await rootConn.query(`
        SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'wallet_ledger'
      `, [db]);
      console.log(`\n  DB [${db}]:`);
      console.log('    Tabel wallet_ledger :', tblRows.length ? 'ADA ✅' : 'TIDAK ADA ❌');
      for (const c of colRows) {
        console.log(`    Kolom users.${c.COLUMN_NAME.padEnd(21)} : ${c.COLUMN_TYPE.padEnd(20)} default=${c.COLUMN_DEFAULT}`);
      }
    }

    // Bersihkan DB sementara
    pastikanBolehDrop('yaaparbot_old_test');
    await rootConn.query('DROP DATABASE IF EXISTS yaaparbot_old_test');
    console.log('\n  ✓ DB sementara yaaparbot_old_test dibersihkan');

  } finally {
    await rootConn.end();
  }
})().catch((err) => {
  console.error('❌ GAGAL:', err.message);
  process.exit(1);
});
