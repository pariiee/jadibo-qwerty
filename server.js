'use strict';

require('dotenv').config();

process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled Rejection:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err?.message || err);
  if (err?.code === 'EADDRINUSE') process.exit(1);
});

if (!process.env.JWT_SECRET) {
  console.error('[Boot] JWT_SECRET kosong di .env — server dihentikan.');
  process.exit(1);
}
if (!process.env.INTERNAL_KEY) {
  console.error('[Boot] INTERNAL_KEY kosong di .env — server dihentikan.');
  process.exit(1);
}
if (!process.env.KING_PASSWORD) {
  console.error('[Boot] KING_PASSWORD kosong di .env — server dihentikan.');
  process.exit(1);
}
if (!process.env.KING_USERNAME) {
  console.error('[Boot] KING_USERNAME kosong di .env — server dihentikan.');
  process.exit(1);
}

require('./config/net'); // paksa IPv4 (lihat komentarnya) — worker juga pakai

const TANPA_EFEK = process.env.NO_BOOT_SIDE_EFFECTS === '1';
if (TANPA_EFEK) {
  console.warn('[Boot] NO_BOOT_SIDE_EFFECTS=1 — autoStartBots & SELURUH cron dimatikan (mode uji).');
}

const fs           = require('fs');
const express      = require('express');
const compression  = require('compression');
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
const command = require('./controllers/commandController');
const sistem = require('./controllers/sistemController');
const billing = require('./controllers/billingController');
const wallet  = require('./controllers/walletController');
const cekOrigin = require('./config/cekOrigin');
const pricingStore = require('./config/pricingStore');
const beban        = require('./config/beban');
const { setWsBroadcast: setWsBroadcastWa, startWhatsAppBot } = require('./engine/whatsappEngine');
const { setWsBroadcast: setWsBroadcastTg, startTelegramBot } = require('./engine/telegramEngine');
const { setWsBroadcast: setWsBroadcastDc, startDiscordBot } = require('./engine/discordEngine');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT = parseInt(process.env.PORT || '3000', 10);

const { ENGINE_BOT_ID, mine, isMine } = require('./config/engineScope');
const { ADMIN_ROLE } = require('./config/roles');
const { resolveBotId, pastikanSlug } = require('./config/botSlug');

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

app.set('trust proxy', 'loopback');

app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? process.env.ALLOWED_ORIGIN || false
    : true,
  credentials: true,
}));

app.use(cookieParser());

app.post(
  ['/api/payment/webhook', '/webhook'],
  express.raw({ type: '*/*', limit: '256kb' }),
  billing.webhook
);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(cekOrigin.cekOrigin);

const PUBLIC_HTML = path.join(__dirname, 'public');
const INCLUDE_RE  = /<!--\s*@include\s+([\w.\/-]+)\s*-->/g;

const ERROR_MAP = {
  400: { t: 'Bad Request', d: 'Server tidak dapat memproses permintaan karena format salah atau data tidak lengkap.' },
  401: { t: 'Unauthorized', d: 'Kamu belum login atau sesi telah berakhir. Silakan login kembali.', p: '/login', pl: 'Login Sekarang' },
  403: { t: 'Akses Ditolak', d: 'Kamu tidak memiliki izin untuk mengakses halaman atau fitur ini.', p: '/login', pl: 'Masuk Akun Lain' },
  404: { t: 'Halaman Tidak Ditemukan', d: 'Alamat URL yang kamu tuju salah ketik, sudah dihapus, atau tidak tersedia.' },
  405: { t: 'Method Not Allowed', d: 'Metode pengiriman data yang digunakan dilarang untuk halaman ini.' },
  408: { t: 'Request Timeout', d: 'Server memutus koneksi karena proses memakan waktu terlalu lama.', p: 'javascript:location.reload()', pl: 'Coba Lagi' },
  409: { t: 'Conflict', d: 'Permintaan bertabrakan dengan kondisi akun atau sistem saat ini.' },
  410: { t: 'Gone', d: 'Halaman atau data ini sudah dihapus permanen dan tidak akan kembali.' },
  413: { t: 'Payload Too Large', d: 'Ukuran file atau data yang diunggah melebihi batas maksimal server.' },
  415: { t: 'Unsupported Media Type', d: 'Format atau tipe berkas yang dikirim tidak didukung oleh sistem.' },
  422: { t: 'Unprocessable Entity', d: 'Format data benar namun isi data tidak memenuhi syarat sistem.' },
  429: { t: 'Too Many Requests', d: 'Terlalu banyak permintaan dalam waktu singkat. Tunggu beberapa saat lagi.', p: 'javascript:location.reload()', pl: 'Refresh Halaman' },
  451: { t: 'Unavailable For Legal Reasons', d: 'Akses ke konten ini dibatasi karena regulasi hukum atau sensor.' },
  500: { t: 'Terjadi Gangguan Server', d: 'Server kami sedang mengalami kendala internal sementara.', p: 'javascript:location.reload()', pl: 'Muat Ulang' },
  501: { t: 'Not Implemented', d: 'Fitur atau metode ini belum didukung atau belum dibuat di server.' },
  502: { t: 'Bad Gateway', d: 'Gateway menerima respons tidak valid dari layanan server di belakangnya.', p: 'javascript:location.reload()', pl: 'Muat Ulang' },
  503: { t: 'Sedang Dalam Pemeliharaan', d: 'Sistem sedang dalam proses pemeliharaan atau kapasitas penuh.', p: 'javascript:location.reload()', pl: 'Cek Status' },
  504: { t: 'Gateway Timeout', d: 'Gateway kehabisan waktu menunggu respons dari server utama.', p: 'javascript:location.reload()', pl: 'Muat Ulang' },
  505: { t: 'HTTP Version Not Supported', d: 'Versi protokol HTTP browser Anda tidak didukung oleh server.' },
};

