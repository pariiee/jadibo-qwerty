-- test/pangkas-log.sql
--
-- Uji SQL pangkas `bot_logs` yang dipakai cron di server.js (03:00 WIB).
-- Jalankan di MySQL mana pun:  mysql -B jadibot < test/pangkas-log.sql
--
-- Kenapa perlu: DELETE ... NOT IN (SELECT ... FROM tabel_yang_sama) ditolak
-- MySQL dengan error 1093 kalau subquery-nya tidak dibungkus tabel turunan.
-- File ini yang membuktikan bungkusannya benar — tanpa ini, cron-nya cuma
-- nulis error diam-diam tiap malam dan log tetap menumpuk.

DROP TABLE IF EXISTS _uji_log;
CREATE TABLE _uji_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  bot_id INT NOT NULL,
  level VARCHAR(10) NOT NULL DEFAULT 'info',
  message VARCHAR(2000),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- bot 1 = 700 baris (harus jadi 500), bot 2 = 100 baris (harus utuh)
INSERT INTO _uji_log (bot_id, message)
  SELECT 1, CONCAT('a', t1.n, '-', t2.n, '-', t3.n) FROM
  (SELECT 1 n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5
   UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9 UNION ALL SELECT 10) t1,
  (SELECT 1 n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5
   UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9 UNION ALL SELECT 10) t2,
  (SELECT 1 n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5
   UNION ALL SELECT 6 UNION ALL SELECT 7) t3;

INSERT INTO _uji_log (bot_id, message)
  SELECT 2, CONCAT('b', t1.n, '-', t2.n) FROM
  (SELECT 1 n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5
   UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9 UNION ALL SELECT 10) t1,
  (SELECT 1 n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5
   UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9 UNION ALL SELECT 10) t2;

SELECT bot_id, COUNT(*) AS sebelum FROM _uji_log GROUP BY bot_id;

-- ══ SQL YANG SAMA PERSIS DENGAN CRON DI server.js ══════════════════════════
DELETE FROM _uji_log WHERE bot_id = 1
  AND id NOT IN (SELECT id FROM (
        SELECT id FROM _uji_log WHERE bot_id = 1 ORDER BY id DESC LIMIT 500
      ) t);
-- ═══════════════════════════════════════════════════════════════════════════

SELECT bot_id, COUNT(*) AS sesudah FROM _uji_log GROUP BY bot_id;
-- Harapan: 1 → 500, 2 → 100. Kalau muncul error 1093, bungkusan tabel
-- turunan-nya hilang.

DROP TABLE _uji_log;
