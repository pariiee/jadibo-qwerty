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
// Kunci jalur internal web ↔ worker. Kalau kosong dan jatuh ke JWT_SECRET,
// bocornya satu kunci = bocor sesi user sekalian. Dipisah, dan wajib.
if (!process.env.INTERNAL_KEY) {
  console.error('[Boot] INTERNAL_KEY kosong di .env — server dihentikan.');
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
const billing = require('./controllers/billingController');
const pricingStore = require('./config/pricingStore');
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

// Webhook QRISku HARUS dapat badan mentah: tanda tangan dihitung dari byte asli.
// Jadi rute ini dipasang SEBELUM express.json — kalau tidak, JSON sudah diparse
// dan byte aslinya hilang, verifikasi tidak akan pernah cocok.
app.post(
  '/api/payment/webhook',
  express.raw({ type: '*/*', limit: '256kb' }),
  billing.webhook
);

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

// ─── Langganan & Pembayaran ──────────────────────────────────────────────────
app.get('/api/plans',                apiLimiter, billing.daftarPaket);
app.post('/api/billing/checkout',    apiLimiter, auth.requireAuth, billing.checkout);
app.post('/api/billing/trial',       apiLimiter, auth.requireAuth, billing.klaimTrialSendiri);
app.get('/api/billing/orders',       apiLimiter, auth.requireAuth, billing.daftarOrder);
// "Cek status" manual — bukan polling. Dijatah 20 detik per transaksi di
// config/qrisku.js supaya akun QRISku tidak kena ban.
app.post('/api/billing/orders/:orderId/check', apiLimiter, auth.requireAuth, billing.cekOrder);

// ─── Admin Routes (admin tertinggi saja) ─────────────────────────────────────
app.get('/api/admin/users',          auth.requireAuth, auth.requireKing, auth.listUsers);
app.patch('/api/admin/users/:id',    auth.requireAuth, auth.requireKing, auth.updateUser);
app.delete('/api/admin/users/:id',   auth.requireAuth, auth.requireKing, auth.deleteUser);

app.get('/api/admin/billing/orders',                  auth.requireAuth, auth.requireKing, billing.adminOrders);
app.post('/api/admin/billing/orders/:orderId/confirm', auth.requireAuth, auth.requireKing, billing.adminKonfirmasi);
app.post('/api/admin/billing/orders/:orderId/reject',  auth.requireAuth, auth.requireKing, billing.adminTolak);
app.get('/api/admin/billing/settings',                auth.requireAuth, auth.requireKing, billing.adminSettings);
app.put('/api/admin/billing/plans',                   auth.requireAuth, auth.requireKing, billing.adminSetPlans);
app.put('/api/admin/billing/settings',                auth.requireAuth, auth.requireKing, billing.adminSetSettings);

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
app.get('/langganan', halaman('langganan.html'));
app.get('/admin',     halaman('admin.html'));
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
          const owns = rows.length > 0 && (decoded.role === ADMIN_ROLE || rows[0].user_id === decoded.id);
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
// Cuma stats DB → WebSocket. Nggak ada polling ke worker: dulu ada cron 10 detik
// yang manggil engineBus.sinkron() buat ngerawat cermin "bot jalan", tapi cermin
// itu nggak punya satu pun pemakai produksi — jadi yang jalan cuma salinan yang
// nggak ada yang baca, dan ikut angkat beban cron sampai ada eksekusi kelewat
// waktu proses lagi sibuk.
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

  // Harga paket & setelan QRIS manual dibaca sekali di sini, lalu di-cache.
  // Tabel `settings` dibuat oleh scripts/sync-schema.js saat deploy.
  await pricingStore.refresh();

  // Hash admin password and seed
  const hashed = await bcrypt.hash(process.env.KING_PASSWORD || 'king123', 12);
  await seedDefaults(process.env.KING_USERNAME || 'kawula', hashed);

  server.listen(PORT, async () => {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║         YaaParBot Server Started         ║');
    console.log(`║  URL  : http://localhost:${PORT}            ║`);
    console.log(`║  Mode : ${(process.env.NODE_ENV || 'development').padEnd(32)}║`);
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
    // Bot nggak dinyalain di sini — worker yang punya koneksinya, dan event-nya
    // (log/status/qr) ngalir sendiri lewat /internal/engine-event. Nggak ada yang
    // perlu disinkronin pas boot.
  });
}

// ─── Auto Reset Limit Harian — setiap hari jam 00:00 WIB (UTC+7) ─────────────
cron.schedule('0 17 * * *', async () => {
  try {
    // Kuota harian = kuota paket PEMILIK bot. Ikut berubah sendiri kalau paket
    // naik/turun atau masa aktif habis (kuota 0 = command berhenti).
    const { kuotaBot, receiveLimit } = require('./config/plan');
    const [bots] = await pool.execute(`
      SELECT b.id, b.daily_limit, u.role, u.plan, u.plan_expired_at
      FROM bots b LEFT JOIN users u ON u.id = b.user_id
      WHERE b.is_running = 1`);
    for (const bot of bots) {
      const lim = kuotaBot(bot, bot, pricingStore.plans());
      // Ikut juga `receive_limit`: paket bisa ganti kapan saja, dan kolom itu
      // menentukan batas TOTAL pesan (engine baca tiap pesan). Tanpa ini, paket
      // baru cuma berlaku setelah bot di-restart.
      await pool.execute(
        'UPDATE bots SET receive_limit = ? WHERE id = ?',
        [receiveLimit(bot, pricingStore.plans()), bot.id]
      );
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

// ─── Purge Log Bot — harian 03:00 WIB ────────────────────────────────────────
// bot_logs nulis SATU baris tiap pesan masuk (engine/whatsappEngine.js), jadi
// bot yang rame bisa puluhan ribu baris/hari dan nggak ada yang pernah ngehapus.
// Index (bot_id, created_at) bikin bacanya cepat, BUKAN disk-nya berhenti gemuk.
cron.schedule('0 20 * * *', async () => {
  try {
    const [res] = await pool.execute(
      'DELETE FROM bot_logs WHERE created_at < NOW() - INTERVAL 14 DAY');
    if (res.affectedRows) console.log(`[Cron] Purge log: ${res.affectedRows} baris > 14 hari`);
  } catch (e) {
    console.error('[Cron] Purge log error:', e.message);
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
