'use strict';

const mysql = require('mysql2/promise');
require('dotenv').config();

const { ADMIN_ROLE } = require('./roles');

// ─── Connection Pool ──────────────────────────────────────────────────────────
const pool = mysql.createPool({
  host:            process.env.DB_HOST     || 'localhost',
  port:            parseInt(process.env.DB_PORT || '3306', 10),
  user:            process.env.DB_USER     || 'root',
  password:        process.env.DB_PASS     || '',
  database:        process.env.DB_NAME     || 'yaaparbot',
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  charset:         'utf8mb4',
  timezone:        '+00:00',
});

/**
 * Test the MySQL connection and log result.
 */
async function testConnection() {
  try {
    const conn = await pool.getConnection();
    console.log('[DB] MySQL connected successfully');
    conn.release();
  } catch (err) {
    console.error('[DB] MySQL connection failed:', err.message || err.code || JSON.stringify(err));
    // Hanya exit saat startup (dipanggil dari server init)
    // Jangan exit saat runtime — pool akan retry otomatis
    if (process.env.DB_EXIT_ON_FAIL === 'true') process.exit(1);
  }
}

/**
 * Ensure default stats rows and king account exist.
 * @param {string} kingUsername
 * @param {string} hashedPassword
 */
async function seedDefaults(kingUsername, hashedPassword) {
  // Stats seed.
  //
  // HANYA `total_messages`: dia kumulatif (tidak pernah dikurangi), jadi
  // counter-nya bisa dipercaya. `total_bots_online` dan `total_users` TIDAK
  // di-seed karena sudah tidak di-maintain — keduanya DIHITUNG dari tabelnya
  // saat dibaca (getStats()), biar tidak ada dua sumber yang bisa bertentangan.
  await pool.execute(
    `INSERT IGNORE INTO stats (stat_key, stat_value) VALUES
     ('total_messages', 0)`
  );

  // Admin seed (role `kawula` — lihat config/roles.js)
  const [rows] = await pool.execute(
    'SELECT id FROM users WHERE role = ? LIMIT 1',
    [ADMIN_ROLE]
  );
  if (rows.length === 0) {
    await pool.execute(
      'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
      [kingUsername, hashedPassword, ADMIN_ROLE]
    );
    console.log(`[DB] Admin account created: ${kingUsername}`);
  }
}

/**
 * Atomically increment a stat counter.
 * @param {string} key
 * @param {number} amount
 */
async function incrementStat(key, amount = 1) {
  await pool.execute(
    `INSERT INTO stats (stat_key, stat_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE stat_value = stat_value + ?`,
    [key, amount, amount]
  );
}

/**
/**
 * Fetch all stats as a plain object.
 *
 * Dua angka di sini tampil di LANDING PAGE (publik, tanpa login) dan
 * counter-nya tidak bisa dipercaya:
 *
 *   - `total_bots_online` di-increment tiap event `connection: open` — jadi
 *     sekali per reconnect DAN sekali per boot proses — sementara decrement-nya
 *     cuma jalan kalau prosesnya sempat putus dengan rapi. pm2 restart / crash
 *     tidak pernah menjalankannya. Terbukti LIVE: landing page menulis
 *     "306 bot online" padahal botnya 1, dan angkanya naik terus.
 *   - `total_users` sama polanya (register +1, delete -1) → tampil 5 dari 2.
 *
 * Jadi keduanya DIHITUNG dari tabelnya langsung, bukan dibaca dari counter.
 * Sumber kebenarannya sudah ada dan sudah dipakai `/health` — satu definisi
 * "bot online" untuk seluruh aplikasi: `bots.status = 'connected'`.
 *
 * `total_messages` tetap dari counter: dia kumulatif (tidak pernah dikurangi),
 * jadi tidak punya masalah yang sama.
 *
 * @returns {Promise<{total_bots_online: number, total_users: number, total_messages: number}>}
 */
async function getStats() {
  const [rows] = await pool.execute('SELECT stat_key, stat_value FROM stats');
  const out = rows.reduce((acc, row) => {
    acc[row.stat_key] = Number(row.stat_value);
    return acc;
  }, {});

  const [[b]] = await pool.execute("SELECT SUM(status = 'connected') AS n FROM bots");
  const [[u]] = await pool.execute('SELECT COUNT(*) AS n FROM users');
  out.total_bots_online = Number(b?.n || 0);
  out.total_users = Number(u?.n || 0);
  try {
    const { ALL_COMMANDS } = require('../plugins/01-info');
    out.total_commands = Number(ALL_COMMANDS?.length || 0);
  } catch {
    out.total_commands = 0;
  }
  return out;
}

module.exports = { pool, testConnection, seedDefaults, incrementStat, getStats };
