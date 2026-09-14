/**
 * Regresi fix #2 — klasifikasi disconnect + loop pairing.
 *
 * Kejadian nyata (log panel user):
 *   [20.21.12] Memulai bot "qwerty BOT"...
 *   [20.21.12] Koneksi terputus: Connection Failure
 *   [20.21.12] Sesi logout. Hapus sesi untuk scan ulang.
 * → engine berhenti total, nggak reconnect, user nggak pernah bisa pairing.
 *
 * Sebab: WA nolak handshake bot yang BELUM pernah paired dengan
 * <failure reason="401">, dan Baileys naikin jadi statusCode 401
 * (socket.js:798 `ws.on('CB:failure')`). Adapter kita dulu nge-anggap
 * SEMUA 401 = loggedOut → engine masuk cabang logout → stop.
 *
 * Fix: 401 cuma logout kalau sesi memang sudah terdaftar (creds.me.lid).
 * Bagian A nguji itu. Bagian B ngunci 2 invariant engine yang gampang
 * ke-revert tanpa sadar (mode pairing di reconnect, is_running jangan
 * di-nol-in saat putus koneksi sesaat).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// ── Stub baileys ─────────────────────────────────────────────────────────────
const realBaileys = require('baileys');
const baileysPath = require.resolve('baileys');

function makeFakeSocket() {
  const ev = new EventEmitter();
  ev.setMaxListeners(50);
  return {
    ev,
    user: { id: '6287778032605:1@s.whatsapp.net' },
    end: () => {},
    ws: { close: () => {} },
    sendMessage: async () => ({}),
    relayMessage: async () => {},
    logout: async () => {},
    requestPairingCode: async () => 'CODE-1',
  };
}
let lastSock = null;
require.cache[baileysPath] = {
  id: baileysPath, filename: baileysPath, loaded: true,
  exports: Object.assign({}, realBaileys, {
    makeWASocket: () => (lastSock = makeFakeSocket()),
  }),
};

const { createClient } = require('../engine/baileys/client.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Kirim event close ke adapter, balikin payload yang di-emit.
async function closeWith(creds, statusCode) {
  const c = createClient({ auth: { creds, keys: {} }, saveCreds: () => {}, pairingMode: true });
  let got = null;
  c.on('connection', (e) => { if (e.status === 'close') got = e; });
  c.connect().catch(() => {});
  await sleep(20);

  const err = new Error('Connection Failure');
  err.output = { statusCode };
  lastSock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: err } });
  await sleep(10);

  assert.ok(got, `adapter harus emit connection:close utk statusCode ${statusCode}`);
  return got;
}

// ── Bagian A: klasifikasi 401 ────────────────────────────────────────────────
const PAIRING_ME = { id: '6287778032605@s.whatsapp.net', name: '~' }; // persis socket.js:602
const PAIRED_ME = { id: '6287778032605@s.whatsapp.net', name: 'YaaParBot', lid: '1234:5@lid' };

(async () => {
  // 1. 401 pas pairing (belum pernah paired) → BUKAN logout, harus reconnect.
  let e = await closeWith({ me: { ...PAIRING_ME } }, 401);
  assert.strictEqual(e.isLogout, false,
    '401 pada bot yang belum pernah paired harus isLogout=false (WA nolak handshake, bukan sesi mati)');

  // 2. 401 di sesi yang udah terdaftar → logout beneran.
  e = await closeWith({ me: { ...PAIRED_ME } }, 401);
  assert.strictEqual(e.isLogout, true,
    '401 pada sesi terdaftar (creds.me.lid ada) harus isLogout=true');

  // 3. 401 tanpa creds sama sekali → bukan logout.
  e = await closeWith({}, 401);
  assert.strictEqual(e.isLogout, false, '401 tanpa creds harus isLogout=false');

  // 4. Stream error biasa (500) → bukan logout.
  e = await closeWith({ me: { ...PAIRING_ME } }, 500);
  assert.strictEqual(e.isLogout, false, 'statusCode 500 (bad session/stream error) harus isLogout=false');

  console.log('OK  401 + belum pernah paired -> isLogout=false (reconnect, kode pairing masih bisa dipakai)');
  console.log('OK  401 + sesi terdaftar (me.lid) -> isLogout=true (stop, user emang harus re-pair)');
  console.log('OK  401 tanpa creds -> isLogout=false');
  console.log('OK  500 stream error -> isLogout=false');

  // ── Bagian B: invariant engine ─────────────────────────────────────────────
  const engine = fs.readFileSync(path.join(__dirname, '..', 'engine', 'whatsappEngine.js'), 'utf8');

  assert.ok(/startWhatsAppBot\(freshBotData, pairingBots\.has\(botId\)\)/.test(engine),
    'auto-reconnect harus bawa niat pairing (pairingBots.has(botId)) — kalau hardcode false, panel yg lagi nampilin kode pairing ketimpa QR');
  assert.ok(!/startWhatsAppBot\(freshBotData, false\)/.test(engine),
    'reconnect hardcode `false` bikin mode pairing ilang');

  assert.ok(/UPDATE bots SET status = 'disconnected' WHERE id = \?/.test(engine),
    "putus koneksi sesaat harus update status doang, BUKAN is_running (server.js:242 butuh is_running=1 buat auto-start pas boot)");
  assert.ok(!/SET status = 'disconnected', is_running = 0/.test(engine),
    'is_running=0 tiap disconnect bikin bot hilang dari daftar auto-start');

  const zeroSites = engine.match(/UPDATE bots SET is_running = 0/g) || [];
  assert.strictEqual(zeroSites.length, 2,
    `is_running=0 cuma boleh di 2 tempat (stop manual + logout), ketemu ${zeroSites.length}`);

  console.log('OK  reconnect pakai pairingBots.has(botId), bukan hardcode false');
  console.log("OK  close cuma set status='disconnected' — is_running utuh buat auto-start boot");
  console.log('OK  is_running=0 cuma di 2 tempat: stop manual + logout');
})().catch((err) => { console.error('FAIL', err.message); process.exit(1); });