const halamanError = (kode = 500, customMsg = null) => (_, res) => {
  const c = Number(kode) || 500;
  const info = ERROR_MAP[c] || { t: 'Terjadi Kesalahan', d: 'Terjadi kendala saat memproses permintaan Anda.' };
  try {
    const raw = fs.readFileSync(path.join(PUBLIC_HTML, 'error.html'), 'utf8')
      .replace(INCLUDE_RE, (_, f) => fs.readFileSync(path.join(PUBLIC_HTML, 'partials', f), 'utf8'))
      .replace(/\{\{CODE\}\}/g, String(c))
      .replace(/\{\{TITLE\}\}/g, info.t)
      .replace(/\{\{MESSAGE\}\}/g, customMsg || info.d)
      .replace(/\{\{PRIMARY_HREF\}\}/g, info.p || '/dashboard')
      .replace(/\{\{PRIMARY_LABEL\}\}/g, info.pl || 'Ke Dashboard');
    res.status(c).type('html').send(raw);
  } catch {
    res.status(c).type('html').send(`<h1>Error ${c}</h1><p>${info.t}</p>`);
  }
};

const jsCache = new Map();
app.use('/js', async (req, res, next) => {
  const dest = req.headers['sec-fetch-dest'];
  const mode = req.headers['sec-fetch-mode'];
  const referer = req.headers['referer'] || '';
  const host = req.headers['host'] || '';

  const isInternalScript = (dest === 'script' || (referer && referer.includes(host))) && dest !== 'document' && mode !== 'navigate';
  if (!isInternalScript) {
    return halamanError(403, 'Akses langsung ke berkas script dilarang.')(req, res);
  }

  if (req.path.endsWith('.js') && !req.path.includes('..')) {
    const filePath = path.join(PUBLIC_HTML, 'js', req.path);
    if (fs.existsSync(filePath)) {
      try {
        const stat = fs.statSync(filePath);
        const cacheKey = `${req.path}:${stat.mtimeMs}`;
        if (jsCache.has(cacheKey)) {
          res.set('Content-Type', 'application/javascript; charset=utf-8');
          res.set('Cache-Control', 'public, max-age=86400, must-revalidate');
          return res.send(jsCache.get(cacheKey));
        }

        const src = fs.readFileSync(filePath, 'utf8');
        let minified = src;
        try {
          const { minify } = require('terser');
          const out = await minify(src, {
            compress: true,
            mangle: true,
            format: { comments: false }
          });
          if (out.code) minified = out.code;
        } catch {}

        jsCache.set(cacheKey, minified);
        res.set('Content-Type', 'application/javascript; charset=utf-8');
        res.set('Cache-Control', 'public, max-age=86400, must-revalidate');
        return res.send(minified);
      } catch {
        return next();
      }
    }
  }
  next();
});

