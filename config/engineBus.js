'use strict';

/**
 * config/engineBus.js — satu-satunya jalur web ↔ worker.
 *
 * Web TIDAK lagi require engine: dia kirim perintah ke worker (HTTP di
 * 127.0.0.1, nggak kebuka ke luar) dan nerima event balik. Efeknya restart web
 * nggak nyentuh bot sama sekali — beda sama dulu, di mana `pm2 restart` =
 * semua bot WA/Telegram reconnect.
 *
 * ponytail: HTTP request/response, bukan IPC/pub-sub — nggak ada broker baru
 * buat dilupain. Ganti ke Redis pub/sub kalau worker-nya lebih dari satu.
 */
const WORKER_URL = `http://127.0.0.1:${process.env.WORKER_PORT || 3001}`;
const KUNCI = () => process.env.INTERNAL_KEY || process.env.JWT_SECRET;

let _sink = () => {};
// Cermin bot yang jalan di worker. Sinkron biar guard "bot sudah berjalan"
// nggak perlu nunggu round-trip tiap klik; worker nge-push tiap ada perubahan.
const _jalan = new Set();

function pasangEventSink(fn) { _sink = fn; }
function kunci() { return KUNCI(); }

function terimaEvent(ev) {
  if (!ev) return;
  if (ev.type === 'running') {
    _jalan.clear();
    for (const id of ev.ids || []) _jalan.add(Number(id));
    return;
  }
  _sink(ev);
}

function isRunning(botId) { return _jalan.has(Number(botId)); }
function runningIds() { return [..._jalan]; }

async function call(op, botId, args) {
  let res;
  try {
    res = await fetch(`${WORKER_URL}/op`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': KUNCI() },
      body: JSON.stringify({ op, botId, args }),
      // 90 detik: start/restart WA nunggu QR dipindai (worker nunggu maks 60).
      signal: AbortSignal.timeout(90000),
    });
  } catch (e) {
    // Worker mati = tombol start/stop nggak ada yang ngerjain. Bilang apa adanya,
    // jangan diem-diem sukses.
    const err = new Error('Proses bot sedang tidak jalan. Coba lagi sebentar lagi.');
    err.status = 503;
    err.cause = e;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const err = new Error(data.message || 'Gagal menghubungi proses bot');
    err.status = data.status || res.status;
    throw err;
  }
  return data;
}

const start   = (botId, usePairing) => call('start', botId, { usePairing });
// status() != isRunning(): yang satu nanya ke worker (bisa hang kalau worker
// beku), yang satunya baca cermin lokal yang di-push worker.
const stop    = (botId)             => call('stop', botId);
const restart = (botId)             => call('restart', botId);
const stopIfRunning = (botId)       => call('stop-if-running', botId);

async function sinkron() {
  try {
    const d = await call('status');
    terimaEvent({ type: 'running', ids: d.ids });
    return d.ids;
  } catch { return runningIds(); }
}

module.exports = {
  pasangEventSink, terimaEvent, kunci, isRunning, runningIds,
  start, stop, restart, stopIfRunning, sinkron,
};
