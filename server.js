'use strict';

/**
 * server.js — YaaParBot Main Entry Point
 * Express + WebSocket server with JWT auth, REST API, and live bot log streaming
 */

require('dotenv').config();
const express      = require('express');
const http         = require('http');
const WebSocket    = require('ws');
const path         = require('path');
const cookieParser = require('cookie-parser');
const helmet       = require('helmet');
const cors         = require('cors');
const rateLimit    = require('express-rate-limit');
const bcrypt       = require('bcryptjs');
const cron         = require('node-cron');

const { testConnection, seedDefaults, getStats, pool } = require('./config/database');
const auth = require('./controllers/authController');
const bot  = require('./controllers/botController');
const { setWsBroadcast: setWsBroadcastWa, startWhatsAppBot } = require('./engine/whatsappEngine');
const { setWsBroadcast: setWsBroadcastTg, startTelegramBot } = require('./engine/telegramEngine');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT = parseInt(process.env.PORT || '3000', 10);

// ─── Security & Middleware ────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'", 'cdn.tailwindcss.com', 'cdn.jsdelivr.net'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:      ["'self'", "'unsafe-inline'", 'cdn.tailwindcss.com', 'fonts.googleapis.com'],
      fontSrc:       ["'self'", 'fonts.gstatic.com'],
      imgSrc:        ["'self'", 'data:', 'https:'],
      connectSrc:    ["'self'", 'ws:', 'wss:'],
    },
  },
}));

// Di balik Cloudflare Tunnel semua koneksi datang dari 127.0.0.1 — tanpa ini
// req.ip jadi 127.0.0.1 untuk SEMUA user dan rate-limit berubah jadi satu ember
// global (20x login habis dipakai satu orang, sisanya kena blok). 'loopback'
// hanya mempercayai proxy dari localhost (cloudflared), jadi X-Forwarded-For
// dari luar tetap tidak bisa dipalsukan.
app.set('trust proxy', 'loopback');

app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? process.env.ALLOWED_ORIGIN || false
    : true,
  credentials: true,
}));

app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// ─── Rate Limiter ─────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { ok: false, message: 'Terlalu banyak percobaan. Coba lagi nanti.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { ok: false, message: 'Rate limit terlampaui.' },
});

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.post('/api/auth/register', authLimiter, auth.register);
app.post('/api/auth/login',    authLimiter, auth.login);
app.post('/api/auth/logout',   auth.logout);
app.get('/api/auth/me',        auth.requireAuth, auth.me);

// ─── Stats (public) ───────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await getStats();
    res.json({ ok: true, stats });
  } catch {
    res.status(500).json({ ok: false, message: 'Gagal mengambil stats' });
  }
});

// ─── Bot Routes ───────────────────────────────────────────────────────────────
app.get('/api/bots',                    apiLimiter, auth.requireAuth, bot.listBots);
app.post('/api/bots',                   apiLimiter, auth.requireAuth, bot.createBot);
app.get('/api/bots/:id',                apiLimiter, auth.requireAuth, bot.getBot);
app.patch('/api/bots/:id',              apiLimiter, auth.requireAuth, bot.updateBot);
app.delete('/api/bots/:id',             apiLimiter, auth.requireAuth, bot.deleteBot);
app.post('/api/bots/:id/start',         apiLimiter, auth.requireAuth, bot.startBot);
app.post('/api/bots/:id/stop',          apiLimiter, auth.requireAuth, bot.stopBot);
app.post('/api/bots/:id/restart',       apiLimiter, auth.requireAuth, bot.restartBot);
app.post('/api/bots/:id/clear-session', apiLimiter, auth.requireAuth, bot.clearSession);
app.get('/api/bots/:id/logs',           apiLimiter, auth.requireAuth, bot.getBotLogs);
app.post('/api/bots/:id/resolve-invite', apiLimiter, auth.requireAuth, bot.resolveInvite);

// ─── Admin Routes (king only) ─────────────────────────────────────────────────
app.get('/api/admin/users',          auth.requireAuth, auth.requireKing, auth.listUsers);
app.patch('/api/admin/users/:id',    auth.requireAuth, auth.requireKing, auth.updateUser);
app.delete('/api/admin/users/:id',   auth.requireAuth, auth.requireKing, auth.deleteUser);

