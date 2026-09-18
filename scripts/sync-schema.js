'use strict';
/**
 * scripts/sync-schema.js
 * Sinkronkan skema DB existing dengan schema.sql (idempoten, aman dijalankan ulang).
 * - Menambah kolom yang belum ada (tanpa menghapus data)
 * - Mengubah tipe kolom yang salah (mis. bot_logs.level ENUM -> VARCHAR)
 * - Membuat tabel yang belum ada
 *
 * Run: node scripts/sync-schema.js
 */

require('dotenv').config();
const { pool } = require('../config/database');

const TABLES = {
  // nama tabel -> kolom [nama, definisi]
  bots: [
    ['owner_name',     "VARCHAR(100) DEFAULT NULL"],
    ['channel_id',     "VARCHAR(100) DEFAULT NULL"],
    ['qris_url',       "TEXT DEFAULT NULL"],
    ['banner_url',     "TEXT DEFAULT NULL"],
    ['main_groups',    "TEXT DEFAULT NULL"],
    ['daily_limit',    "INT NOT NULL DEFAULT 20"],
    ['is_running',     "TINYINT(1) NOT NULL DEFAULT 0"],
  ],
  group_settings: [
    // Saklar `.on welcome` / `.on left` — DB lama belum punya kolom ini.
    ['welcome_on', "TINYINT(1) NOT NULL DEFAULT 1"],
    ['bye_on',     "TINYINT(1) NOT NULL DEFAULT 1"],
  ],
  rpg_members: [
    // tambahan RPG yang dipakai kode
    ['bank_money',     "BIGINT NOT NULL DEFAULT 0"],
    ['bank',           "BIGINT NOT NULL DEFAULT 0"],
    ['koin',           "BIGINT NOT NULL DEFAULT 0"],
    ['lim',            "INT NOT NULL DEFAULT 100"],
    ['healt',          "INT NOT NULL DEFAULT 100"],
    ['sword',          "INT NOT NULL DEFAULT 0"],
    ['armor',          "INT NOT NULL DEFAULT 0"],
    ['job',            "VARCHAR(50) NOT NULL DEFAULT 'Pengangguran'"],
    ['jobexp',         "INT NOT NULL DEFAULT 0"],
    ['hewan_json',     "JSON DEFAULT NULL"],
    ['last_daily',     "DATETIME DEFAULT NULL"],
    ['last_hourly',    "DATETIME DEFAULT NULL"],
    ['last_weekly',    "DATETIME DEFAULT NULL"],
    ['last_dailymisi', "DATETIME DEFAULT NULL"],
    ['last_kerja',     "DATETIME DEFAULT NULL"],
    ['last_gajian',    "DATETIME DEFAULT NULL"],
    ['last_mancing',   "DATETIME DEFAULT NULL"],
    ['last_berburu',   "DATETIME DEFAULT NULL"],
    ['last_dungeon',   "DATETIME DEFAULT NULL"],
    ['last_adventure', "DATETIME DEFAULT NULL"],
    ['last_koboy',     "DATETIME DEFAULT NULL"],
    ['last_airdrop',   "DATETIME DEFAULT NULL"],
    ['last_maling',    "DATETIME DEFAULT NULL"],
  ],
};

