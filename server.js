'use strict';

/**
 * server.js — YaaParBot Main Entry Point
 * Express + WebSocket server with JWT auth, REST API, and live bot log streaming
 */

require('dotenv').config();

// Guard boot: JWT_SECRET kosong = token siapa pun bisa ditandatangani sendiri.
// Lebih baik gagal start daripada jalan dengan pintu kebuka.
if (!process.env.JWT_SECRET) {
  console.error('[Boot] JWT_SECRET kosong di .env — server dihentikan.');
  process.exit(1);
}

require('./config/net'); // paksa IPv4 (lihat komentarnya) — worker juga pakai

const fs           = require('fs');
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
const engineBus = require('./config/engineBus');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT = parseInt(process.env.PORT || '3000', 10);

// ─── Security & Middleware ────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      // ponytail: nggak ada 'unsafe-inline' di sini. Semua onclick udah pindah ke
      // data-act (public/js/act.js) dan <script> inline udah jadi file di public/js/.
      scriptSrc:     ["'self'", 'cdn.tailwindcss.com', 'cdn.jsdelivr.net'],
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

// CSRF: cookie sesi sudah httpOnly + SameSite=Lax, jadi POST lintas situs
// nggak ikut bawa cookie. Sabuk keduanya: tolak request yang Origin-nya bukan
// host kita. Tanpa token = nggak ada state yang bisa basi/kadaluarsa.
// Origin kosong = bukan browser (curl, worker internal) → lolos, seperti biasa.
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const asal = req.get('origin') || req.get('referer');
  if (!asal) return next();
  let host;
  try { host = new URL(asal).host; } catch { host = null; }
  if (host && host === req.get('host')) return next();
  console.warn('[CSRF] ditolak:', req.method, req.originalUrl, '←', asal);
  return res.status(403).json({ ok: false, message: 'Permintaan ditolak' });
});

app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? process.env.ALLOWED_ORIGIN || false
    : true,
  credentials: true,
}));

app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Static files — index:false supaya '/' tidak disajikan mentah oleh static
// (halaman harus lewat renderer include di bawah, biar partial ikut dirangkai)
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

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

// ─── Admin Routes (king only) ─────────────────────────────────────────────────
app.get('/api/admin/users',          auth.requireAuth, auth.requireKing, auth.listUsers);
app.patch('/api/admin/users/:id',    auth.requireAuth, auth.requireKing, auth.updateUser);
app.delete('/api/admin/users/:id',   auth.requireAuth, auth.requireKing, auth.deleteUser);

// ─── Halaman HTML ─────────────────────────────────────────────────────────────
// Halaman berisi <!-- @include head.html --> dll; partial di public/partials/
// dirangkai di sini, jadi halaman baru cukup <link> + include, tanpa duplikat.
const PUBLIC_HTML = path.join(__dirname, 'public');
const INCLUDE_RE  = /<!--\s*@include\s+([\w.\/-]+)\s*-->/g;
const halaman = (nama) => (_, res) => {
  try {
    const html = fs.readFileSync(path.join(PUBLIC_HTML, nama), 'utf8')
      .replace(INCLUDE_RE, (_, f) =>
        fs.readFileSync(path.join(PUBLIC_HTML, 'partials', f), 'utf8'));
    res.type('html').send(html);
  } catch (e) {
    console.error('[Page]', nama, e.message);
    res.status(500).type('html').send('<h1>500</h1>');
  }
};
app.get('/dashboard', halaman('dashboard.html'));
app.get('/bot/:id',   halaman('bot-detail.html'));
app.get('*',          halaman('index.html'));

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
          decoded = jwt.verify(token, process.env.JWT_SECRET);
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

// ── Event bot (log/QR/status) datang dari worker lewat HTTP ─────────────────
const broadcastFn = (data) => {
  const subs = botSubscribers.get(data.botId);
  if (!subs || subs.size === 0) return;
  const payload = JSON.stringify(data);
  subs.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  });
};
engineBus.pasangEventSink(broadcastFn);

// Cuma 127.0.0.1 (worker) yang boleh nembak ini. Nggak pakai Origin-check CSRF
// karena bukan browser — kuncinya header, sama kayak worker→web.
app.post('/internal/engine-event', (req, res) => {
  if (req.get('x-internal-key') !== engineBus.kunci()) return res.status(403).json({ ok: false });
  engineBus.terimaEvent(req.body);
  res.json({ ok: true });
});

// ─── Periodic Stats Broadcast ─────────────────────────────────────────────────
// Nggak ada polling ke worker di sini. Cermin "bot jalan" (engineBus._jalan)
// di-push worker tiap berubah lewat kirimEvent({type:'running'}) — polling tiap
// 10 detik cuma ngasih salinan yang sama dan bikin cron ini bisa kelewat kalau
// proses lagi sibuk. Satu kali sinkron saat boot tetap ada (lihat boot()).
cron.schedule('*/10 * * * * *', async () => {
  try {
    const stats = await getStats();
    const payload = JSON.stringify({ type: 'stats', payload: stats });
    wss.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    });
  } catch { /* non-critical */ }
});

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
    // Bot nggak dinyalain di sini — worker yang punya koneksinya. Yang perlu cuma
    // nyocokin cermin "bot jalan" biar tombolnya nggak salah tebak. Dicoba beberapa
    // kali lalu BERHENTI: kalau worker belum naik sama sekali, terus muter = nembak
    // port kosong seumur hidup. Kalau worker-nya nyala belakangan, dia sendiri yang
    // nyambung balik (retry flush di botWorker.js) — jadi nggak perlu nunggu di sini.
    let gagal = 0;
    const cocokin = setInterval(async () => {
      if ((await engineBus.sinkron()) !== null || ++gagal >= 5) clearInterval(cocokin);
    }, 2000);
    cocokin.unref();
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

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
// Status bot TIDAK direset di sini: web restart nggak nginjak bot. Worker
// yang nulis status disconnected pas dia sendiri yang mati.
async function shutdown() {
  console.log('[Shutdown] Web berhenti (bot tetap jalan di worker).');
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
