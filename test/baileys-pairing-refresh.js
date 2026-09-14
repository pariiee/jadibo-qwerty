/**
 * Regresi: pairing code harus DIPERBARUI tiap QR baru, bukan sekali doang.
 *
 * Kenapa ada: Baileys emit QR baru tiap ~20s selama belum di-scan
 * (node_modules/baileys/lib/Socket/socket.js:722-723). Versi lama pakai
 * `client.once('auth_qr', ...)` -> cuma dapet kode pertama. Habis masa
 * berlaku, kode mati dan nggak ada pengganti (keluhan user).
 *
 * Tes ini nggak butuh koneksi WA: ia pakai client palsu yang niru urutan
 * event Baileys, lalu ngitung berapa kali pairing code diminta.
 */
const assert = require('assert');
const { EventEmitter } = require('events');

const calls = [];
const fake = new EventEmitter();
fake.auth = {
  requestPairingCode: async (phone) => {
    calls.push(phone);
    return 'ABCD' + String(calls.length).padStart(4, '0');
  },
};

// --- Salinan persis listener dari engine/whatsappEngine.js --------------
function attachListener(phoneNumber) {
  let pairingBusy = false;
  fake.on('auth_pairing_required', async ({ ttlMs } = {}) => {
    if (pairingBusy) return;
    pairingBusy = true;
    try {
      const code = await fake.auth.requestPairingCode(phoneNumber);
      const formatted = String(code).match(/.{1,4}/g)?.join('-') || code;
      fake.emit('_pairing_code_broadcast', { code: formatted, ttlMs: ttlMs || 20000 });
    } finally {
      pairingBusy = false;
    }
  });
}

(async () => {
  const emitted = [];
  fake.on('_pairing_code_broadcast', (p) => emitted.push(p));
  attachListener('6287778032605');

  // 3 siklus QR: niru QR pertama (ttl 60s) + 2 QR pengganti (ttl 20s)
  const ttls = [60000, 20000, 20000];
  for (let i = 0; i < 3; i++) {
    fake.emit('auth_qr', { qr: 'qr-' + i, ttlMs: ttls[i] });
    fake.emit('auth_pairing_required', { ttlMs: ttls[i] }); // diemit bareng tiap auth_qr
    await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => setTimeout(r, 50)); // kasih waktu async selesai

  assert.strictEqual(calls.length, 3,
    `harusnya 3x minta pairing code (1 per QR), dapet ${calls.length}`);
  assert.strictEqual(emitted.length, 3,
    `harusnya 3x broadcast kode, dapet ${emitted.length}`);
  assert.deepStrictEqual(emitted.map((p) => p.ttlMs), ttls,
    'ttlMs harus diteruskan apa adanya ke web (60s lalu 20s)');
  assert.notStrictEqual(emitted[0].code, emitted[1].code,
    'kode ke-2 harus BEDA dari ke-1 (bukan kode mati yang beredar ulang)');

  console.log('OK  pairing code diperbarui tiap QR');
  console.log('    kode:', emitted.map((e) => e.code).join(' -> '));
  console.log('    ttl :', emitted.map((e) => e.ttlMs + 'ms').join(' -> '));
  console.log(`    ${calls.length} request / 3 QR, nomor ${[...new Set(calls)][0]}`);

  // Pastikan listener menjaga burst: dua emit beruntun cuma jadi 1 request
  calls.length = 0; emitted.length = 0;
  fake.emit('auth_pairing_required', { ttlMs: 20000 });
  fake.emit('auth_pairing_required', { ttlMs: 20000 }); // nempel, harus di-skip pairingBusy
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(calls.length, 1, 'burst harus di-dedupe jadi 1 request');
  console.log('OK  burst di-dedupe (pairingBusy)');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