app.use(compression());
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  maxAge: '1d',
  etag: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('sw.js')) {
      res.setHeader('Service-Worker-Allowed', '/');
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

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

const moneyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { ok: false, message: 'Terlalu banyak permintaan. Tunggu sebentar.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const topupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { ok: false, message: 'Terlalu banyak membuat tagihan. Tunggu sebentar.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { ok: false, message: 'Batas pendaftaran akun tercapai (maksimal 5 akun per jam). Silakan coba lagi nanti.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const resendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { ok: false, message: 'Batas kirim ulang email tercapai (maksimal 3 kali per jam). Silakan periksa folder spam atau coba lagi nanti.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/api/auth/register', registerLimiter, auth.register);
app.post('/api/auth/login',    authLimiter, auth.login);
app.post('/api/auth/logout',   auth.logout);
app.get('/verify-email',       auth.verifyEmail);
app.get('/api/auth/verify-info', auth.getVerifyInfo);
app.get('/api/auth/pending-info', auth.getPendingInfo);
app.post('/api/auth/verify-confirm', resendLimiter, auth.verifyConfirm);
app.post('/api/auth/resend-verification', resendLimiter, auth.resendVerification);
app.post('/api/auth/forgot-password', authLimiter, auth.forgotPassword);
app.post('/api/auth/reset-password',  authLimiter, auth.resetPassword);
app.get('/api/auth/me',        auth.requireAuth, auth.me);
app.get('/api/auth/google',          auth.googleRedirect);
app.get('/api/auth/google/callback', auth.googleCallback);

app.get('/api/stats', async (req, res) => {
  try {
    const stats = await getStats();
    res.json({ ok: true, stats });
  } catch {
    res.status(500).json({ ok: false, message: 'Gagal mengambil stats' });
  }
});

app.get('/api/bots',                    apiLimiter, auth.requireAuth, bot.listBots);
app.post('/api/bots',                   apiLimiter, auth.requireAuth, bot.createBot);
const resolveIdBot = async (req, res, next) => {
  const idAngka = await resolveBotId(req.params.id);
  if (idAngka === null) return res.status(404).json({ ok: false, message: 'Bot tidak ditemukan' });
  req.params.id = String(idAngka);
  next();
};
app.param('id', (req, res, next, nilai) => {
  const jalurBot = /^\/api\/(admin\/)?bots\//.test(req.path);
  if (!jalurBot) return next();
  resolveIdBot(req, res, next);
});
app.get('/api/bots/:id',                apiLimiter, auth.requireAuth, bot.getBot);
app.patch('/api/bots/:id',              apiLimiter, auth.requireAuth, bot.updateBot);
app.delete('/api/bots/:id',             apiLimiter, auth.requireAuth, bot.deleteBot);
app.post('/api/bots/:id/start',         apiLimiter, auth.requireAuth, bot.startBot);
app.post('/api/bots/:id/stop',          apiLimiter, auth.requireAuth, bot.stopBot);
app.post('/api/bots/:id/restart',       apiLimiter, auth.requireAuth, bot.restartBot);
app.post('/api/bots/:id/clear-session', apiLimiter, auth.requireAuth, bot.clearSession);
app.get('/api/bots/:id/logs',           apiLimiter, auth.requireAuth, bot.getBotLogs);
app.delete('/api/bots/:id/logs',        apiLimiter, auth.requireAuth, bot.clearBotLogs);
app.get('/api/bots/:id/stats',         apiLimiter, auth.requireAuth, bot.getBotStats);
app.get('/api/bots/:id/config',        apiLimiter, auth.requireAuth, bot.exportConfig);
app.post('/api/bots/:id/resolve-invite', apiLimiter, auth.requireAuth, bot.resolveInvite);
app.post('/api/bots/:id/tambah-respon',  apiLimiter, auth.requireAuth, bot.beliRespon);

app.get('/api/health', sistem.publicHealth);
app.get('/health', (req, res, next) => {
  if (req.accepts('html') && !req.xhr && !req.query.json) {
    return halaman('health.html')(req, res);
  }
  return sistem.publicHealth(req, res);
});

app.get('/api/plans',                apiLimiter, billing.daftarPaket);
app.get('/api/kuota',                apiLimiter, auth.requireAuth, billing.kuota);
app.get('/api/pengumuman',           apiLimiter, auth.requireAuth, billing.pengumuman);
app.get('/api/command',              apiLimiter, auth.requireAuth, command.daftarCommand);
app.post('/api/auth/password',         authLimiter, auth.requireAuth, auth.gantiPassword);
app.post('/api/auth/phone',            authLimiter, auth.requireAuth, auth.simpanPhone);
app.post('/api/auth/email',            authLimiter, auth.requireAuth, auth.simpanEmail);
app.post('/api/billing/checkout',    apiLimiter, auth.requireAuth, billing.checkout);
app.post('/api/billing/addon',       moneyLimiter, auth.requireAuth, billing.beliAddon);
app.post('/api/billing/trial',       apiLimiter, auth.requireAuth, billing.klaimTrialSendiri);
app.get('/api/billing/orders',       apiLimiter, auth.requireAuth, billing.daftarOrder);
app.get('/api/billing/orders/:orderId', apiLimiter, auth.requireAuth, billing.detailOrder);
app.post('/api/billing/orders/:orderId/check', apiLimiter, auth.requireAuth, billing.cekOrder);

app.get('/api/wallet',               apiLimiter,   auth.requireAuth, wallet.ringkasan);
app.get('/api/wallet/ledger',        apiLimiter,   auth.requireAuth, wallet.riwayat);
app.post('/api/wallet/topup',        topupLimiter, auth.requireAuth, wallet.buatOrderTopup);
app.post('/api/wallet/perpanjang',   moneyLimiter, auth.requireAuth, wallet.perpanjang);
app.post('/api/wallet/auto-renew',   moneyLimiter, auth.requireAuth, wallet.setAutoRenew);

app.use('/api/admin', auth.requireAuth, (req, res, next) => {
  res.on('finish', () => {
    sistem.catatAudit({
      userId: req.user?.id,
      username: req.user?.username,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ip: req.headers['cf-connecting-ip'] || req.ip,
    });
  });
  next();
});

app.get('/api/admin/users',          auth.requireAuth, auth.requireKing, auth.listUsers);
app.patch('/api/admin/users/:id',    auth.requireAuth, auth.requireSuperAdmin, auth.updateUser);
app.delete('/api/admin/users/:id',   auth.requireAuth, auth.requireSuperAdmin, auth.deleteUser);

app.get('/api/admin/billing/orders',                  auth.requireAuth, auth.requireSuperAdmin, billing.adminOrders);
app.post('/api/admin/billing/orders/:orderId/confirm', auth.requireAuth, auth.requireSuperAdmin, billing.adminKonfirmasi);
app.post('/api/admin/billing/orders/:orderId/reject',  auth.requireAuth, auth.requireSuperAdmin, billing.adminTolak);
app.get('/api/admin/billing/settings',                auth.requireAuth, auth.requireSuperAdmin, billing.adminSettings);
app.put('/api/admin/billing/plans',                   auth.requireAuth, auth.requireSuperAdmin, billing.adminSetPlans);
app.put('/api/admin/billing/settings',                auth.requireAuth, auth.requireSuperAdmin, billing.adminSetSettings);
app.post('/api/admin/bots/:id/kuota',        auth.requireAuth, auth.requireSuperAdmin, billing.adminTopupKuota);
app.post('/api/admin/bots/:id/reset-kuota',  auth.requireAuth, auth.requireSuperAdmin, billing.adminResetKuota);

app.get('/api/admin/wallet/users',                    auth.requireAuth, auth.requireSuperAdmin, wallet.adminUsers);
app.get('/api/admin/wallet/users/:userId/ledger',     auth.requireAuth, auth.requireSuperAdmin, wallet.adminLedger);
app.post('/api/admin/wallet/users/:userId/adjust',    moneyLimiter, auth.requireAuth, auth.requireSuperAdmin, wallet.adminAdjust);
app.get('/api/admin/wallet/konsistensi',              auth.requireAuth, auth.requireSuperAdmin, wallet.adminKonsistensi);
app.get('/api/admin/wallet/pendapatan',               auth.requireAuth, auth.requireSuperAdmin, wallet.adminPendapatan);

app.get('/api/admin/sistem',      auth.requireAuth, auth.requireKing, sistem.status);
app.get('/api/admin/audit',       auth.requireAuth, auth.requireKing, sistem.audit);
app.get('/api/admin/system-logs', auth.requireAuth, auth.requireKing, sistem.getSystemLogs);
app.get('/api/admin/pendapatan',  auth.requireAuth, auth.requireSuperAdmin, sistem.pendapatan);
app.post('/api/admin/broadcast',  auth.requireAuth, auth.requireSuperAdmin, sistem.broadcast);

const mtimeAset = (p) => {
  try { return Math.round(fs.statSync(path.join(PUBLIC_HTML, p)).mtimeMs); }
  catch { return 0; }
};

const halaman = (nama, kode = 200) => (_, res) => {
  try {
    const html = fs.readFileSync(path.join(PUBLIC_HTML, nama), 'utf8')
      .replace(INCLUDE_RE, (_, f) =>
        fs.readFileSync(path.join(PUBLIC_HTML, 'partials', f), 'utf8'));
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.status(kode).type('html').send(html);
  } catch (e) {
    console.error('[Page]', nama, e.message);
    res.status(500).type('html').send('<h1>500</h1>');
  }
};
app.get('/dashboard', halaman('dashboard.html'));
app.get('/bot/:id',   halaman('bot-detail.html'));
app.get('/config/:id', halaman('config.html'));
app.get('/command',    halaman('command.html'));
app.get('/billing',    halaman('billing.html'));
app.get('/kuota',      halaman('kuota.html'));
app.get('/saldo',      halaman('saldo.html'));
app.get('/invoice/:orderId', halaman('invoice.html'));
app.get('/log',        halaman('log.html'));
app.get('/panduan',    halaman('panduan.html'));
app.get('/profil',     halaman('profil.html'));
app.get('/pricing',    halaman('pricing.html'));
app.get('/langganan', (_, res) => res.redirect(301, '/pricing'));
app.get([
  '/kountole',
  '/kountole/users',
  '/kountole/bots',
  '/kountole/orders',
  '/kountole/saldo',
  '/kountole/harga',
  '/kountole/sistem',
  '/kountole/logs'
], halaman('admin.html'));
app.get('/login',           halaman('login.html'));
app.get('/register',        halaman('login.html'));
app.get('/register/pending', halaman('register-pending.html'));
app.get('/register/verify',  halaman('register-verify.html'));
app.get('/register/success', halaman('register-success.html'));
app.get('/forgot-password', halaman('login.html'));
app.get('/reset-password',  halaman('login.html'));
app.get('/privacy',         halaman('privacy.html'));
app.get('/terms',           halaman('terms.html'));
app.get('/',             halaman('index.html'));
app.get('*',             halamanError(404));

app.use((err, req, res, _next) => {
  console.error('[Server] Error:', err.message);
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  const pesan = 'Terjadi kesalahan pada server. Coba lagi sebentar lagi.';
  if (req.path.startsWith('/api/') || req.xhr || (req.headers.accept || '').includes('json')) {
    return res.status(status).json({ ok: false, message: pesan });
  }
  return halamanError(status)(req, res);
});

const botSubscribers = new Map();
const userSubscribers = new Map();

wss.on('connection', (ws, req) => {
  let subscribedBotId = null;
  let subscribedUserId = null;

  ws.on('message', async (raw) => {
    try {
      const data = JSON.parse(raw);

      const ambilToken = () => {
        let token = data.token;
        if (!token) {
          const m = (req.headers.cookie || '').match(/(?:^|;\s*)token=([^;]+)/);
          if (m) token = decodeURIComponent(m[1]);
        }
        return token;
      };

      if (data.type === 'subscribe_user') {
        const jwt = require('jsonwebtoken');
        const token = ambilToken();
        let decoded = null;
        try {
          decoded = jwt.verify(token, process.env.JWT_SECRET || 'changeme');
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
          return;
        }
        subscribedUserId = decoded.id;
        if (!userSubscribers.has(subscribedUserId)) {
          userSubscribers.set(subscribedUserId, new Set());
        }
        userSubscribers.get(subscribedUserId).add(ws);
        ws.send(JSON.stringify({ type: 'subscribed_user', userId: subscribedUserId }));
        return;
      }

      if (data.type === 'subscribe' && data.botId) {
        const jwt = require('jsonwebtoken');
        const token = ambilToken();

        let decoded = null;
        try {
          decoded = jwt.verify(token, process.env.JWT_SECRET || 'changeme');
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
          ws.close();
          return;
        }

        try {
          const { pool } = require('./config/database');
          const [tvRows] = await pool.execute('SELECT token_version FROM users WHERE id = ?', [decoded.id]);
          if (!tvRows.length || Number(tvRows[0].token_version || 0) !== Number(decoded.tv || 0)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Sesi sudah tidak berlaku' }));
            ws.close();
            return;
          }
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
          ws.close();
          return;
        }

        let botIdNum = parseInt(data.botId, 10);
        if (!Number.isInteger(botIdNum) || botIdNum <= 0) {
          try {
            const { pool } = require('./config/database');
            const [bRows] = await pool.execute('SELECT id FROM bots WHERE public_id = ? LIMIT 1', [String(data.botId)]);
            if (bRows.length) botIdNum = bRows[0].id;
          } catch {}
        }
        if (!Number.isInteger(botIdNum) || botIdNum <= 0) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid bot id' }));
          ws.close();
          return;
        }

        try {
          const { pool } = require('./config/database');
          const [rows] = await pool.execute(
            'SELECT user_id FROM bots WHERE id = ?',
            [botIdNum]
          );
          const owns = rows.length > 0 && (decoded.role === ADMIN_ROLE || rows[0].user_id === decoded.id)
            && isMine(botIdNum);
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
          redisBus.subscribeBot(subscribedBotId);
        }
        botSubscribers.get(subscribedBotId).add(ws);
        ws.send(JSON.stringify({ type: 'subscribed', botId: subscribedBotId }));
      } else if (data.type === 'clear_terminal' && data.botId) {
        broadcastFn({ botId: parseInt(data.botId, 10), type: 'clear_terminal', ts: Date.now() });
      }
    } catch { /* ignore malformed messages */ }
  });

  ws.on('close', () => {
    if (subscribedBotId && botSubscribers.has(subscribedBotId)) {
      const set = botSubscribers.get(subscribedBotId);
      set.delete(ws);
      if (set.size === 0) {
        botSubscribers.delete(subscribedBotId);
        redisBus.unsubscribeBot(subscribedBotId);
      }
    }
    if (subscribedUserId && userSubscribers.has(subscribedUserId)) {
      const set = userSubscribers.get(subscribedUserId);
      set.delete(ws);
      if (set.size === 0) userSubscribers.delete(subscribedUserId);
    }
  });

  ws.on('error', () => {});

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

wss.on('close', () => clearInterval(heartbeat));

const redisBus = require('./config/redisBus');
const INSTANCE_ID = Math.random().toString(36).slice(2);

const broadcastLokal = (data) => {
  const payload = JSON.stringify(data);
  const subs = botSubscribers.get(data.botId);
  if (subs && subs.size > 0) {
    subs.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    });
  }
  userSubscribers.forEach((sockets) => {
    sockets.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    });
  });
};

