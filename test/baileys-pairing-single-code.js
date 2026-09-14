/**
 * Regresi: pairing code cuma boleh diminta SEKALI selama kode itu hidup.
 *
 * Kejadian nyata (log panel user):
 *   [20.32.54] Pairing Code: EBTQ-DYSL
 *   [20.33.54] Pairing Code: YWZ5-5854   <-- 60s kemudian, kode lama mati
 *   [20.34.14] Pairing Code: 4BA9...     <-- 20s kemudian, lagi
 * User ngetik EBTQ-DYSL -> WA loading terus, nggak pernah connected.
 *
 * Sebab: requestPairingCode Baileys nulis authState.creds.pairingCode
 * (socket.js:601), dan generatePairingKey (socket.js:658) derive kunci dari
 * kode itu. Panggilan ulang = kode lama langsung invalid.
 *
 * Socket di-stub, tapi stubnya NIRU efek samping aslinya: nimpa creds.pairingCode.
 */
const assert = require('assert');
const { EventEmitter } = require('events');

// ── Stub baileys: socket palsu yang creds.pairingCode-nya ketimpa tiap panggilan ──
const realBaileys = require('baileys');
const baileysPath = require.resolve('baileys');

function makeFakeSocket() {
  const ev = new EventEmitter();
  ev.setMaxListeners(50);
  const creds = {};
  const sock = {
    ev,
    user: { id: '6287778032605:1@s.whatsapp.net' },
    end: () => {},
    ws: { close: () => {} },
    sendMessage: async () => ({}),
    relayMessage: async () => {},
    logout: async () => {},
    calls: 0,
    creds,
    // NB: fungsi biasa, BUKAN arrow — `this` harus nunjuk ke sock.
    requestPairingCode: async function () {
      // Tiru socket.js:596-606: tulis ulang creds.pairingCode tiap panggilan.
      sock.calls++;
      creds.pairingCode = `CODE-${sock.calls}`;
      return creds.pairingCode;
    },
  };
  return sock;
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
  const c = createClient({ auth: { creds: {}, keys: {} }, saveCreds: () => {}, pairingMode: true });
  c.connect().catch(() => {});
  await new Promise((r) => setTimeout(r, 20));

  // Engine minta kode tiap QR baru (60s, lalu 20s, lalu 20s) — bakal panggil 3x.
  const codes = [];
  for (let i = 0; i < 3; i++) {
    codes.push(await c.auth.requestPairingCode('6287778032605'));
    await new Promise((r) => setTimeout(r, 5));
  }

  assert.strictEqual(lastSock.calls, 1,
    `requestPairingCode ke socket harus 1x, dapet ${lastSock.calls}x (kode lama ke-nimpa tiap panggilan)`);
  assert.deepStrictEqual(codes, ['CODE-1', 'CODE-1', 'CODE-1'],
    `semua QR harus dapet kode yg sama, dapet ${JSON.stringify(codes)}`);

  // yang paling penting: kode yg ditampilin di panel masih == creds WA
  assert.strictEqual(lastSock.creds.pairingCode, codes[0],
    `creds.pairingCode (${lastSock.creds.pairingCode}) harus masih sama dgn kode panel (${codes[0]})`);

  console.log(`OK  requestPairingCode dipanggil ${lastSock.calls}x untuk 3 QR (bukan 3x)`);
  console.log(`OK  kode panel stabil: ${codes.join(' === ')}`);
  console.log(`OK  creds.pairingCode masih ${lastSock.creds.pairingCode} — kode tetap valid saat diinput`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
