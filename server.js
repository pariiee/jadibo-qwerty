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
const command = require('./controllers/commandController');
const billing = require('./controllers/billingController');
const pricingStore = require('./config/pricingStore');
const beban        = require('./config/beban');
const { setWsBroadcast: setWsBroadcastWa, startWhatsAppBot } = require('./engine/whatsappEngine');
const { setWsBroadcast: setWsBroadcastTg, startTelegramBot } = require('./engine/telegramEngine');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT = parseInt(process.env.PORT || '3000', 10);

// Panel ini & panel Baileys berbagi tabel `bots` di DB yang sama.
const { ENGINE_BOT_ID, mine, isMine } = require('./config/engineScope');
const { ADMIN_ROLE } = require('./config/roles');

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
app.get('/api/bots/:id/stats',         apiLimiter, auth.requireAuth, bot.getBotStats);
app.get('/api/bots/:id/config',        apiLimiter, auth.requireAuth, bot.exportConfig);
app.post('/api/bots/:id/resolve-invite', apiLimiter, auth.requireAuth, bot.resolveInvite);

// ─── Kesehatan sistem ─────────────────────────────────────────────────────────
// Publik dan TANPA limiter: uptime monitor dari luar harus bisa memanggilnya
// kapan saja, dan yang dibalas cuma angka kasar — bukan data siapa pun.
app.get('/health', async (_, res) => {
  const h = await require('./engine/health').cek();
  res.status(h.ok ? 200 : 503).json(h);
});

// ─── Langganan & Pembayaran ──────────────────────────────────────────────────
app.get('/api/plans',                apiLimiter, billing.daftarPaket);
// Sisa kuota pesan per bot — dipakai halaman /kuota.
app.get('/api/kuota',                apiLimiter, auth.requireAuth, billing.kuota);
// Banner pengumuman dari admin — dipakai dashboard.
app.get('/api/pengumuman',           apiLimiter, auth.requireAuth, billing.pengumuman);
// Daftar command bot (halaman /command). Login dulu — daftar fitur itu bagian
// dari produk, bukan info publik.
app.get('/api/command',              apiLimiter, auth.requireAuth, command.daftarCommand);
// Ganti password sendiri. authLimiter (bukan apiLimiter): endpoint ini nerima
// password lama, jadi harus dibatasi kayak login — jangan dikasih kuota 120/menit.
app.post('/api/auth/password',         authLimiter, auth.requireAuth, auth.gantiPassword);
// Nomor HP — jalur notif kedua. authLimiter karena endpoint ini nulis ke akun.
app.post('/api/auth/phone',            authLimiter, auth.requireAuth, auth.simpanPhone);
app.post('/api/billing/checkout',    apiLimiter, auth.requireAuth, billing.checkout);
app.post('/api/billing/trial',       apiLimiter, auth.requireAuth, billing.klaimTrialSendiri);
app.get('/api/billing/orders',       apiLimiter, auth.requireAuth, billing.daftarOrder);
// "Cek status" manual — bukan polling. Dijatah 20 detik per transaksi di
// config/qrisku.js supaya akun QRISku tidak kena ban.
app.post('/api/billing/orders/:orderId/check', apiLimiter, auth.requireAuth, billing.cekOrder);

// ─── Admin Routes (king only) ─────────────────────────────────────────────────
app.get('/api/admin/users',          auth.requireAuth, auth.requireKing, auth.listUsers);
app.patch('/api/admin/users/:id',    auth.requireAuth, auth.requireKing, auth.updateUser);
app.delete('/api/admin/users/:id',   auth.requireAuth, auth.requireKing, auth.deleteUser);

app.get('/api/admin/billing/orders',                  auth.requireAuth, auth.requireKing, billing.adminOrders);
app.post('/api/admin/billing/orders/:orderId/confirm', auth.requireAuth, auth.requireKing, billing.adminKonfirmasi);
app.post('/api/admin/billing/orders/:orderId/reject',  auth.requireAuth, auth.requireKing, billing.adminTolak);
app.get('/api/admin/billing/settings',                auth.requireAuth, auth.requireKing, billing.adminSettings);
app.put('/api/admin/billing/plans',                   auth.requireAuth, auth.requireKing, billing.adminSetPlans);
app.put('/api/admin/billing/settings',                auth.requireAuth, auth.requireKing, billing.adminSetSettings);
// Top-up & reset kuota pesan per bot. Owner-only, sama seperti endpoint admin
// lain. Dipakai saat kompensasi bot error atau pembelian kuota tambahan.
app.post('/api/admin/bots/:id/kuota',        auth.requireAuth, auth.requireKing, billing.adminTopupKuota);
app.post('/api/admin/bots/:id/reset-kuota',  auth.requireAuth, auth.requireKing, billing.adminResetKuota);

