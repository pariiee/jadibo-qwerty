'use strict';

const path   = require('path');
const fs     = require('fs');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../config/database');
const { ADMIN_ROLE, slotsOf, ownerMax, receiveLimit } = require('../config/plan');
const pricingStore = require('../config/pricingStore');

const SESSIONS_DIR = path.resolve(process.env.SESSIONS_DIR || './sessions');

// State bot hidup di engine (satu proses dengan panel ini): `activeBots` dkk
// tinggal di engine/runtime.js. Engine yang nyimpen, rute web baca dari sini.
const { activeBots, activeGroupsPerBot, activeChannelsPerBot } = require('../engine/runtime');
// Perintah nyala/matiin bot tetap lewat bus — biar controller nggak perlu tahu
// engine-nya di proses mana (di panel zapo: proses ini juga).
const engineBus = require('../config/engineBus');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendError(res, status, message) {
  return res.status(status).json({ ok: false, message });
}

// Pesan engine itu buat kita, bukan buat user: cuma kalimat yang jelas
// manusiawi yang diteruskan, sisanya jadi pesan umum (jangan bocorin path/errno).
// Pesan dari worker (lewat engineBus) itu kalimat yang kita tulis sendiri, jadi
// diteruskan apa adanya. Yang diganti cuma error mentah: jangan sampai user
// lihat path/errno/stack.
const STATUS_MANUSIA = new Set([400, 403, 404, 409, 503, 504]);
function pesanManusia(e, fallback = 'Terjadi kesalahan server') {
  const st = Number(e?.status) || 0;
  const m = String(e?.message || '');
  return m && STATUS_MANUSIA.has(st) ? m : fallback;
}

function getBotDir(botId) {
  return path.join(SESSIONS_DIR, `bot_${botId}`);
}

function getDbPath(botId) {
  return path.join(getBotDir(botId), 'session.db');
}

/**
 * Ensure the user owns this bot (or is admin tertinggi).
 */
async function assertOwnership(req, res, botId) {
  const [rows] = await pool.execute(
    'SELECT id, user_id FROM bots WHERE id = ?',
    [botId]
  );
  if (rows.length === 0) { sendError(res, 404, 'Bot tidak ditemukan'); return null; }
  const bot = rows[0];
  if (req.user.role !== ADMIN_ROLE && bot.user_id !== req.user.id) {
    sendError(res, 403, 'Akses ditolak');
    return null;
  }
  return bot;
}

/**
 * Masking token Telegram: tampilkan hanya 4 digit terakhir.
 * Token asli tetap tersimpan di DB — dipakai engine saat start.
 */
function maskToken(token) {
  if (!token) return null;
  // Format: <bot_id>:<35-char secret>
  const parts = String(token).split(':');
  if (parts.length < 2) return '••••••••';
  const secret = parts[1];
  const masked = secret.length > 4
    ? '•'.repeat(secret.length - 4) + secret.slice(-4)
    : '•'.repeat(secret.length);
  return `${parts[0]}:${masked}`;
}

function publicBot(bot) {
  if (!bot) return bot;
  const { telegram_token, ...rest } = bot;
  return { ...rest, telegram_token: maskToken(telegram_token) };
}

// ─── GET /api/bots ────────────────────────────────────────────────────────────

