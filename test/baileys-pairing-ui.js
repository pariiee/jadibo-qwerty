/**
 * Regresi UI pairing: di mode pairing, adapter TIDAK BOLEH emit 'auth_qr'.
 *
 * Kenapa ada: engine menandai bot sebagai pairingMode (whatsappEngine.js:229)
 * supaya panel web nampilin pairing code, bukan QR. Tapi adapter dulu tetap
 * emit 'auth_qr' tiap ~20s -> engine broadcast 'qr' -> panel pairing ketimpa
 * QR dan kodenya hilang dari layar. Test ini ngunci perilaku itu.
 *
 * Trik: baileys di-stub di module cache sebelum adapter di-require, jadi
 * makeWASocket diganti socket palsu — nggak ada koneksi WA beneran.
 */
const assert = require('assert');
const { EventEmitter } = require('events');

// ── Stub baileys ────────────────────────────────────────────────────────────
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
    requestPairingCode: async () => 'ABCD1234',
    logout: async () => {},
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

(async () => {
  // ── 1. pairingMode: QR nggak boleh lolos, pairing code harus tetap jalan ──
  const c1 = createClient({ auth: { creds: {}, keys: {} }, saveCreds: () => {}, pairingMode: true });
  const got = { qr: 0, pairReq: 0 };
  c1.on('auth_qr', () => got.qr++);
  c1.on('auth_pairing_required', () => got.pairReq++);
  c1.connect().catch(() => {});
  await new Promise((r) => setTimeout(r, 20));

  lastSock.ev.emit('connection.update', { qr: 'qr-1' });
  lastSock.ev.emit('connection.update', { qr: 'qr-2' }); // QR pengganti ~20s
  await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(got.qr, 0,
    `pairingMode=true: 'auth_qr' harus 0, dapet ${got.qr} (panel pairing bakal ketimpa QR)`);
  assert.strictEqual(got.pairReq, 2,
    `pairingMode=true: 'auth_pairing_required' harus 2, dapet ${got.pairReq}`);
  console.log('OK  pairingMode=true -> 0 auth_qr, 2 auth_pairing_required');

  // ── 2. ttl ikut umur QR: pertama 60s, sisanya 20s ─────────────────────────
  const ttls = [];
  const c2 = createClient({ auth: { creds: {}, keys: {} }, saveCreds: () => {}, pairingMode: true });
  c2.on('auth_pairing_required', ({ ttlMs }) => ttls.push(ttlMs));
  c2.connect().catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
  for (let i = 0; i < 3; i++) lastSock.ev.emit('connection.update', { qr: 'q' + i });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(ttls, [60000, 20000, 20000], 'ttl: 60s lalu 20s');
  console.log('OK  ttl per QR:', ttls.map((t) => t + 'ms').join(' -> '));

  // ── 3. mode QR normal tetap dapet 'auth_qr' (jangan kebalik) ──────────────
  const c3 = createClient({ auth: { creds: {}, keys: {} }, saveCreds: () => {}, pairingMode: false });
  const got3 = { qr: 0, pairReq: 0 };
  c3.on('auth_qr', () => got3.qr++);
  c3.on('auth_pairing_required', () => got3.pairReq++);
  c3.connect().catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
  lastSock.ev.emit('connection.update', { qr: 'qr-x' });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(got3.qr, 1, `pairingMode=false: 'auth_qr' harus 1, dapet ${got3.qr}`);
  assert.strictEqual(got3.pairReq, 1, 'pairingMode=false: pairing_required tetap diemit');
  console.log('OK  pairingMode=false -> QR normal (1 auth_qr)');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
