-- YaaParBot Database Schema (sinkron dengan kode — jangan edit separuh)
-- Jalankan ke database yang sudah dibuat, nama DB diambil dari .env (DB_NAME):
--   mysql -u <user> -p <nama_db> < schema.sql
-- File ini sengaja TIDAK memuat CREATE DATABASE / USE supaya tidak mengunci
-- nama database — biar bisa dipakai di box mana pun tanpa mengedit file ini.

-- ============================================================
-- Table: settings  (key/value JSON)
-- Sumber tunggal harga paket, QRIS manual, mode bayar, dan pengumuman
-- (`config/pricingStore.js`). Tabel ini SEMPAT HILANG dari schema padahal
-- dibaca setiap boot — instalasi baru akan mati di /admin tanpa ini.
-- ============================================================
CREATE TABLE IF NOT EXISTS settings (
  `key`   VARCHAR(64) NOT NULL,
  `value` TEXT NOT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB;

-- ============================================================
-- Table: users
-- ============================================================
-- Role: `user` | `premium` (turunan langganan aktif, bukan kolom) | `kawula`
-- (admin tertinggi). Nama `kawula` sengaja tidak umum — lihat config/plan.js.
--
-- `ENUM` di sini SEMPAT salah tulis ('user','king') padahal kode memakai
-- `kawula` (ADMIN_ROLE). Di MySQL default (mode ketat), INSERT admin `kawula`
-- GAGAL sehingga instalasi baru tidak punya admin sama sekali; di mode longgar
-- dia tersimpan sebagai string kosong. Dua-duanya bikin `/api/admin/*` mati dan
-- error-nya menyesatkan (`Akses ditolak`, seolah role-nya benar tapi bukan admin).
--
-- Kolom langganan (plan, plan_expired_at, plan_slots, trial_used_at) SEMPAT
-- HILANG dari file ini padahal dibaca setiap request (`/api/auth/me`, billing).
-- Instalasi baru langsung mati dengan ER_BAD_FIELD_ERROR. `scripts/sync-schema.js`
-- yang selama ini menutupi lubangnya untuk DB yang sudah ada — file ini harus
-- berdiri sendiri, karena `schema.sql` yang dipakai bikin DB baru.
--
-- `role` memuat `premium` juga: config/plan.js menghitungnya dari langganan,
-- tapi enumerasi ini pernah diisi `premium` di DB yang berjalan, jadi dibiarkan
-- supaya DB lama dan skema ini tidak berbeda.
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username     VARCHAR(50) NOT NULL UNIQUE,
  password     VARCHAR(255) NOT NULL,
  role         ENUM('user', 'premium', 'kawula', 'king') NOT NULL DEFAULT 'user',
  token_version INT NOT NULL DEFAULT 0,
  phone        VARCHAR(20) DEFAULT NULL,
  email        VARCHAR(254) DEFAULT NULL,
  plan         VARCHAR(32) NOT NULL DEFAULT 'user',
  plan_expired_at DATETIME DEFAULT NULL,
  plan_slots   INT NOT NULL DEFAULT 2,
  trial_used_at DATETIME DEFAULT NULL,
  is_active    TINYINT(1) NOT NULL DEFAULT 1,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_username (username),
  INDEX idx_role (role)
) ENGINE=InnoDB;

-- ============================================================
-- Table: bots
-- ============================================================
CREATE TABLE IF NOT EXISTS bots (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id        INT UNSIGNED NOT NULL,
  platform       ENUM('whatsapp', 'telegram') NOT NULL DEFAULT 'whatsapp',
  bot_name       VARCHAR(100) NOT NULL,
  bot_number     VARCHAR(20) DEFAULT NULL,
  owner_number   VARCHAR(20) DEFAULT NULL,
  owner_name     VARCHAR(100) DEFAULT NULL,
  prefix         VARCHAR(5) NOT NULL DEFAULT '!',
  footer_text    VARCHAR(255) DEFAULT 'Powered by YaaParBot',
  description    TEXT DEFAULT NULL,
  channel_id     VARCHAR(100) DEFAULT NULL,
  qris_url       TEXT DEFAULT NULL,
  banner_url     TEXT DEFAULT NULL,
  main_groups    TEXT DEFAULT NULL,
  daily_limit    INT NOT NULL DEFAULT 20,
  -- Kuota pesan: receive_limit = jatah seumur paket, received_count = terpakai.
  -- Ditegakkan engine/gatePaket.js; peringatannya dari engine/kuota.js.
  receive_limit  INT NOT NULL DEFAULT 0,
  received_count INT NOT NULL DEFAULT 0,
  -- Kenapa bot ini mati ('expired' dari cron paket-habis). Dipakai terapkanPaket
  -- buat menyalakan kembali bot yang dimatikan sistem setelah user bayar.
  stop_reason    VARCHAR(32) DEFAULT NULL,
  sqlite_db_path VARCHAR(500) DEFAULT NULL,
  is_running     TINYINT(1) NOT NULL DEFAULT 0,
  status         ENUM('connected', 'disconnected', 'connecting', 'qr_pending') NOT NULL DEFAULT 'disconnected',
  telegram_token VARCHAR(255) DEFAULT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id),
  INDEX idx_status (status),
  INDEX idx_platform (platform)
) ENGINE=InnoDB;

