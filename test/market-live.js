'use strict';
/**
 * Jalankan handler `.harga` yang LIVE dengan data PRODUKSI (tanpa stub API).
 * Tujuan: lihat teks yang bakal dikirim ke WhatsApp itu kayak apa.
 *
 * Pakai: node test/harga-live.js [simbol...]
 * KEY_API dibaca dari .env — nggak pernah dicetak.
 */
require('dotenv').config();
const handler = require('../plugins/04-tools');
const api = require('../engine/api');

const args = process.argv.slice(2);
const teks = [];

const ctx = {
  isCmd: true,
  command: 'market',
  args,
  prefix: '.',
  jid: 'uji@s.whatsapp.net',
  sender: 'uji@s.whatsapp.net',
  isGroup: false,
  msg: { key: { id: 'uji-live' }, message: {} },
  botData: { prefix: '.' },
  reply: async (t) => { teks.push(typeof t === 'string' ? t : JSON.stringify(t, null, 2)); },
  react: async () => {},
};

(async () => {
  console.log(`[apiUrl=${api.url('api/tools/harga-saham')}]`);
  await handler(ctx);
  console.log(teks.join('\n') || '(nggak ada balasan)');
  process.exit(0);
})();
