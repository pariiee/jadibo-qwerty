'use strict';
/**
 * test/proteksi-on-off-noarg.js
 * Memastikan handler .on dan .off tanpa argumen tidak melempar ReferenceError
 * dan balasan status fitur terkirim normal.
 */

const assert = require('assert');
const proteksiHandler = require('../plugins/06-proteksi');

(async () => {
  let repliedText = '';
  const mockCtx = {
    isCmd: true,
    command: 'on',
    args: [],
    botData: { id: 4, prefix: '.' },
    jid: '120363000000000000@g.us',
    isGroup: true,
    isOwner: true,
    isAdmin: true,
    isBotAdmin: true,
    sender: '628123456789@s.whatsapp.net',
    reply: async (text) => {
      repliedText = text;
    }
  };

  // Test .on tanpa argumen
  const handledOn = await proteksiHandler(mockCtx);
  assert.strictEqual(handledOn, true, '.on tanpa argumen harus ditangani');
  assert.ok(repliedText.includes('Status Fitur'), 'Balasan .on harus memuat Status Fitur');
  assert.ok(repliedText.includes('Ketik `.on <fitur>`'), 'Balasan .on harus memuat instruksi toggle');

  // Test .off tanpa argumen
  repliedText = '';
  mockCtx.command = 'off';
  const handledOff = await proteksiHandler(mockCtx);
  assert.strictEqual(handledOff, true, '.off tanpa argumen harus ditangani');
  assert.ok(repliedText.includes('Status Fitur'), 'Balasan .off harus memuat Status Fitur');

  console.log('✓ Handler .on dan .off tanpa argumen berjalan sukses tanpa error!');
  process.exit(0);
})().catch(err => {
  console.error('❌ Gagal uji .on/.off tanpa argumen:', err);
  process.exit(1);
});