-- ============================================================
-- Table: stats
-- ============================================================
CREATE TABLE IF NOT EXISTS stats (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  stat_key        VARCHAR(50) NOT NULL UNIQUE,
  stat_value      BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_stat_key (stat_key)
) ENGINE=InnoDB;

-- ============================================================
-- Table: bot_logs  (persisted log entries per bot)
-- NOTE: level disamakan dgn nilai runtime ('info','warn','error','debug','cmd','cmderr')
-- ============================================================
CREATE TABLE IF NOT EXISTS bot_logs (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  bot_id     INT UNSIGNED NOT NULL,
  level      VARCHAR(10) NOT NULL DEFAULT 'info',
  message    TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE,
  INDEX idx_bot_id_created (bot_id, created_at)
) ENGINE=InnoDB;

-- ============================================================
-- Table: warn_records  (warn system per group member)
-- ============================================================
CREATE TABLE IF NOT EXISTS warn_records (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  bot_id      INT UNSIGNED NOT NULL,
  group_jid   VARCHAR(100) NOT NULL,
  member_jid  VARCHAR(100) NOT NULL,
  warn_count  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  warn_limit  TINYINT UNSIGNED NOT NULL DEFAULT 3,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE,
  UNIQUE KEY uq_warn (bot_id, group_jid, member_jid)
) ENGINE=InnoDB;

-- ============================================================
-- Table: blacklist  (banned JIDs per bot)
-- ============================================================
CREATE TABLE IF NOT EXISTS blacklist (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  bot_id     INT UNSIGNED NOT NULL,
  jid        VARCHAR(100) NOT NULL,
  reason     VARCHAR(255) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE,
  UNIQUE KEY uq_blacklist (bot_id, jid)
) ENGINE=InnoDB;

-- ============================================================
-- Table: rpg_members  (RPG profile per WA member)
-- NOTE: kolom pakai `lim` & `healt` (bukan `limit`/`health`) sesuai kode.
-- ============================================================
CREATE TABLE IF NOT EXISTS rpg_members (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  bot_id           INT UNSIGNED NOT NULL,
  jid              VARCHAR(100) NOT NULL,
  name             VARCHAR(100) DEFAULT NULL,
  level            INT UNSIGNED NOT NULL DEFAULT 0,
  xp               BIGINT UNSIGNED NOT NULL DEFAULT 0,
  money            BIGINT NOT NULL DEFAULT 0,
  bank_money       BIGINT NOT NULL DEFAULT 0,
  bank             BIGINT NOT NULL DEFAULT 0,
  koin             BIGINT NOT NULL DEFAULT 0,
  lim              INT NOT NULL DEFAULT 100,
  healt            INT NOT NULL DEFAULT 100,
  -- energi: gerbang biaya mancing/kerja/berburu/tambang/maling/adventure/koboy.
  energi           INT NOT NULL DEFAULT 100,
  last_energi      DATETIME DEFAULT NULL,
  -- last_bertarung: cooldown `.bertarung`/`.fight`.
  last_bertarung   DATETIME DEFAULT NULL,
  sword            INT NOT NULL DEFAULT 0,
  armor            INT NOT NULL DEFAULT 0,
  job              VARCHAR(50) NOT NULL DEFAULT 'Pengangguran',
  jobexp           INT NOT NULL DEFAULT 0,
  hewan_json       JSON DEFAULT NULL,
  registered       TINYINT(1) NOT NULL DEFAULT 0,
  premium          TINYINT(1) NOT NULL DEFAULT 0,
  premium_expired  DATETIME DEFAULT NULL,
  serial           VARCHAR(64) DEFAULT NULL,
  last_claim       DATETIME DEFAULT NULL,
  last_daily       DATETIME DEFAULT NULL,
  last_hourly      DATETIME DEFAULT NULL,
  last_weekly      DATETIME DEFAULT NULL,
  last_dailymisi   DATETIME DEFAULT NULL,
  last_kerja       DATETIME DEFAULT NULL,
  last_gajian      DATETIME DEFAULT NULL,
  last_mancing     DATETIME DEFAULT NULL,
  last_berburu     DATETIME DEFAULT NULL,
  last_dungeon     DATETIME DEFAULT NULL,
  last_adventure   DATETIME DEFAULT NULL,
  last_koboy       DATETIME DEFAULT NULL,
  last_airdrop     DATETIME DEFAULT NULL,
  last_maling      DATETIME DEFAULT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE,
  UNIQUE KEY uq_rpg (bot_id, jid),
  INDEX idx_bot_jid (bot_id, jid)
) ENGINE=InnoDB;

