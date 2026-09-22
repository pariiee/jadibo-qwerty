'use strict';

/**
 * workers/botWorker.js — proses yang megang koneksi bot (WA + Telegram).
 *
 * Dipisah dari server.js supaya `pm2 restart` web (tiap deploy) nggak mutus
 * semua bot. Worker nggak nyalain Express; dia cuma nerima perintah dari web
 * lewat 127.0.0.1 dan ngirim balik event (log/QR/status) ke web.
 *
 * Jalanin: pm2 start workers/botWorker.js --name jadibot-worker
 */
require('dotenv').config();
require('../config/net'); // family:4 sebelum apa pun yang bisa keluar jaringan

const http = require('http');
const cron = require('node-cron');
const { pool, testConnection } = require('../config/database');

const { activeBots } = require('../engine/runtime');
const wa = require('../engine/whatsappEngine');
const tg = require('../engine/telegramEngine');
const { renderTemplate } = require('../engine/template');
const mess = require('../config/mess');

const PORT      = parseInt(process.env.WORKER_PORT || '3001', 10);
const WEB_PORT  = parseInt(process.env.PORT || '3000', 10);
const KUNCI     = process.env.INTERNAL_KEY || process.env.JWT_SECRET;

// ─── Event → web ─────────────────────────────────────────────────────────────
// Satu jalur: body mentah dikirim ke web, web yang nge-fan-out ke WebSocket.
// Kalau web lagi restart, event ditahan di buffer (max 500) lalu dikirim pas
// web balik — log bot nggak bolong tiap deploy.
const _buffer = [];
let _siap = false;