// ─── Halaman HTML ─────────────────────────────────────────────────────────────
// Halaman berisi <!-- @include head.html --> dll; partial di public/partials/
// dirangkai di sini, jadi halaman baru cukup <link> + include, tanpa duplikat.
const PUBLIC_HTML = path.join(__dirname, 'public');
const INCLUDE_RE  = /<!--\s*@include\s+([\w.\/-]+)\s*-->/g;
// Versi aset = mtime file. Dipakai di halaman() supaya URL aset berubah tiap
// file diubah; tanpa ini browser + Cloudflare menyajikan CSS/JS lama sampai 4 jam.
const mtimeAset = (p) => {
  try { return Math.round(fs.statSync(path.join(PUBLIC_HTML, p)).mtimeMs); }
  catch { return 0; }
};

const halaman = (nama, kode = 200) => (_, res) => {
  try {
    const html = fs.readFileSync(path.join(PUBLIC_HTML, nama), 'utf8')
      .replace(INCLUDE_RE, (_, f) =>
        fs.readFileSync(path.join(PUBLIC_HTML, 'partials', f), 'utf8'))
      .replace(/(\/(?:assets|js)\/[\w.-]+\.(?:css|js))"/g,
        (m, p) => `${p}?v=${mtimeAset(p)}"`);
    res.status(kode).type('html').send(html);
  } catch (e) {
    console.error('[Page]', nama, e.message);
    res.status(500).type('html').send('<h1>500</h1>');
  }
};
app.get('/dashboard', halaman('dashboard.html'));
app.get('/bot/:id',   halaman('bot-detail.html'));
// Setup bot dipisah dari /bot/:id — di sana sekarang statistik. Halaman ini
// yang megang form konfigurasi + import/export, dan punya pemilih bot sendiri
// (dropdown) biar user multi-slot nggak perlu bolak-balik ke dashboard.
app.get('/config/:id', halaman('config.html'));
app.get('/command',    halaman('command.html'));
// Riwayat pembayaran & profil: dua-duanya halaman USER (bukan admin).
app.get('/billing',    halaman('billing.html'));
app.get('/kuota',      halaman('kuota.html'));
app.get('/log',        halaman('log.html'));
app.get('/panduan',    halaman('panduan.html'));
app.get('/profil',     halaman('profil.html'));
app.get('/pricing',    halaman('pricing.html'));
// Tautan lama: bot sempat ngasih pesan "buka halaman Langganan", dan orang
// mungkin sudah bookmark /langganan. Tanpa ini, /langganan jatuh ke catch-all
// dan diam-diam nampilin landing page — bingung, bukan 404 yang jelas.
app.get('/langganan', (_, res) => res.redirect(301, '/pricing'));
// Panel admin sengaja TIDAK di /admin.
//
// Bot WhatsApp itu auto-scanner: begitu ada nomor baru masuk, bot jahat langsung
// mencoba `/.env`, `/admin`, `/config`, `/.git`. Nama yang bisa ditebak = satu
// permintaan gagal, tapi satu permintaan yang BERHASIL sudah cukup fatal. Jadi
// path-nya dipindah, dan `/admin` DIHAPUS (bukan di-redirect) — redirect justru
// memberi tahu penebak bahwa halamannya cuma pindah.
//
// Yang benar-benar melindungi tetap sesi login + role `kawula` di dalamnya
// (`auth.requireKing` di tiap endpoint /api/admin/*). Nama aneh itu lapisan
// kedua, bukan pengganti.
app.get('/kountole',  halaman('admin.html'));
// /login & /register = SATU file, pane dipilih dari pathname (js/auth-page.js).
app.get('/login',     halaman('login.html'));
app.get('/register',  halaman('login.html'));
// `/` WAJIB eksplisit: tanpa ini dia dilayani catch-all, dan begitu catch-all
// berubah jadi 404, landing page ikut jadi 404.
app.get('/',          halaman('index.html'));
// Sisa rute = 404 beneran. Dulu catch-all-nya menyajikan landing page dengan
// status 200, jadi URL salah ketik kelihatan "berhasil" — user cuma bingung.
app.get('*',          halaman('404.html', 404));

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

        // Sesi yang sudah diputus ganti password TIDAK boleh tetap nyambung ke
        // WebSocket — kalau nggak dicek di sini, lubangnya cuma pindah dari
        // HTTP ke WS.
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