-- ============================================================
-- Table: bot_sewa  (sewa bot per grup — dipakai engine & 05-owner)
-- ============================================================
CREATE TABLE IF NOT EXISTS bot_sewa (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  bot_id       INT UNSIGNED NOT NULL,
  group_jid    VARCHAR(100) NOT NULL,
  group_name   VARCHAR(255) DEFAULT NULL,
  expired_at   BIGINT DEFAULT NULL,
  pending_ms   BIGINT DEFAULT NULL,
  warned       TINYINT(1) NOT NULL DEFAULT 0,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE,
  UNIQUE KEY uq_sewa (bot_id, group_jid)
) ENGINE=InnoDB;

-- ============================================================
-- Table: group_settings  (setting welcome/bye/detect/dll per grup)
-- NOTE: kolom open_time/close_time dipakai cron jadwal buka/tutup
-- ============================================================
CREATE TABLE IF NOT EXISTS group_settings (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  bot_id       INT UNSIGNED NOT NULL,
  group_jid    VARCHAR(100) NOT NULL,
  welcome_msg  TEXT DEFAULT NULL,
  bye_msg      TEXT DEFAULT NULL,
  detect       TINYINT(1) NOT NULL DEFAULT 0,
  autoacc      TINYINT(1) NOT NULL DEFAULT 0,
  document     TINYINT(1) NOT NULL DEFAULT 0,
  open_time    VARCHAR(5) DEFAULT NULL,
  close_time   VARCHAR(5) DEFAULT NULL,
  limit_daily  INT DEFAULT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE,
  UNIQUE KEY uq_bot_group (bot_id, group_jid)
) ENGINE=InnoDB;

-- ============================================================
-- Table: group_ban  (ban lokal per grup — 02-group)
-- ============================================================
CREATE TABLE IF NOT EXISTS group_ban (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  bot_id       INT UNSIGNED NOT NULL,
  group_jid    VARCHAR(100) NOT NULL,
  jid          VARCHAR(100) NOT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE,
  UNIQUE KEY uq_group_ban (bot_id, group_jid, jid)
) ENGINE=InnoDB;

-- ============================================================
-- Table: auto_respon  (auto-reply trigger — 05-owner)
-- ============================================================
CREATE TABLE IF NOT EXISTS auto_respon (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  bot_id       INT UNSIGNED NOT NULL,
  trigger_key  VARCHAR(255) NOT NULL,
  response     TEXT NOT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE,
  INDEX idx_bot_trigger (bot_id, trigger_key)
) ENGINE=InnoDB;

-- ============================================================
-- Table: gudang_list  (list/gudang owner — 05-owner)
-- ============================================================
CREATE TABLE IF NOT EXISTS gudang_list (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  bot_id       INT UNSIGNED NOT NULL,
  list_key     VARCHAR(100) NOT NULL,
  description  TEXT,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE,
  INDEX idx_bot_key (bot_id, list_key)
) ENGINE=InnoDB;

-- ============================================================
-- Seed: default stats counters
-- ============================================================
INSERT IGNORE INTO stats (stat_key, stat_value) VALUES
  ('total_bots_online', 0),
  ('total_users',       0),
  ('total_messages',    0);

-- Pesanan langganan. Dipakai billingController (checkout / cekOrder / webhook).
-- Bentuknya disamakan dengan yang sudah jalan di produksi.
CREATE TABLE IF NOT EXISTS orders (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id     VARCHAR(64) NOT NULL,
  user_id      INT UNSIGNED NOT NULL,
  plan         VARCHAR(32) NOT NULL,
  amount       INT UNSIGNED NOT NULL,
  method       VARCHAR(32) NOT NULL DEFAULT 'qris',
  status       VARCHAR(16) NOT NULL DEFAULT 'pending',
  gateway_ref  VARCHAR(120) DEFAULT NULL,
  qr_payload   TEXT DEFAULT NULL,
  qr_image     TEXT DEFAULT NULL,
  proof_url    TEXT DEFAULT NULL,
  note         VARCHAR(255) DEFAULT NULL,
  expired_at   DATETIME DEFAULT NULL,
  paid_at      DATETIME DEFAULT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY order_id (order_id),
  INDEX idx_user (user_id),
  INDEX idx_status (status)
);