async function post(path, body) {
  const res = await fetch(`http://127.0.0.1:${WEB_PORT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-key': KUNCI },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
}

async function kirimEvent(ev) {
  if (!_siap) { if (_buffer.length < 500) _buffer.push(ev); return; }
  try { await post('/internal/engine-event', ev); }
  catch { _siap = false; if (_buffer.length < 500) _buffer.push(ev); }
}

async function flush() {
  try {
    await post('/internal/engine-event', { type: 'running', ids: [...activeBots.keys()] });
    _siap = true;
    while (_buffer.length) await post('/internal/engine-event', _buffer.shift());
  } catch { _siap = false; }
}

// Web bisa belum siap waktu worker boot — deploy restart dua-duanya sekaligus,
// dan `pm2 restart jadibot` doang nggak ngasih tau worker apa-apa. Timer ini
// yang nyambungin balik: selama belum tersambung, coba flush tiap 3 detik.
// Sekali nyambung dia diam total (nggak ada request saat sehat).
setInterval(() => { if (!_siap) flush(); }, 3000).unref();

// ─── Perintah dari web ───────────────────────────────────────────────────────
// Nunggu koneksi benar-benar hidup. 60 detik = batas sabar buat scan QR;
// lewat itu bot tetap jalan, cuma web dikasih tau apa adanya.
function nungguSiap(botId, ms = 60000) {
  if (wa.getBotConnectedAt(botId)) return Promise.resolve();
  return new Promise((selesai, gagal) => {
    let cek, timer;
    const bersih = (pesan) => {
      clearInterval(cek); clearTimeout(timer);
      pesan ? gagal(Object.assign(new Error(pesan), { status: 504 })) : selesai();
    };
    cek = setInterval(() => {
      if (wa.getBotConnectedAt(botId)) bersih();
      else if (!activeBots.has(botId)) bersih('Bot berhenti sebelum terhubung');
    }, 500);
    timer = setTimeout(() => bersih('Belum terhubung — scan QR / masukkan kode pairing di halaman bot'), ms);
  });
}

async function botDariDb(botId) {
  const [rows] = await pool.execute('SELECT * FROM bots WHERE id = ?', [botId]);
  if (!rows.length) { const e = new Error('Bot tidak ditemukan'); e.status = 404; throw e; }
  return rows[0];
}

async function jalankan({ op, botId, args }) {
  switch (op) {
    case 'status':
      return { ids: [...activeBots.keys()] };

    case 'start': {
      if (activeBots.has(botId)) { const e = new Error('Bot sudah berjalan'); e.status = 400; throw e; }
      const botData = await botDariDb(botId);
      if (botData.platform === 'telegram') {
        await tg.startTelegramBot(botData);
        return { message: 'Bot Telegram dijalankan.' };
      }
      await wa.startWhatsAppBot(botData, args?.usePairing === true);
      // startWhatsAppBot() balik begitu client dibuat — koneksinya belum tentu
      // hidup. Tunggu 'open' di sini (bukan di engine, biar command WA .start
      // nggak ikut nunggu) supaya jawaban ke web jujur.
      await nungguSiap(botId);
      return { message: 'Bot terhubung ke WhatsApp.' };
    }

    case 'stop':
    case 'stop-if-running': {
      if (!activeBots.has(botId)) {
        if (op === 'stop-if-running') return { message: 'Bot tidak berjalan' };
        const e = new Error('Bot tidak sedang berjalan'); e.status = 400; throw e;
      }
      // stopWhatsAppBot() = jalur mati untuk DUA platform: instance Telegram
      // nggak punya disconnect(), cuma destroy() — dan itu udah diurus di sana.
      await wa.stopWhatsAppBot(botId);
      await pool.execute("UPDATE bots SET status = 'disconnected', is_running = 0 WHERE id = ?", [botId]);
      return { message: 'Bot dihentikan' };
    }

    case 'restart': {
      // Guard di sini, bukan cuma di engine: engine ngelempar tanpa status ->
      // user cuma dapat pesan umum "kesalahan server".
      if (!activeBots.has(botId)) { const e = new Error('Bot tidak sedang berjalan'); e.status = 400; throw e; }
      const botData = await botDariDb(botId);
      if (botData.platform === 'telegram') {
        const inst = activeBots.get(botId);
        if (inst && typeof inst.destroy === 'function') { try { await inst.destroy(); } catch {} }
        activeBots.delete(botId);
        await tg.startTelegramBot(botData);
      } else {
        // Satu jalur restart (sama kayak command WA .restart). Ini nunggu
        // handshake, jadi web dikasih timeout 60 detik di engineBus.
        await wa.restartWhatsAppBot(botId);
        await nungguSiap(botId);
      }
      return { message: 'Bot di-restart' };
    }

    default: {
      const e = new Error('Perintah tidak dikenal: ' + op); e.status = 400; throw e;
    }
  }
}

// ─── Server internal — 127.0.0.1 doang, nggak kebuka ke luar ─────────────────
const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/op') { res.writeHead(404).end(); return; }
  if (req.headers['x-internal-key'] !== KUNCI) { res.writeHead(401).end(); return; }

  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 262144) req.destroy(); });
  req.on('end', async () => {
    let body;
    try { body = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
    const botId = Number(body.botId) || null;
    try {
      const out = await jalankan({ ...body, botId });
      console.log(`[Worker] ${body.op} bot=${botId} ok`);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, ...out }));
      if (body.op !== 'status') kirimEvent({ type: 'running', ids: [...activeBots.keys()] });
    } catch (e) {
      // Error mentah tetap dicatat di log PM2, tapi yang dikirim ke web cuma
      // kalimat yang kita tulis sendiri (e.status di-set) — sisanya umum.
      console.error(`[Worker] ${body.op} bot=${botId} GAGAL:`, e.message);
      const st = e.status || 500;
      res.writeHead(200, { 'content-type': 'application/json' })
         .end(JSON.stringify({ ok: false, status: st, message: st === 500 ? 'Perintah gagal dijalankan di proses bot' : e.message }));
    }
  });
});

// ─── Cron jadwal buka/tutup grup — butuh koneksi bot, jadi ikut worker ───────
cron.schedule('* * * * *', async () => {
  let rows;
  try {
    [rows] = await pool.execute(
      `SELECT gs.bot_id, gs.group_jid, gs.open_time, gs.close_time, gs.open_msg, gs.close_msg
       FROM group_settings gs
       WHERE gs.open_time IS NOT NULL OR gs.close_time IS NOT NULL`
    );
  } catch { return; }
  if (!rows.length) return;

  const skr = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
  const jamNow = `${String(skr.getHours()).padStart(2, '0')}.${String(skr.getMinutes()).padStart(2, '0')}`;

  for (const row of rows) {
    const client = activeBots.get(row.bot_id) || activeBots.get(String(row.bot_id));
    if (!client || typeof client.group?.setSetting !== 'function') continue;
    const jadwal = [];
    if (row.open_time === jamNow)  jadwal.push({ buka: true,  teks: row.open_msg });
    if (row.close_time === jamNow) jadwal.push({ buka: false, teks: row.close_msg });
    for (const j of jadwal) {
      try { await client.group.setSetting(row.group_jid, 'announcement', !j.buka); } catch {}
      const template = j.teks || (j.buka ? mess.openDefault : mess.closeDefault);
      if (!template) continue;
      let meta = null;
      try { meta = await client.group.queryGroupMetadata(row.group_jid); } catch {}
      const { text, mentions } = renderTemplate(template, {
        groupName: meta?.subject || row.group_jid.split('@')[0],
        groupDesc: meta?.desc || '',
      });
      try {
        await client.message.send(row.group_jid, text, { mentions });
        console.log(`[Worker] Grup ${row.group_jid} ${j.buka ? 'dibuka' : 'ditutup'} jam ${jamNow}`);
      } catch (e) { console.error('[Worker] kirim jadwal gagal:', e.message); }
    }
  }
}, { timezone: 'Asia/Jakarta' });

// ─── Boot ────────────────────────────────────────────────────────────────────
async function boot() {
  if (!KUNCI) {
    console.error('[Worker] JWT_SECRET/INTERNAL_KEY kosong di .env — worker dihentikan.');
    process.exit(1);
  }

  wa.setWsBroadcast((ev) => { kirimEvent(ev); });
  tg.setWsBroadcast((ev) => { kirimEvent(ev); });

  await testConnection();

  // Dengerin perintah DULUAN, baru nyalain bot: bot yang handshake-nya lama
  // (WA bisa 10 detik) jangan bikin web nunggu buat sekadar stop/status.
  await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));
  console.log(`[Worker] dengerin perintah di 127.0.0.1:${PORT}`);

  const [bots] = await pool.execute('SELECT * FROM bots WHERE is_running = 1');
  if (bots.length) {
    console.log(`[Worker] auto-start ${bots.length} bot`);
    for (const b of bots) {
      try {
        if (b.platform === 'telegram') await tg.startTelegramBot(b);
        else await wa.startWhatsAppBot(b, false);
      } catch (e) { console.error(`[Worker] auto-start bot ${b.id} gagal:`, e.message); }
    }
  }
  console.log(`[Worker] siap — ${activeBots.size} bot aktif`);
  // Setelah bot nyala, BUKAN sebelumnya: flush() nge-set `_siap = true`, dan
  // push pertama saat web balik adalah daftar bot yang jalan. Kalau flush()
  // dipanggil sebelum auto-start, push di baris ini (dan tiap kirimEvent
  // sebelumnya) cuma masuk buffer 500 dan nggak pernah ke-flush — web nggak
  // pernah tau bot hidup lagi setelah worker restart.
  await flush();
  kirimEvent({ type: 'running', ids: [...activeBots.keys()] });
}

process.on('unhandledRejection', (e) => console.error('[Worker/UnhandledRejection]', e?.message || e));
process.on('uncaughtException',  (e) => console.error('[Worker/UncaughtException]',  e?.message || e));

async function shutdown() {
  console.log('[Worker] Shutdown — status bot direset');
  try {
    await pool.execute("UPDATE bots SET status = 'disconnected' WHERE status IN ('connected','connecting')");
  } catch {}
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

boot().catch((e) => { console.error('[Worker] Fatal:', e); process.exit(1); });