// Jalur lintas panel: user Start bot zapo dari panel labs, dan log/QR-nya
// dibalikin ke sana. Dipasang di sini (setelah broadcastFn siap, sebelum
// server.listen) supaya event yang keluar pas auto-start di bawah tetap
// kejangkau. Nggak ada yang dibuka ke jaringan: cuma nambah 1 rute yang
// nolak dari luar loopback.
const bridge = require('./engine/bridge');
const broadcastGabungan = bridge.pasangRelay(broadcastFn);
setWsBroadcastWa(broadcastGabungan);
setWsBroadcastTg(broadcastGabungan);
app.post('/internal/op', bridge.route);

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
    const [sc, sp] = mine('id', 'AND');
    const [rows] = await pool.execute(
      `SELECT * FROM bots WHERE is_running = 1${sc}`, sp
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
  await seedDefaults(process.env.KING_USERNAME || 'admin', hashed);

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
    const [sc, sp] = mine('id', 'AND');
    const [bots] = await pool.execute(`SELECT id, daily_limit FROM bots WHERE is_running = 1${sc}`, sp);
    const gate = require('./engine/gatePaket');
    for (const bot of bots) {
      // Kuota harian dibaca dari paket yang SEDANG berlaku, bukan
      // `bots.daily_limit` yang dibekukan waktu checkout — kalau tidak, trial
      // 5 hari yang sudah lewat tetap dapat limit 20 pesan selamanya, dan masa
      // aktif yang dijual jadi tidak ada artinya. `kuotaBot()` sudah menangani
      // ketiganya: admin tanpa batas, paket habis = 0, dan kolom bot cuma boleh
      // menurunkan jatah paket.
      //
      // SENGAJA BUKAN `receive_limit`: itu kuota pesan SEUMUR PAKET (direset
      // hanya saat beli lagi), sedangkan `lim` di sini reset tiap hari.
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

// ─── Cron Pangkas Log — harian 03:00 WIB ──────────────────────────────────────
// `bot_logs` tumbuh ~1 MB/hari (1.187 baris/1,1 MB dalam 1 hari) dan TIDAK
// pernah dibersihkan. Yang ditampilkan cuma 100 baris terakhir (getBotLogs,
// maks 500) — jadi sisanya cuma berat. Simpan 500 terakhir per bot.
cron.schedule('0 3 * * *', async () => {
  try {
    const [bots] = await pool.execute('SELECT id FROM bots');
    let total = 0;
    for (const b of bots) {
      // Subquery dibungkus tabel turunan: MySQL nolak DELETE yang menunjuk
      // tabelnya sendiri (error 1093) kalau tidak dibungkus.
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

// ─── Cron Jadwal Buka/Tutup Grup Otomatis — setiap menit ─────────────────────
cron.schedule('* * * * *', async () => {
  // ── Bot yang paketnya habis: matikan ──────────────────────────────────────
  // Sebelum ini paket lewat cuma nge-drop fitur ke jatah Gratis sementara
  // botnya tetap nyambung ke WhatsApp — bayar atau tidak, nomornya tetap
  // online. Ini yang bikin langganan nggak ada artinya.
  //
  // Pakai cron yang SUDAH ada (tiap menit) — jangan bikin jadwal baru.
  try {
    for (const bot of await require('./engine/gatePaket').botKedaluwarsa()) {
      try {
        // `stop_reason='expired'` DULU, baru matikan. Urutan ini penting: kalau
        // ditulis sesudah, matinya bisa gagal di tengah dan bot berhenti tanpa
        // penanda — lalu nggak akan pernah dinyalakan lagi sesudah dibayar.
        await pool.execute("UPDATE bots SET stop_reason = 'expired' WHERE id = ?", [bot.id]);
        await require('./config/engineBus').stopIfRunning(bot.id);
        console.log(`[Cron] Bot ${bot.id} (${bot.username}) dimatikan — paket habis ${bot.plan_expired_at}`);
        // Kabari pemiliknya, SEKALI per bot (bukan tiap menit): syaratnya
        // `stop_reason` masih kosong saat giliran ini masuk.
        //
        // SENGAJA TIDAK di-await dan dijalankan SETELAH stop — balasannya lewat
        // bot user sendiri, dan balasan itu nggak bisa jalan selagi botnya masih
        // terhubung. Untuk paket habis, botnya justru mau dimatikan.
        if (bot.stop_reason !== 'expired') {
          require('./engine/notify').kirimKeOwner(bot.user_id,
            `⏰ *Paket bot kamu sudah habis.*\n\n` +
            `Bot *${bot.bot_name || bot.id}* dimatikan otomatis karena masa aktifnya ` +
            `berakhir. Data & pengaturannya tetap aman — begitu paket diperpanjang, ` +
            `bot dinyalakan otomatis tanpa perlu setting ulang.\n\n` +
            `Perpanjang: /pricing`).catch(() => {});
        }
      } catch (e) {
        console.error(`[Cron] Gagal matikan bot ${bot.id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[Cron] Cek paket habis error:', e.message);
  }

  // ── Alarm kesehatan ───────────────────────────────────────────────────────
  // Pakai cron yang SUDAH ada (tiap menit) — jangan bikin jadwal baru.
  // Modulnya sendiri yang mengatur toleransi & anti-spam; di sini cuma panggil.
  try {
    require('./engine/health').periksaDanAlarm().catch(() => {});
  } catch (e) {
    console.error('[Cron] Health check error:', e.message);
  }

  try {
    // Ambil semua group_settings yang punya open_time atau close_time
    const [rows] = await pool.execute(
      `SELECT gs.bot_id, gs.group_jid, gs.open_time, gs.close_time
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

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
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
