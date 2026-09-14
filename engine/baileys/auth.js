'use strict';

/**
 * engine/baileys/auth.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Auth state Baileys v7 di SQLite (better-sqlite3).
 *
 * Kenapa SQLite, bukan useMultiFileAuthState:
 *   - 1 file (`session.db`) bukan ratusan file JSON di folder — gampang
 *     di-backup, gampang dihapus, nggak kena masalah EPERM di Windows.
 *   - Tulis sinkron (better-sqlite3) = nggak ada race antar key saat
 *     handshake, itu yg bikin signal error intermitten.
 *
 * KOMPATIBEL SESI LAMA: tabel baru dibuat dgn `IF NOT EXISTS`, file session.db
 * engine lama yang sudah ada nggak diapa-apakan. Kalau creds belum ada, dianggap baru
 * dan langsung pairing/QR — jadi nggak perlu hapus sesi manual.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { initAuthCreds, BufferJSON, proto } = require('baileys');

function makeSqliteAuthState(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  // WAL: baca nggak blokir tulis, penting karena keys dibaca sangat sering.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS auth (
      id   TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
  `);

  const readStmt = db.prepare('SELECT data FROM auth WHERE id = ?');
  const writeStmt = db.prepare(
    'INSERT INTO auth (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data'
  );
  const delStmt = db.prepare('DELETE FROM auth WHERE id = ?');

  const read = (id) => {
    const row = readStmt.get(id);
    if (!row) return null;
    try { return JSON.parse(row.data, BufferJSON.reviver); } catch { return null; }
  };
  const write = (id, value) =>
    writeStmt.run(id, JSON.stringify(value, BufferJSON.replacer));

  const creds = read('creds') || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          for (const id of ids) {
            let value = read(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            out[id] = value;
          }
          return out;
        },
        set: async (data) => {
          // better-sqlite3 sinkron, jadi satu transaksi = batch ini atomik.
          db.transaction(() => {
            for (const type of Object.keys(data)) {
              for (const id of Object.keys(data[type] || {})) {
                const value = data[type][id];
                if (value) write(`${type}-${id}`, value);
                else delStmt.run(`${type}-${id}`);
              }
            }
          })();
        },
      },
    },
    saveCreds: () => write('creds', creds),
    close: () => { try { db.close(); } catch {} },
    // Penanda buat engine: nutup handle SQLite sebelum hapus folder sesi.
    __closeAuth: () => { try { db.close(); } catch {} },
  };
}

module.exports = { makeSqliteAuthState };
