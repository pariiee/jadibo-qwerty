'use strict';

const mysql = require('mysql2/promise');
require('dotenv').config();

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
  // Stats seed
  await pool.execute(
    `INSERT IGNORE INTO stats (stat_key, stat_value) VALUES
     ('total_bots_online', 0),
     ('total_users', 0),
     ('total_messages', 0)`
  );

  // King seed
  const [rows] = await pool.execute(
    'SELECT id FROM users WHERE role = ? LIMIT 1',
    ['king']
  );
  if (rows.length === 0) {
    await pool.execute(
      'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
      [kingUsername, hashedPassword, 'king']
    );
    await incrementStat('total_users');
    console.log(`[DB] King account created: ${kingUsername}`);
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
 * Atomically decrement a stat counter (floor at 0).
 * @param {string} key
 * @param {number} amount
 */
async function decrementStat(key, amount = 1) {
  await pool.execute(
    `UPDATE stats SET stat_value = IF(stat_value >= ?, stat_value - ?, 0) WHERE stat_key = ?`,
    [amount, amount, key]
  );
}

/**
 * Fetch all stats as a plain object.
 * @returns {Promise<{total_bots_online: number, total_users: number, total_messages: number}>}
 */
async function getStats() {
  const [rows] = await pool.execute('SELECT stat_key, stat_value FROM stats');
  const acc = rows.reduce((acc, row) => {
    acc[row.stat_key] = Number(row.stat_value);
    return acc;
  }, {});
  // total_bots_online DIHITUNG, bukan dibaca dari counter: counter-nya drift
  // (increment tiap connect, decrement tiap close/stop — event yang kelewat
  // bikin angkanya ngawur, pernah kebaca 493 padahal bot cuma 1). Tulisan ke
  // kolom stats-nya dibiarin, cuma nggak dibaca lagi.
  const [[{ n }]] = await pool.execute('SELECT COUNT(*) AS n FROM bots WHERE is_running = 1');
  acc.total_bots_online = Number(n);
  return acc;
}

module.exports = { pool, testConnection, seedDefaults, incrementStat, decrementStat, getStats };