async function listBots(req, res) {
  try {
    const isKing = req.user.role === ADMIN_ROLE;
    // cmd_count = statistik pemakaian per bot (jumlah command yang benar-benar
    // dijalankan). Subquery, bukan JOIN + GROUP BY — jumlah bot masih kecil.
    const kolom = `b.*, (SELECT COUNT(*) FROM bot_logs l WHERE l.bot_id = b.id AND l.level = 'cmd') AS cmd_count, (SELECT kt.jumlah FROM kuota_tambahan kt WHERE kt.bot_id = b.id) AS bonus_kuota`;
    // Pencarian & batas DI SQL, bukan tarik-semua-lalu-saring-di-browser: begitu
    // botnya ratusan, cara lama bikin /admin lemot + payload gede.
    // ponytail: LIMIT tanpa OFFSET. Tambah halaman kalau ada yang punya >500 bot.
    const limit = Math.min(parseInt(req.query.limit || '500', 10) || 500, 500);
    const q = String(req.query.q || '').trim().slice(0, 60);

    let where = '';
    const params = [];
    if (q) { where += ' AND (b.bot_name LIKE ? OR u.username LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
    if (!isKing) { where += ' AND b.user_id = ?'; params.push(req.user.id); }

    const query = isKing
      ? `SELECT ${kolom}, u.username FROM bots b JOIN users u ON u.id = b.user_id
         WHERE 1=1${where} ORDER BY b.created_at DESC LIMIT ${limit}`
      : `SELECT ${kolom}, NULL AS username FROM bots b
         WHERE 1=1${where} ORDER BY b.created_at DESC LIMIT ${limit}`;

    const [bots] = await pool.execute(query, params);
    // publicBot() nge-`...rest` → username yang di-JOIN KEHILANGAN. Ambil dulu.
    const enriched = bots.map(b => ({
      ...publicBot(b),
      username: b.username,
      // is_running harus dari DB (di-update engine pas connected/disconnected),
      // bukan activeBots.has() — Map itu ke-set SEBELUM connect selesai,
      // jadi polling frontend salah anggap 'connected' & nutup QR yang baru muncul.
      is_running: b.is_running === 1,
    }));
    return res.json({ ok: true, bots: enriched });
  } catch (err) {
    console.error('[Bot] listBots error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── GET /api/bots/:id ────────────────────────────────────────────────────────

async function getBot(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    const [rows] = await pool.execute('SELECT * FROM bots WHERE id = ?', [req.params.id]);
    return res.json({
      ok: true,
      bot: { ...publicBot(rows[0]), is_running: rows[0].is_running === 1 },
    });
  } catch (err) {
    console.error('[Bot] getBot error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── POST /api/bots ───────────────────────────────────────────────────────────

async function createBot(req, res) {
  try {
    // Slot check — bolehnya berapa bot ditentukan paket langganan user.
    const [me] = await pool.execute(
      'SELECT role, plan, plan_expired_at, plan_slots FROM users WHERE id = ?',
      [req.user.id]
    );
    const maks = slotsOf(me[0], pricingStore.plans());
    if (maks < 999) {
      const [count] = await pool.execute(
        'SELECT COUNT(*) AS c FROM bots WHERE user_id = ?',
        [req.user.id]
      );
      if (count[0].c >= maks)
        return sendError(res, 400, maks === 0
          ? 'Akun kamu belum punya slot bot. Klaim Trial gratis atau pilih paket di halaman Pricing.'
          : `Slot penuh. Paket kamu maksimal ${maks} bot — upgrade untuk tambah slot.`);
    }

    const {
      platform = 'whatsapp',
      bot_name,
      bot_number,
      owner_number,
      prefix = '!',
      footer_text = 'Powered by YaaParBot',
      description = '',
      telegram_token = null,
    } = req.body;

    if (!bot_name) return sendError(res, 400, 'Nama bot wajib diisi');
    if (platform === 'telegram' && !telegram_token)
      return sendError(res, 400, 'Token Telegram wajib diisi untuk platform Telegram');

    // Owner number = nomor yang dianggap owner bot. Jumlahnya dibatasi paket.
    const ownerMaxN = ownerMax(me[0], pricingStore.plans());
    const jumlahOwner = String(owner_number || '').split(',').map((s) => s.trim()).filter(Boolean).length;
    if (jumlahOwner > ownerMaxN)
      return sendError(res, 400, ownerMaxN === 0
        ? 'Paket kamu belum bisa pakai Owner Number. Upgrade di halaman Pricing.'
        : `Paket kamu maksimal ${ownerMaxN} Owner Number.`);

    const [result] = await pool.execute(
      `INSERT INTO bots
         (user_id, platform, bot_name, bot_number, owner_number, prefix, footer_text,
          description, telegram_token, receive_limit, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'disconnected')`,
      [req.user.id, platform, bot_name, bot_number || null, owner_number || null,
       prefix, footer_text, description, telegram_token,
       receiveLimit(me[0], pricingStore.plans())]
    );

    const botId = result.insertId;
    const dbPath = getDbPath(botId);

    // Create session directory
    fs.mkdirSync(getBotDir(botId), { recursive: true });

    // Save sqlite path
    await pool.execute(
      'UPDATE bots SET sqlite_db_path = ? WHERE id = ?',
      [dbPath, botId]
    );

    return res.status(201).json({
      ok: true,
      message: 'Bot berhasil dibuat',
      bot_id: botId,
    });
  } catch (err) {
    console.error('[Bot] createBot error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── PATCH /api/bots/:id ──────────────────────────────────────────────────────

async function updateBot(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    const allowed = ['bot_name', 'bot_number', 'owner_number', 'owner_name', 'prefix', 'footer_text', 'description', 'telegram_token', 'channel_id', 'qris_url', 'banner_url', 'main_groups', 'daily_limit'];
    const sets = [];
    const vals = [];

    // Batas owner number juga berlaku saat edit, bukan cuma saat bikin bot.
    if (req.body.owner_number !== undefined) {
      const [me] = await pool.execute(
        'SELECT role, plan, plan_expired_at FROM users WHERE id = ?', [req.user.id]);
      const maks = ownerMax(me[0], pricingStore.plans());
      const n = String(req.body.owner_number || '').split(',').map((s) => s.trim()).filter(Boolean).length;
      if (n > maks)
        return sendError(res, 400, maks === 0
          ? 'Paket kamu belum bisa pakai Owner Number. Upgrade di halaman Pricing.'
          : `Paket kamu maksimal ${maks} Owner Number.`);
    }

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        // Token masked (•••) dari FE jangan ditimpa ke DB — pertahankan token asli
        if (key === 'telegram_token' && String(req.body[key]).includes('•')) continue;
        sets.push(`${key} = ?`);
        vals.push(req.body[key]);
      }
    }

    if (sets.length === 0) return sendError(res, 400, 'Tidak ada field yang diubah');

    vals.push(req.params.id);
    await pool.execute(`UPDATE bots SET ${sets.join(', ')} WHERE id = ?`, vals);

    return res.json({ ok: true, message: 'Bot diperbarui' });
  } catch (err) {
    console.error('[Bot] updateBot error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── DELETE /api/bots/:id ─────────────────────────────────────────────────────

async function deleteBot(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    // Matiin dulu lewat worker — kalau nggak, auto-reconnect engine nyalain
    // ulang bot yang folder sesinya lagi dihapus.
    await engineBus.stopIfRunning(bot.id);

    // Remove session folder — retry karena Windows bisa hold file SQLite
    const dir = getBotDir(bot.id);
    if (fs.existsSync(dir)) {
      let deleted = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          deleted = true;
          break;
        } catch (e) {
          if (e.code === 'EPERM' || e.code === 'EBUSY') {
            await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
          } else {
            throw e;
          }
        }
      }
      if (!deleted) console.error(`[Bot] deleteBot: folder ${dir} gagal dihapus setelah 5x retry`);
    }

    await pool.execute('DELETE FROM bots WHERE id = ?', [bot.id]);

    return res.json({ ok: true, message: 'Bot dihapus' });
  } catch (err) {
    console.error('[Bot] deleteBot error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── POST /api/bots/:id/start ─────────────────────────────────────────────────

async function startBot(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    const [rows] = await pool.execute('SELECT * FROM bots WHERE id = ?', [bot.id]);
    const botData = rows[0];

    // Engine-nya ada di proses lain — kirim perintah, bukan panggil fungsi.
    const usePairingCode = req.body.use_pairing_code === true;
    // Jawaban diambil dari worker, bukan dari cermin lokal — cermin bisa basi,
    // dan guard "bot sudah berjalan" yang salah bikin bot nggak bisa dinyalain.
    const out = await engineBus.start(bot.id, usePairingCode);
    return res.json({ ok: true, message: out.message });
  } catch (err) {
    console.error('[Bot] startBot error:', err);
    return sendError(res, err.status || 500, pesanManusia(err));
  }
}

// ─── POST /api/bots/:id/stop ──────────────────────────────────────────────────

async function stopBot(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    // Nggak ada guard cermin di sini: worker yang tau pasti statusnya dan dia
    // yang jawab. Guard lokal cuma bisa salah (cermin ke-isi 'running' dari
    // auto-start saat worker belum selesai baca DB) -> tombol stop mati.
    const out = await engineBus.stop(bot.id);

    return res.json({ ok: true, message: out.message });
  } catch (err) {
    console.error('[Bot] stopBot error:', err);
    return sendError(res, err.status || 500, pesanManusia(err));
  }
}

// ─── POST /api/bots/:id/restart ───────────────────────────────────────────────

async function restartBot(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    // Satu jalur restart, di worker: command WA .restart dan tombol ini
    // nggak boleh punya logika masing-masing (dulu pernah, hasilnya beda).
    const out = await engineBus.restart(bot.id);
    return res.json({ ok: true, message: out.message });
  } catch (err) {
    console.error('[Bot] restartBot error:', err);
    return sendError(res, err.status || 500, pesanManusia(err));
  }
}

// ─── POST /api/bots/:id/clear-session ────────────────────────────────────────

async function clearSession(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    await engineBus.stopIfRunning(bot.id);

    // Hapus sesi — retry karena Windows bisa hold file SQLite walau socket udah tutup
    const dir = getBotDir(bot.id);
    if (fs.existsSync(dir)) {
      let deleted = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          deleted = true;
          break;
        } catch (e) {
          if (e.code === 'EPERM' || e.code === 'EBUSY') {
            // Windows masih hold file — tunggu lalu retry
            await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
          } else {
            throw e; // error lain langsung lempar
          }
        }
      }
      if (!deleted) {
        // Fallback: rename folder lama, buat folder baru bersih
        const oldDir = dir + '_old_' + Date.now();
        fs.renameSync(dir, oldDir);
        console.log(`[Bot] clearSession: folder ${dir} tidak bisa dihapus — direname ke ${oldDir}`);
      }
    }
    fs.mkdirSync(dir, { recursive: true });

    await pool.execute(
      "UPDATE bots SET status = 'disconnected', is_running = 0, sqlite_db_path = ? WHERE id = ?",
      [getDbPath(bot.id), bot.id]
    );

    // Log lama ikut dibuang — kalau nggak, panel nge-replay riwayat sesi
    // sebelumnya pas dibuka, keliatan kayak kejadian baru.
    await pool.execute('DELETE FROM bot_logs WHERE bot_id = ?', [bot.id]);

    return res.json({ ok: true, message: 'Sesi dihapus. Bot perlu scan QR ulang.' });
  } catch (err) {
    console.error('[Bot] clearSession error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── GET /api/bots/:id/logs ───────────────────────────────────────────────────
// ponytail: tanpa halaman/`sebelum_id`, cuma `limit` (maks 500). Cukup selama
// log satu bot masih bisa di-scroll; tambah cursor `id < ?` kalau sudah tidak.
async function getBotLogs(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const [logs] = await pool.execute(
      'SELECT * FROM bot_logs WHERE bot_id = ? ORDER BY created_at DESC LIMIT ?',
      [bot.id, limit]
    );

    return res.json({ ok: true, logs: logs.reverse() });
  } catch (err) {
    console.error('[Bot] getBotLogs error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── GET /api/bots/:id/stats ──────────────────────────────────────────────────
// Statistik dari `bot_logs` yang SUDAH ada — 0 tabel baru. Bentuk barisnya
// (engine/whatsappEngine.js:775-790 logLineDisplay):
//   cmd  : `Nama: .tt link`        (yg kehitung cuma `cmd`, `cmderr` dibuang)
//   info : `Nama: teks` atau `Nama: .s` (command yg nggak dibalas)
// Jadi kolom pertama = NAMA USER: `cmd` = pemakai command, `info` = yang nulis.
// Statistik dibaca dari pola TEKS `bot_logs.message`, bukan kolom terstruktur.
// Formatnya ditulis di engine/whatsappEngine.js:1066-1068 dan sudah dicek ke
// 25 baris produksi (VPS B):
//   grup  : "<Nama> @ <Nama Grup>: <.cmd argumen> (+4983ms)"
//   DM    : "<Nama>: <.cmd argumen> (+814ms)"
//   media : "<Nama> @ <Nama Grup> [stiker] (+12ms)"      ← body kosong, nggak ada ": "
// Yang gampang salah: " @ " itu pemisah nama↔grup dan letaknya SEBELUM ": ",
// bukan sesudah command. Sisa ekor yang harus dibuang cuma " (+Nms)" dan " [tipe]".
//
// Batas yang diketahui (bukan bug, tapi bisa salah hitung):
//   - nama grup yang mengandung ": " bikin potongan nama/command meleset
//   - nama pengirim yang mengandung " @ " dianggap pemisah grup
// Keduanya cuma bikin satu baris salah hitung, bukan bikin halaman error.
// Kalau ini keliru di data nyata, jalan keluarnya: simpan `sender_name` sebagai
// kolom sendiri di bot_logs, bukan nambah regex.
const ADA_AT   = `LOCATE(' @ ', message) > 0`;
const ADA_KOLOM = `LOCATE(': ', message) > 0`;
const AT_DULU  = `(${ADA_AT} AND (NOT ${ADA_KOLOM} OR LOCATE(' @ ', message) < LOCATE(': ', message)))`;
const NAMA = `TRIM(REGEXP_REPLACE(REGEXP_REPLACE(IF(${AT_DULU},
  SUBSTRING_INDEX(message, ' @ ', 1),
  SUBSTRING_INDEX(message, ': ', 1)),
  ' \\\\(\\\\+[0-9]+ms\\\\)$', ''), ' \\\\[[^]]*\\\\]$', ''))`;
const GRUP = `TRIM(IF(${AT_DULU},
  REGEXP_REPLACE(REGEXP_REPLACE(
    SUBSTRING_INDEX(SUBSTRING(message, LOCATE(' @ ', message) + 3), ': ', 1),
    ' \\\\(\\\\+[0-9]+ms\\\\)$', ''), ' \\\\[[^]]*\\\\]$', ''),
  ''))`;
// Isi pesan = semuanya setelah ": " pertama, minus ekor " (+Nms)".
const BODY = `TRIM(REGEXP_REPLACE(SUBSTRING(message, LOCATE(': ', message) + 2), ' \\\\(\\\\+[0-9]+ms\\\\)$', ''))`;
// Nama command = token PERTAMA isi pesan ('.tt video lucu' → '.tt').
// Baris media nggak punya ": " → BODY kosong → CMD kosong → kebuang filter '.%'.
// Command yang cuma titik ('.' / '..') dibuang: itu bukan command, nggak ada di
// registry (scripts/audit-cmd.js), cuma ketikan nyasar.
const CMD   = `TRIM(SUBSTRING_INDEX(${BODY}, ' ', 1))`;
// CAST('4983ms' AS UNSIGNED) = 4983 — nggak butuh lookahead regex.
const WAKTU = `CAST(REGEXP_SUBSTR(message, '[0-9]+ms') AS UNSIGNED)`;

// Baris yang beneran pesan user. Baris sistem (lifecycle engine: "Memulai bot
// ...", "Bot terhubung ke WhatsApp", "Paired sebagai") juga masuk level 'info',
// tapi nggak punya ": " maupun " @ " — dan NAMA-nya jadi seluruh isi baris.
// Efek samping yang diterima: media di DM (nggak ada ": ") ikut kebuang.
const BARIS_USER = `(${ADA_KOLOM} OR ${ADA_AT})`;
const CMD_OK = `cmd LIKE '.%' AND TRIM(BOTH '.' FROM cmd) <> ''`;

async function getBotStats(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    const hari = Math.min(Math.max(parseInt(req.query.hari || '30', 10) || 30, 1), 365);

    // `info` = tiap pesan masuk, `cmd` = yang beneran dibalas. Baris `info`
    // (termasuk media) tetap kehitung sebagai aktivitas user.
    const [[ringkas]] = await pool.execute(
      `SELECT
         SUM(level = 'cmd')    AS cmd_total,
         SUM(level = 'cmderr') AS err_total,
         SUM(level = 'limit')  AS limit_total,
         COUNT(*)              AS baris_total,
         COUNT(DISTINCT IF(level IN ('cmd','info') AND ${BARIS_USER}, ${NAMA}, NULL)) AS usr_total,
         COUNT(DISTINCT IF(level = 'cmd' AND ${BARIS_USER}, ${CMD}, NULL))           AS cmd_unik
       FROM bot_logs WHERE bot_id = ?`,
      [bot.id]
    );

    const [cmd] = await pool.execute(
      `SELECT ${CMD} AS cmd, COUNT(*) AS n, AVG(${WAKTU}) AS ms
         FROM bot_logs
        WHERE bot_id = ? AND level = 'cmd' AND ${ADA_KOLOM}
        GROUP BY cmd HAVING ${CMD_OK}
        ORDER BY n DESC, cmd LIMIT 12`,
      [bot.id]
    );

    const [usr] = await pool.execute(
      `SELECT
         ${NAMA} AS nama,
         ${GRUP} AS grup,
         SUM(level = 'cmd') AS ncmd,
         COUNT(*) AS n,
         MAX(created_at) AS terakhir
       FROM bot_logs
      WHERE bot_id = ? AND level IN ('cmd','info') AND ${BARIS_USER}
      GROUP BY nama, grup ORDER BY n DESC LIMIT 15`,
      [bot.id]
    );

    const [harian] = await pool.execute(
      `SELECT DATE(created_at) AS tgl, COUNT(*) AS n
         FROM bot_logs
        WHERE bot_id = ? AND level = 'cmd' AND created_at >= NOW() - INTERVAL ? DAY
        GROUP BY tgl ORDER BY tgl`,
      [bot.id, hari]
    );

    // Command yang sering gagal. `cmderr` punya dua bentuk: baris command biasa
    // (level cmd yang gagal) dan 'handler: <pesan>' dari engine @1072 — yang
    // kedua nggak punya nama command, jadi kebuang sendiri sama filter '.%'.
    const [error] = await pool.execute(
      `SELECT ${CMD} AS cmd, COUNT(*) AS n
         FROM bot_logs
        WHERE bot_id = ? AND level = 'cmderr' AND ${ADA_KOLOM}
        GROUP BY cmd HAVING cmd LIKE '.%'
        ORDER BY n DESC LIMIT 8`,
      [bot.id]
    );

    return res.json({
      ok: true,
      ringkas: {
        cmd_total:   Number(ringkas.cmd_total || 0),
        cmd_unik:    Number(ringkas.cmd_unik || 0),
        user_aktif:  Number(ringkas.usr_total || 0),
        err_total:   Number(ringkas.err_total || 0),
        limit_total: Number(ringkas.limit_total || 0),
        baris_total: Number(ringkas.baris_total || 0),
        hari,
      },
      // nama = pushName (kalau kosong jatuh ke nomor, lihat engine @775)
      cmd: cmd.map(c => ({ ...c, n: Number(c.n), ms: c.ms === null ? null : Math.round(Number(c.ms)) })),
      user: usr.map(u => ({ ...u, ncmd: Number(u.ncmd || 0), n: Number(u.n || 0) })),
      error: error.map(e => ({ ...e, n: Number(e.n) })),
      harian,
    });
  } catch (err) {
    console.error('[Bot] getBotStats error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── GET /api/bots/:id/config ─────────────────────────────────────────────────
// Export config sebagai file JSON (atribut `download` di FE yang ngunduh).
// Token Telegram IKUT tapi sudah DIMASK publicBot() — jadi file ini aman
// di-share, dan import nggak akan pernah nimpa token asli.
async function exportConfig(req, res) {
  try {
    // assertOwnership cuma nge-SELECT id+user_id (buat cek hak akses). Untuk
    // export butuh baris UTUH — kalau nggak, file-nya cuma isi {id:1}.
    const own = await assertOwnership(req, res, req.params.id);
    if (!own) return;
    const [[bot]] = await pool.execute('SELECT * FROM bots WHERE id = ?', [own.id]);
    if (!bot) return sendError(res, 404, 'Bot tidak ditemukan');

    // Buang yang bukan config — biar file-nya bersih waktu di-import balik.
    const { id, user_id, is_running, status, sqlite_db_path, created_at, updated_at, ...cfg } = publicBot(bot);
    const nama = String(bot.bot_name || 'bot').replace(/[^\w.-]+/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="config-${bot.id}-${nama}.json"`);
    return res.json({ v: 1, bot: cfg });
  } catch (err) {
    console.error('[Bot] exportConfig error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

// ─── POST /api/bots/:id/resolve-invite ───────────────────────────────────────
// Link undangan grup → JID. Cuma jalan kalau botnya lagi terhubung: yang
// nanya ke WhatsApp itu sesi bot, bukan panel.
async function resolveInvite(req, res) {
  try {
    const bot = await assertOwnership(req, res, req.params.id);
    if (!bot) return;

    const { input } = req.body;
    if (!input || typeof input !== 'string')
      return sendError(res, 400, 'Input tidak boleh kosong');

    const trimmed = input.trim();

    // Sudah JID — validasi format saja
    if (trimmed.endsWith('@g.us')) {
      const valid = /^\d+@g\.us$/.test(trimmed);
      if (!valid) return sendError(res, 400, 'Format JID tidak valid');
      return res.json({ ok: true, jid: trimmed, name: null });
    }

    // Extract invite code dari link WA
    const linkMatch = trimmed.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
    if (!linkMatch)
      return sendError(res, 400, 'Bukan link grup WhatsApp atau JID yang valid');

    const code = linkMatch[1];

    // Butuh bot aktif untuk resolve
    const client = activeBots.get(String(bot.id));
    if (!client)
      return sendError(res, 400, 'Bot harus aktif/terhubung untuk resolve link grup');

    try {
      const info = await client.group.queryGroupInviteInfo(code);
      const jid  = info.id || info.jid;
      const name = info.subject || info.name || null;
      if (!jid) return sendError(res, 400, 'Gagal mendapatkan JID dari link ini');
      return res.json({ ok: true, jid, name });
    } catch (e) {
      return sendError(res, 400, `Gagal resolve link: ${e.message}`);
    }
  } catch (err) {
    console.error('[Bot] resolveInvite error:', err);
    return sendError(res, 500, 'Terjadi kesalahan server');
  }
}

module.exports = {
  listBots, getBot, createBot, updateBot, deleteBot,
  startBot, stopBot, restartBot, clearSession, getBotLogs, getBotStats, exportConfig,
  resolveInvite,
  // State runtime — dibaca engine (whatsappEngine/telegramEngine) & plugin.
  activeBots, activeGroupsPerBot, activeChannelsPerBot,
};

