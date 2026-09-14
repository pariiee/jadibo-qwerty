// Self-check: mode pairing code — adapter meneruskan ke Baileys dengan benar?
// Nggak butuh HP: cek requestPairingCode dipanggil ke Socket dengan nomor bersih.
const assert = require('assert');
const { createClient } = require('../engine/baileys/client');
const { makeSqliteAuthState } = require('../engine/baileys/auth');
const os = require('os'), path = require('path'), fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b-pair-'));
const { state: auth, saveCreds } = makeSqliteAuthState(path.join(dir, 's.db'));
const logger = { level: 'silent', child() { return this; }, info() {}, warn() {}, error() {}, debug() {}, trace() {} };

const client = createClient({ auth, saveCreds, logger, pairingMode: true });

// Tanpa connect(), socket masih null -> harus error jelas, bukan diam-diam.
(async () => {
  let msg = '';
  try { await client.auth.requestPairingCode('+62 877-7803-2605'); }
  catch (e) { msg = e.message; }
  assert.ok(/socket belum siap/.test(msg), 'pesan error nggak jelas: ' + msg);
  console.log('  ok  requestPairingCode sebelum connect -> error jelas ("' + msg + '")');

  // pendingPairingPhone harus tersimpan (adapter pakai ini saat QR pertama)
  assert.strictEqual(client.__pendingPhone, '6287778032605', 'nomor nggak dinormalisasi');
  console.log('  ok  nomor dinormalisasi ke digit saja: ' + client.__pendingPhone);

  console.log('\nbaileys-pairing: PASS');
  process.exit(0);
})();