const CREATE_TABLES = [
  // bot_sewa
  `CREATE TABLE IF NOT EXISTS bot_sewa (
    id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    bot_id       INT UNSIGNED NOT NULL,
    group_jid    VARCHAR(100) NOT NULL,
    group_name   VARCHAR(255) DEFAULT NULL,
    expired_at   BIGINT DEFAULT NULL,
    pending_ms   BIGINT DEFAULT NULL,
    warned       TINYINT(1) NOT NULL DEFAULT 0,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_sewa (bot_id, group_jid)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // group_settings
  `CREATE TABLE IF NOT EXISTS group_settings (
    id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    bot_id       INT UNSIGNED NOT NULL,
    group_jid    VARCHAR(100) NOT NULL,
    welcome_msg  TEXT DEFAULT NULL,
    bye_msg      TEXT DEFAULT NULL,
    welcome_on   TINYINT(1) NOT NULL DEFAULT 1,
    bye_on       TINYINT(1) NOT NULL DEFAULT 1,
    detect       TINYINT(1) NOT NULL DEFAULT 0,
    autoacc      TINYINT(1) NOT NULL DEFAULT 0,
    document     TINYINT(1) NOT NULL DEFAULT 0,
    open_time    VARCHAR(5) DEFAULT NULL,
    close_time   VARCHAR(5) DEFAULT NULL,
    limit_daily  INT DEFAULT NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_bot_group (bot_id, group_jid)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // group_ban
  `CREATE TABLE IF NOT EXISTS group_ban (
    id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    bot_id       INT UNSIGNED NOT NULL,
    group_jid    VARCHAR(100) NOT NULL,
    jid          VARCHAR(100) NOT NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_group_ban (bot_id, group_jid, jid)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // auto_respon
  `CREATE TABLE IF NOT EXISTS auto_respon (
    id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    bot_id       INT UNSIGNED NOT NULL,
    trigger_key  VARCHAR(255) NOT NULL,
    response     TEXT NOT NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_bot_trigger (bot_id, trigger_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // gudang_list
  `CREATE TABLE IF NOT EXISTS gudang_list (
    id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    bot_id       INT UNSIGNED NOT NULL,
    list_key     VARCHAR(100) NOT NULL,
    description  TEXT,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_bot_key (bot_id, list_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

async function columnExists(table, colName) {
  try {
    const [r] = await pool.execute(
      "SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
      [table, colName]
    );
    return r[0].c > 0;
  } catch { return false; }
}

async function ensureColumn(table, colName, definition) {
  if (await columnExists(table, colName)) {
    console.log(`  = ${table}.${colName} (sudah ada)`);
    return;
  }
  try {
    await pool.execute(`ALTER TABLE ${table} ADD COLUMN \`${colName}\` ${definition}`);
    console.log(`  + ${table}.${colName}`);
  } catch (e) {
    if (e.code === 'ER_DUP_FIELDNAME') {
      console.log(`  = ${table}.${colName} (sudah ada)`);
    } else {
      console.log(`  ! ${table}.${colName}: ${e.message}`);
    }
  }
}

async function run() {
  console.log('[Sync] Sinkronisasi skema dimulai...\n');

  // 1) Kolom tambahan per tabel (hanya jika tabel sudah ada — DB fresh pakai schema.sql)
  for (const [table, columns] of Object.entries(TABLES)) {
    let exists = false;
    try {
      const [r] = await pool.execute(
        "SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
        [table]
      );
      exists = r[0].c > 0;
    } catch { /* biarkan false */ }
    if (!exists) { console.log(`[${table}] (tabel belum ada — skip, buat via schema.sql)`); continue; }
    console.log(`[${table}]`);
    for (const [col, def] of columns) {
      await ensureColumn(table, col, def);
    }
  }

  // 2) Perbaiki tipe kolom penting yang salah di DB lama
  // bot_logs.level: ENUM('info','warn','error','debug') -> VARCHAR (kode kirim 'cmd'/'cmderr')
  try {
    await pool.execute(
      "ALTER TABLE bot_logs MODIFY COLUMN level VARCHAR(10) NOT NULL DEFAULT 'info'"
    );
    console.log('  ~ bot_logs.level -> VARCHAR(10)');
  } catch (e) {
    console.log(`  ! bot_logs.level: ${e.message}`);
  }

  // rpg_members: schema lama punya `limit` (salah) — data dipindah ke `lim`
  try {
    const [cols] = await pool.execute(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rpg_members' AND COLUMN_NAME IN ('limit','lim')"
    );
    const names = cols.map(c => c.COLUMN_NAME);
    if (names.includes('limit') && !names.includes('lim')) {
      await pool.execute('ALTER TABLE rpg_members CHANGE COLUMN `limit` lim INT NOT NULL DEFAULT 100');
      console.log('  ~ rpg_members.limit -> lim (data dipertahankan)');
    } else if (names.includes('limit') && names.includes('lim')) {
      // dua-duanya ada: isi lim dari limit kalau lim masih default, lalu drop limit
      await pool.execute('UPDATE rpg_members SET lim = `limit` WHERE lim = 100 AND `limit` <> 100');
      await pool.execute('ALTER TABLE rpg_members DROP COLUMN `limit`');
      console.log('  ~ rpg_members.limit ganda dgn lim — digabung & drop limit');
    }
  } catch (e) {
    console.log(`  ! rpg_members.limit/lim: ${e.message}`);
  }

  // 3) Buat tabel yang belum ada
  for (const sql of CREATE_TABLES) {
    try {
      await pool.execute(sql);
      console.log('  + tabel dibuat');
    } catch (e) {
      console.log(`  ! create: ${e.message}`);
    }
  }

  console.log('\n[Sync] Selesai.');
  await pool.end();
}

run().catch((e) => {
  console.error('[Sync] Gagal:', e.message);
  process.exit(1);
});
