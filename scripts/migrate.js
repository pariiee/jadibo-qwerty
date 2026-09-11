'use strict';
const { pool } = require('../config/database');

async function run() {
  await pool.execute(`
    ALTER TABLE rpg_members
      ADD COLUMN healt int NOT NULL DEFAULT 100 AFTER bank_money,
      ADD COLUMN sword int NOT NULL DEFAULT 0 AFTER healt,
      ADD COLUMN armor int NOT NULL DEFAULT 0 AFTER sword,
      ADD COLUMN job varchar(50) NOT NULL DEFAULT 'Pengangguran' AFTER armor,
      ADD COLUMN jobexp int NOT NULL DEFAULT 0 AFTER job,
      ADD COLUMN hewan_json json DEFAULT NULL AFTER jobexp,
      ADD COLUMN last_berburu datetime DEFAULT NULL AFTER last_mancing,
      ADD COLUMN last_gajian datetime DEFAULT NULL AFTER last_berburu,
      ADD COLUMN last_dungeon datetime DEFAULT NULL AFTER last_gajian
  `);
  console.log('rpg_members OK');

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS group_settings (
      id int unsigned NOT NULL AUTO_INCREMENT,
      bot_id int unsigned NOT NULL,
      group_jid varchar(100) NOT NULL,
      welcome_msg text DEFAULT NULL,
      bye_msg text DEFAULT NULL,
      created_at datetime DEFAULT CURRENT_TIMESTAMP,
      updated_at datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_bot_group (bot_id, group_jid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log('group_settings OK');

  pool.end();
}

run().catch(e => { console.error(e.message); process.exit(1); });
