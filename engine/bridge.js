'use strict';

/**
 * bridge.js — jalur perintah lintas panel: panel labs → engine zapo.
 *
 * Kenapa ada: user cuma mau buka SATU panel (labs.yapari.web.id), tapi bot 4
 * harus jalan pakai engine zapo. Panel labs nggak punya engine zapo, jadi
 * Start-nya dikerjakan app ini — UI, login, WebSocket, dan penerimaan log
 * tetap milik panel labs.
 *
 * Alur:
 *   1. User klik Start di panel labs (bot platform `zapo`).
 *   2. Worker panel labs nggak nyalain sendiri (lihat workers/botWorker.js:
 *      dia nolak bot platform lain), tapi nembak POST /internal/op di sini.
 *   3. App ini nyalain bot pakai engine zapo, lalu SEMUA event (log/QR/status)
 *      diteruskan ke POST /internal/engine-event milik panel labs — bentuk
 *      eventnya identik ({ botId, type, payload, ts }), jadi UI labs nggak
 *      perlu cabang baru.
 *
 * Kunci: process.env.INTERNAL_KEY — HARUS sama dengan panel labs.
 * Tujuan event: ENGINE_WEB_URL (default http://127.0.0.1:3000).
 */

const http = require('http');

const WEB_URL = process.env.ENGINE_WEB_URL || 'http://127.0.0.1:3000';
const KUNCI = process.env.INTERNAL_KEY;
const PLATFORM_SINI = process.env.BRIDGE_PLATFORM || 'zapo';

/**
 * Teruskan satu event engine ke panel labs. Kegagalan kirim cuma dicatat
 * diam-diam: panel labs boleh restart tanpa bikin proses ini mati.
 */
function kirimEvent(ev) {
  if (!KUNCI) return;
  let body;
  try { body = JSON.stringify(ev); } catch { return; }
  const u = new URL('/internal/engine-event', WEB_URL);
  const req = http.request({
    hostname: u.hostname,
    port: u.port,
    path: u.pathname,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'x-internal-key': KUNCI,
    },
  }, (res) => res.resume());
  req.on('error', () => { /* panel labs lagi restart: event log doang, nggak fatal */ });
  req.setTimeout(5000, () => { req.destroy(); });
  req.write(body);
  req.end();
}

/**
 * Bungkus broadcast milik app ini supaya event-nya KE DUA arah: tetap ke
 * WebSocket panel zapo sendiri, dan diteruskan ke panel labs.
 *
 * Dipakai begini di server.js:
 *   const gabung = bridge.pasangRelay(broadcastFn);
 *   setWsBroadcastWa(gabung); setWsBroadcastTg(gabung);
 */
function pasangRelay(broadcastFn) {
  return (ev) => {
    try { broadcastFn?.(ev); } catch { /* jangan bikin broadcast mati gara-gara relay */ }
    kirimEvent(ev);
  };
}

/** Op yang dilayani. Bot yang bukan platform app ini ditolak. */
async function jalankan({ op, botId, args }) {
  const wa = require('./whatsappEngine');
  const { pool } = require('../config/database');

  const [rows] = await pool.execute('SELECT * FROM bots WHERE id = ?', [botId]);
  if (!rows.length) { const e = new Error('Bot tidak ditemukan'); e.status = 404; throw e; }
  const botData = rows[0];

  if (botData.platform !== PLATFORM_SINI) {
    const e = new Error(`Bot ini bukan bot ${PLATFORM_SINI} — jalankan dari panel yang biasa.`);
    e.status = 400;
    throw e;
  }

  switch (op) {
    case 'start':
      await wa.startWhatsAppBot(botData, args?.usePairing === true);
      return { message: 'Bot sedang memulai. Pantau log untuk QR/Pairing Code.' };
    case 'stop':
    case 'stop-if-running':
      await wa.stopWhatsAppBot(botId);
      return { message: 'Bot dihentikan' };
    case 'restart':
      await wa.restartWhatsAppBot(botId);
      return { message: 'Bot di-restart' };
    default: {
      const e = new Error('Perintah tidak dikenal: ' + op); e.status = 400; throw e;
    }
  }
}

/** Cuma boleh dari loopback: tunnel/proxy nggak punya jalur ke sini. */
function dariLoopback(req) {
  const ip = (req.socket && req.socket.remoteAddress) || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * Handler Express untuk `POST /internal/op` — bentuk & jawabannya sengaja sama
 * dengan worker panel labs (`{ ok, message }`), biar panel labs nggak punya
 * cabang khusus.
 */
async function route(req, res) {
  if (!dariLoopback(req)) return res.status(403).json({ ok: false, message: 'Permintaan ditolak' });
  if (!KUNCI || req.get('x-internal-key') !== KUNCI) return res.status(401).json({ ok: false });
  const botId = parseInt(req.body?.botId, 10) || null;
  try {
    const out = await jalankan({ op: req.body?.op, botId, args: req.body?.args });
    return res.json({ ok: true, ...out });
  } catch (e) {
    // Error mentah tetap masuk log PM2; yang keluar cuma kalimat yang kita
    // tulis sendiri (e.status di-set) — sisanya umum.
    console.error(`[Bridge] ${req.body?.op} bot=${botId} GAGAL:`, e.message);
    const st = e.status || 500;
    return res.status(st).json({ ok: false, status: st, message: e.status ? e.message : 'Terjadi kesalahan di engine zapo' });
  }
}

module.exports = { pasangRelay, kirimEvent, jalankan, route, dariLoopback, PLATFORM_SINI };