const broadcastFn = (data) => {
  broadcastLokal(data);
  redisBus.publishEvent({ ...data, _sender: INSTANCE_ID });
};

redisBus.onEvent((data) => {
  if (data._sender === INSTANCE_ID) return;
  broadcastLokal(data);
});

setWsBroadcastWa(broadcastFn);
setWsBroadcastTg(broadcastFn);
setWsBroadcastDc(broadcastFn);

const bridge = require('./engine/bridge');
const broadcastGabungan = bridge.pasangRelay(broadcastFn);
setWsBroadcastWa(broadcastGabungan);
setWsBroadcastTg(broadcastGabungan);
app.post('/internal/op', bridge.route);

const cronAman = TANPA_EFEK ? { schedule: () => ({ stop() {}, destroy() {} }) } : cron;

cronAman.schedule('*/10 * * * * *', async () => {
  try {
    const stats = await getStats();
    const payload = JSON.stringify({ type: 'stats', payload: stats });
    wss.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    });
  } catch { /* non-critical */ }
});

async function autoStartBots() {
  try {
    const [sc, sp] = mine('id', 'AND');
    const [rows] = await pool.execute(
      `SELECT * FROM bots WHERE is_running = 1
         AND (stop_reason IS NULL OR stop_reason <> 'expired')${sc}`, sp
    );
    if (rows.length === 0) return;
    console.log(`[Boot] Auto-starting ${rows.length} bot(s)...`);
    for (const botData of rows) {
      try {
        if (botData.platform === 'telegram') {
          await startTelegramBot(botData);
        } else if (botData.platform === 'discord') {
          await startDiscordBot(botData);
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

  const hashed = await bcrypt.hash(process.env.KING_PASSWORD, 12);
  await seedDefaults(process.env.KING_USERNAME, hashed);

  server.listen(PORT, async () => {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║         YaaParBot Server Started         ║');
    console.log(`║  URL  : http://localhost:${PORT}            ║`);
    console.log(`║  Mode : ${(process.env.NODE_ENV || 'development').padEnd(32)}║`);
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
    const csrf = cekOrigin.csrfDiperiksa();
    console.log(`[Boot] CSRF origin: ${csrf.env} = ${csrf.jumlah ? csrf.izin.join(', ') : '(kosong — hanya origin sendiri)'}`);
    if (TANPA_EFEK) {
      console.log('[Boot] NO_BOOT_SIDE_EFFECTS=1 — bot & cron TIDAK dijalankan.');
    } else {
      await autoStartBots();
    }
  });
}

cronAman.schedule('0 17 * * *', async () => {
  try {
    const [sc, sp] = mine('id', 'AND');
    const [bots] = await pool.execute(`SELECT id, daily_limit FROM bots WHERE is_running = 1${sc}`, sp);
    const gate = require('./engine/gatePaket');
    for (const bot of bots) {
      const lim = await gate.kuotaHarian(bot);

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

cronAman.schedule('0 3 * * *', async () => {
  try {
    const [bots] = await pool.execute('SELECT id FROM bots');
    let total = 0;
    for (const b of bots) {
      const [res] = await pool.execute(
        `DELETE FROM bot_logs WHERE bot_id = ?
           AND id NOT IN (SELECT id FROM (
                 SELECT id FROM bot_logs WHERE bot_id = ? ORDER BY id DESC LIMIT 500
               ) t)`,
        [b.id, b.id]
      );
      total += res.affectedRows;
    }
    if (total) console.log(`[Cron] Pangkas bot_logs: ${total} baris dibuang (sisakan 500/bot)`);
  } catch (e) {
    console.error('[Cron] Pangkas log error:', e.message);
  }
}, { timezone: 'Asia/Jakarta' });

cronAman.schedule('* * * * *', async () => {
  try {
    for (const bot of await require('./engine/gatePaket').botKedaluwarsa()) {
      try {
        await require('./engine/notify').kirimKeOwner(bot.user_id,
          `⏰ *Masa aktif paket bot kamu sudah habis.*\n\n` +
          `Bot *${bot.bot_name || bot.id}* dimatikan otomatis karena masa aktifnya ` +
          `berakhir (+ tenggang 1 jam). Data & pengaturannya tetap aman — begitu paket diperpanjang, ` +
          `bot dapat dinyalakan kembali tanpa perlu setting ulang.\n\n` +
          `Perpanjang di: https://labs.yapari.web.id/pricing`).catch(() => {});
        await pool.execute("UPDATE bots SET stop_reason = 'expired' WHERE id = ?", [bot.id]);
        await require('./config/engineBus').stopIfRunning(bot.id);
        console.log(`[Cron] Bot ${bot.id} (${bot.username}) dimatikan — paket habis + 1 jam: ${bot.plan_expired_at}`);
      } catch (e) {
        console.error(`[Cron] Gagal matikan bot ${bot.id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[Cron] Cek paket habis error:', e.message);
  }

  // Notifikasi H-1 sebelum expired (Trial / Berbayar)
  try {
    const { ADMIN_ROLE, SUBADMIN_ROLE } = require('./config/roles');
    const [h1Users] = await pool.execute(
      `SELECT u.id, u.username, u.plan, u.plan_expired_at
         FROM users u
        WHERE u.plan_expired_at IS NOT NULL
          AND u.plan_expired_at BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 24 HOUR)
          AND u.notif_h1_sent_at IS NULL
          AND u.role NOT IN (?, ?)`,
      [ADMIN_ROLE, SUBADMIN_ROLE]
    );
    for (const u of h1Users) {
      await pool.execute('UPDATE users SET notif_h1_sent_at = NOW() WHERE id = ?', [u.id]);
      const sisaJam = Math.max(1, Math.round((new Date(u.plan_expired_at) - Date.now()) / (3600 * 1000)));
      require('./engine/notify').kirimKeOwner(u.id,
        `⚠️ *Pemberitahuan Masa Aktif Bot*\n\n` +
        `Halo *${u.username}*, masa aktif paket (*${u.plan || 'Trial'}*) bot kamu tersisa *${sisaJam} jam lagi* ` +
        `(berakhir pada ${new Date(u.plan_expired_at).toLocaleString('id-ID')}).\n\n` +
        `Segera perpanjang paket di dashboard agar bot kamu tidak terhenti:\nhttps://labs.yapari.web.id/pricing`
      ).catch(() => {});
    }
  } catch (e) {
    console.error('[Cron] Notif H-1 error:', e.message);
  }

  try {
    require('./engine/health').periksaDanAlarm().catch(() => {});
  } catch (e) {
    console.error('[Cron] Health check error:', e.message);
  }

  try {
    const [rows] = await pool.execute(
      `SELECT gs.bot_id, gs.group_jid, gs.open_time, gs.close_time
       FROM group_settings gs
       WHERE gs.open_time IS NOT NULL OR gs.close_time IS NOT NULL`
    ).catch(() => [[]]);

    if (!rows.length) return;

    const now   = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    const HH    = String(now.getHours()).padStart(2, '0');
    const MM    = String(now.getMinutes()).padStart(2, '0');
    const jamNow = `${HH}.${MM}`;

    const { activeBots } = require('./controllers/botController');

    for (const row of rows) {
      const client = activeBots.get(row.bot_id) || activeBots.get(String(row.bot_id));
      if (!client) continue;

      if (row.open_time === jamNow) {
        try {
          await client.group.setSetting(row.group_jid, 'announcement', false);
          console.log(`[Cron] Grup ${row.group_jid} dibuka jam ${jamNow}`);
        } catch {}
      }
      if (row.close_time === jamNow) {
        try {
          await client.group.setSetting(row.group_jid, 'announcement', true);
          console.log(`[Cron] Grup ${row.group_jid} ditutup jam ${jamNow}`);
        } catch {}
      }
    }
  } catch (e) {
    console.error('[Cron] Jadwal grup error:', e.message);
  }
}, { timezone: 'Asia/Jakarta' });

cronAman.schedule('0 * * * *', async () => {
  try {
    await wallet.autoRenew();
  } catch (e) {
    console.error('[Cron] Auto-perpanjang error:', e.message);
  }
}, { timezone: 'Asia/Jakarta' });

cronAman.schedule('30 * * * *', async () => {
  try {
    const [res] = await pool.execute(
      'DELETE FROM email_verifications WHERE expires_at < NOW() OR used_at IS NOT NULL'
    );
    if (res.affectedRows > 0) {
      console.log(`[Cron] email_verifications: ${res.affectedRows} token kedaluwarsa/terpakai dibersihkan.`);
      sistem.catatLogSistem({
        category: 'cron',
        level: 'info',
        actor: 'cron',
        action: 'CLEANUP_TOKENS',
        message: `Pembersihan rutin: ${res.affectedRows} token verifikasi kedaluwarsa dibersihkan.`
      });
    }
  } catch (e) {
    console.error('[Cron] Cleanup email_verifications error:', e.message);
  }
}, { timezone: 'Asia/Jakarta' });

cronAman.schedule('0 4 * * *', async () => {
  try {
    const [staleUsers] = await pool.execute(
      `SELECT id FROM users 
       WHERE is_active = 0 
         AND role != ? 
         AND created_at < DATE_SUB(NOW(), INTERVAL 3 DAY)`,
      [ADMIN_ROLE]
    );

    if (staleUsers.length > 0) {
      const ids = staleUsers.map((u) => u.id);
      const ph = ids.map(() => '?').join(',');
      await pool.execute(`DELETE FROM email_verifications WHERE user_id IN (${ph})`, ids).catch(() => {});
      const [delRes] = await pool.execute(`DELETE FROM users WHERE id IN (${ph})`, ids);
      console.log(`[Cron] Auto-purge: ${delRes.affectedRows} akun nonaktif > 3 hari dibersihkan.`);
      sistem.catatLogSistem({
        category: 'cron',
        level: 'warn',
        actor: 'cron',
        action: 'PURGE_USERS',
        message: `Auto-purge akun bodong: ${delRes.affectedRows} akun nonaktif > 3 hari dibersihkan.`
      });
    }
  } catch (e) {
    console.error('[Cron] Auto-purge akun gagal:', e.message);
  }
}, { timezone: 'Asia/Jakarta' });

async function shutdown() {
  console.log('[Shutdown] Resetting bot statuses...');
  try {
    const [sc, sp] = mine('id', 'AND');
    await pool.execute(
      `UPDATE bots SET status = 'disconnected' WHERE status IN ('connected', 'connecting')${sc}`, sp
    );
  } catch { /* non-critical */ }
  process.exit(0);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

boot().catch((err) => {
  console.error('[Boot] Fatal error:', err);
  process.exit(1);
});

module.exports = { app, server, wss };