// ─── SPA Fallback ─────────────────────────────────────────────────────────────
app.get('/dashboard', (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/bot/:id', (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'bot-detail.html')));
app.get('*', (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── WebSocket Hub ────────────────────────────────────────────────────────────
// Map: botId -> Set<WebSocket>
const botSubscribers = new Map();

wss.on('connection', (ws, req) => {
  let subscribedBotId = null;

  ws.on('message', async (raw) => {
    try {
      const data = JSON.parse(raw);

      // Client sends { type: 'subscribe', botId: 3, token: '...' }
      if (data.type === 'subscribe' && data.botId) {
        // Verify JWT: prioritas dari cookie httpOnly, fallback payload token (legacy)
        const jwt = require('jsonwebtoken');
        let token = data.token;
        if (!token) {
          const m = (req.headers.cookie || '').match(/(?:^|;\s*)token=([^;]+)/);
          if (m) token = decodeURIComponent(m[1]);
        }

        let decoded = null;
        try {
          decoded = jwt.verify(token, process.env.JWT_SECRET || 'changeme');
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
          ws.close();
          return;
        }

        const botIdNum = parseInt(data.botId, 10);
        if (!Number.isInteger(botIdNum) || botIdNum <= 0) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid bot id' }));
          ws.close();
          return;
        }

        // Ownership check — user hanya boleh subscribe bot miliknya (king bebas)
        try {
          const { pool } = require('./config/database');
          const [rows] = await pool.execute(
            'SELECT user_id FROM bots WHERE id = ?',
            [botIdNum]
          );
          const owns = rows.length > 0 && (decoded.role === 'king' || rows[0].user_id === decoded.id);
          if (!owns) {
            ws.send(JSON.stringify({ type: 'error', message: 'Forbidden' }));
            ws.close();
            return;
          }
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
          ws.close();
          return;
        }

        subscribedBotId = botIdNum;
        if (!botSubscribers.has(subscribedBotId)) {
          botSubscribers.set(subscribedBotId, new Set());
        }
        botSubscribers.get(subscribedBotId).add(ws);
        ws.send(JSON.stringify({ type: 'subscribed', botId: subscribedBotId }));
      }
    } catch { /* ignore malformed messages */ }
  });

  ws.on('close', () => {
    if (subscribedBotId && botSubscribers.has(subscribedBotId)) {
      botSubscribers.get(subscribedBotId).delete(ws);
    }
  });

  ws.on('error', () => {});

  // Heartbeat ping
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

// Heartbeat interval
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

wss.on('close', () => clearInterval(heartbeat));

// ── Inject broadcast function into both engines ──────────────────────────────
const broadcastFn = (data) => {
  const subs = botSubscribers.get(data.botId);
  if (!subs || subs.size === 0) return;
  const payload = JSON.stringify(data);
  subs.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  });
};
setWsBroadcastWa(broadcastFn);
setWsBroadcastTg(broadcastFn);

// ─── Periodic Stats Broadcast ─────────────────────────────────────────────────
cron.schedule('*/10 * * * * *', async () => {
  try {
    const stats = await getStats();
    const payload = JSON.stringify({ type: 'stats', payload: stats });
    wss.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    });
  } catch { /* non-critical */ }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function autoStartBots() {
  try {
    const [rows] = await pool.execute(
      "SELECT * FROM bots WHERE is_running = 1"
    );
    if (rows.length === 0) return;
    console.log(`[Boot] Auto-starting ${rows.length} bot(s)...`);
    for (const botData of rows) {
      try {
        if (botData.platform === 'telegram') {
          await startTelegramBot(botData);
        } else {
          await startWhatsAppBot(botData, false);
        }
        console.log(`[Boot] Bot "${botData.bot_name}" (${botData.platform}) started`);
      } catch (e) {
        console.error(`[Boot] Failed to start bot "${botData.bot_name}": ${e.message}`);
      }
    }
  } catch (e) {
    console.error('[Boot] Auto-start error:', e.message);
  }
}

async function boot() {
  await testConnection();

  // Hash king password and seed
  const hashed = await bcrypt.hash(process.env.KING_PASSWORD || 'king123', 12);
  await seedDefaults(process.env.KING_USERNAME || 'king', hashed);

  server.listen(PORT, async () => {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║         YaaParBot Server Started         ║');
    console.log(`║  URL  : http://localhost:${PORT}            ║`);
    console.log(`║  Mode : ${(process.env.NODE_ENV || 'development').padEnd(32)}║`);
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
    await autoStartBots();
  });
}

// ─── Auto Reset Limit Harian — setiap hari jam 00:00 WIB (UTC+7) ─────────────
cron.schedule('0 17 * * *', async () => {
  try {
    // Reset per-bot sesuai daily_limit masing-masing
    const [bots] = await pool.execute('SELECT id, daily_limit FROM bots WHERE is_running = 1');
    for (const bot of bots) {
      const lim = bot.daily_limit || parseInt(process.env.DEFAULT_LIMIT || '20', 10);
      const [res] = await pool.execute(
        'UPDATE rpg_members SET lim = ? WHERE bot_id = ? AND registered = 1',
        [lim, bot.id]
      );
      console.log(`[Cron] Bot ${bot.id} reset limit: ${res.affectedRows} user → ${lim}`);
    }
  } catch (e) {
    console.error('[Cron] Reset limit error:', e.message);
  }
}, { timezone: 'Asia/Jakarta' });

// ─── Cron Jadwal Buka/Tutup Grup Otomatis — setiap menit ─────────────────────
cron.schedule('* * * * *', async () => {
  try {
    // Ambil semua group_settings yang punya open_time atau close_time
    const [rows] = await pool.execute(
      `SELECT gs.bot_id, gs.group_jid, gs.open_time, gs.close_time, gs.open_msg, gs.close_msg
       FROM group_settings gs
       WHERE gs.open_time IS NOT NULL OR gs.close_time IS NOT NULL`
    ).catch(() => [[]]);

    if (!rows.length) return;

    // Waktu WIB sekarang
    const now   = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    const HH    = String(now.getHours()).padStart(2, '0');
    const MM    = String(now.getMinutes()).padStart(2, '0');
    const jamNow = `${HH}.${MM}`;

    const { activeBots } = require('./controllers/botController');
    const { renderTemplate } = require('./engine/template');
    const messCfg = require('./config/mess');

    for (const row of rows) {
      const client = activeBots.get(row.bot_id) || activeBots.get(String(row.bot_id));
      if (!client) continue;
      const jadwal = [];
      if (row.open_time === jamNow) jadwal.push({ buka: true, teks: row.open_msg });
      if (row.close_time === jamNow) jadwal.push({ buka: false, teks: row.close_msg });

      for (const j of jadwal) {
        try {
          await client.group.setSetting(row.group_jid, 'announcement', !j.buka);
        } catch { /* bot bukan admin / grup ilang — lanjut kirim teks aja */ }

        // Pesan pengumuman: teks custom grup, kalau kosong pakai default .env
        const template = j.teks || (j.buka ? messCfg.openDefault : messCfg.closeDefault);
        if (!template) continue;

        let meta = null;
        try { meta = await client.group.queryGroupMetadata(row.group_jid); } catch {}
        const { text, mentions } = renderTemplate(template, {
          groupName: meta?.subject || row.group_jid.split('@')[0],
          groupDesc: meta?.desc || '',
        });
        try {
          await client.message.send(row.group_jid, text, { mentions });
          console.log(`[Cron] Grup ${row.group_jid} ${j.buka ? 'dibuka' : 'ditutup'} jam ${jamNow}`);
        } catch (e) {
          console.error('[Cron] Kirim teks jadwal gagal:', e.message);
        }
      }
    }
  } catch (e) {
    console.error('[Cron] Jadwal grup error:', e.message);
  }
}, { timezone: 'Asia/Jakarta' });

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
async function shutdown() {
  console.log('[Shutdown] Resetting bot statuses...');
  try {
    await pool.execute(
      "UPDATE bots SET status = 'disconnected' WHERE status IN ('connected', 'connecting')"
    );
  } catch { /* non-critical */ }
  process.exit(0);
}

// ─── Safety net proses ────────────────────────────────────────────────────────
// Node >= 15 mematikan proses begitu ada promise rejection tanpa catch: bot restart
// dan command yg lagi diproses hilang tanpa balasan. Log aja, jangan mati.
process.on('unhandledRejection', (err) => {
  console.error('[UnhandledRejection]', err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err?.message || err);
});

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

boot().catch((err) => {
  console.error('[Boot] Fatal error:', err);
  process.exit(1);
});

module.exports = { app, server, wss };
