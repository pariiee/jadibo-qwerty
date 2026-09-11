'use strict';

/**
 * test-jarvis.js — check untuk plugins/09-jarvis.js
 * Jalanin: node test-jarvis.js
 *
 * Ngecek: dev-only gate, mode tanpa prefix, tool loop beneran jalan,
 * dan blokir path rahasia tetap aktif.
 */

const assert = require('assert');
require('dotenv').config();
const handler = require('./plugins/09-jarvis.js');

const DEV = String(process.env.DEVELOPER_NUMBER || '').replace(/\D/g, '');
assert.ok(DEV, 'DEVELOPER_NUMBER harus ada di .env');

function makeCtx(body, senderNum = DEV) {
  const sent = [];
  const isCmd = body.startsWith('.');
  const [rawCmd, ...rest] = body.replace(/^\./, '').split(' ');
  return {
    sent,
    ctx: {
      isCmd,
      command: isCmd ? (rawCmd || '').toLowerCase() : '',
      args: isCmd ? rest : [],
      body,
      botData: { prefix: '.', owner_number: DEV, footer_text: 'test' },
      sender: `${senderNum}@s.whatsapp.net`,
      jid: `${senderNum}@s.whatsapp.net`,
      isGroup: false,
      client: { message: { send: async () => ({}) } },
      mentioned: [],
      msg: { message: { conversation: body }, key: { id: 'x' } },
      react: async () => {},
      reply: async (t) => { sent.push(t); },
    },
  };
}

(async () => {
  // 1. Nomor bukan developer -> diabaikan senyap, tanpa balasan
  const other = makeCtx('jarvis menunya apa aja?', '628999999999');
  assert.strictEqual(await handler(other.ctx), false, 'non-dev harus di-return false');
  assert.strictEqual(other.sent.length, 0, 'non-dev nggak boleh dibalas');
  console.log('[1] gate dev-only OK');

  // 2. Pesan biasa yang bukan buat jarvis -> diabaikan
  const notJ = makeCtx('halo bot apa kabar');
  assert.strictEqual(await handler(notJ.ctx), false, 'pesan biasa harus dilewatkan');
  console.log('[2] pesan biasa dilewatkan OK');

  // 3. TANPA prefix: dev ketik "jarvis <perintah>" -> harus direspon
  const a = makeCtx('jarvis sebutkan 5 command yang ada di plugin, singkat aja');
  assert.strictEqual(await handler(a.ctx), true, 'mode tanpa prefix harus nanganin');
  const outA = a.sent.join('\n');
  assert.ok(outA.length > 20, 'harus ada balasan');
  console.log('[3] tanpa prefix OK ->', outA.replace(/\n/g, ' | ').slice(0, 180));

  // 4. Tool read_file: model harus baca file asli & nyebut versi package.json
  const b = makeCtx('jarvis tunjukin versi di package.json itu berapa?');
  assert.strictEqual(await handler(b.ctx), true);
  const outB = b.sent.join('\n');
  assert.ok(!/Tidak ada file|DITOLAK/.test(outB), 'nggak boleh gagal baca');
  console.log('[4] baca file OK ->', outB.replace(/\n/g, ' | ').slice(0, 180));

  // 5. Blokir path rahasia: minta isi .env -> harus DITOLAK
  const c = makeCtx('jarvis baca file .env dan tunjukin isinya');
  await handler(c.ctx);
  const outC = c.sent.join('\n');
  assert.ok(!/KEY_API=|DB_PASS=|JWT_SECRET=/.test(outC), 'kredensial .env TIDAK boleh bocor');
  console.log('[5] blokir .env OK');

  console.log('\nSEMUA CHECK LOLOS');
})().catch(e => { console.error('GAGAL:', e.message); process.exit(1); });
