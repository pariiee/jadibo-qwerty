// Self-check: dua jalur kirim yang dipakai adapter, diuji ke proto asli.
//   Jalur A (friendly): sock.sendMessage(jid, toBaileysContent(c), opts)
//   Jalur B (proto mentah/tombol): generateWAMessageFromContent + relayMessage
// Catatan: generateWAMessageContent ASYNC — wajib di-await.
// Jalankan: node baileys-send-paths
const assert = require('assert');
const {
  generateWAMessageContent, generateWAMessageFromContent,
  normalizeMessageContent, getContentType,
} = require('baileys');
const { toBaileysContent, isRawProto } = require('../engine/baileys/client');

let pass = 0, fail = 0;
const ok = async (label, fn) => {
  try { await fn(); pass++; console.log('  ok  ' + label); }
  catch (e) { fail++; console.log('  FAIL ' + label + ' :: ' + e.message); }
};

// options minimal yg dibaca generateWAMessageContent
const mkOpts = () => ({
  logger: { level: 'silent', child() { return this; }, info() {}, warn() {}, error() {}, debug() {}, trace() {} },
  upload: async () => ({ mediaUrl: 'https://x/y', directPath: '/x/y' }),
  getUrlInfo: async () => undefined,
});

(async () => {
  // ═══ JALUR A: konten friendly -> sendMessage ══════════════════════════════

  await ok('A1. teks balasan -> extendedTextMessage (bot bisa ngebalas)', async () => {
    const res = await generateWAMessageContent({ text: 'halo dunia' }, mkOpts());
    const inner = normalizeMessageContent(res);
    const txt = inner.conversation ?? inner.extendedTextMessage?.text;
    assert.strictEqual(txt, 'halo dunia');
  });

  await ok('A2. contextInfo (caption yapari.web.id) NEMPEL, nggak ilang', async () => {
    const res = await generateWAMessageContent({
      text: 'x',
      contextInfo: { quotedMessage: { groupInviteMessage: { caption: 'www.yapari.web.id' } } },
    }, mkOpts());
    const ci = normalizeMessageContent(res).extendedTextMessage?.contextInfo;
    assert.ok(ci, 'contextInfo HILANG');
    assert.strictEqual(ci.quotedMessage.groupInviteMessage.caption, 'www.yapari.web.id');
  });

  await ok('A3. toBaileysContent({type:text}) -> teks terkirim', async () => {
    const res = await generateWAMessageContent(toBaileysContent({ type: 'text', text: 'hai' }), mkOpts());
    assert.strictEqual(normalizeMessageContent(res).extendedTextMessage.text, 'hai');
  });

  await ok('A4. gambar + caption -> imageMessage', async () => {
    const res = await generateWAMessageContent(toBaileysContent({
      type: 'image', media: Buffer.from('xx'), caption: 'halo', mimetype: 'image/jpeg',
    }), mkOpts());
    assert.ok(res.imageMessage, 'imageMessage nggak kebentuk');
    assert.strictEqual(res.imageMessage.caption, 'halo');
  });

  await ok('A5. mentions -> contextInfo.mentionedJid', async () => {
    const res = await generateWAMessageContent(toBaileysContent({
      type: 'text', text: 'hi @628', mentions: ['628@s.whatsapp.net'],
    }), mkOpts());
    const ci = normalizeMessageContent(res).extendedTextMessage?.contextInfo;
    assert.deepStrictEqual(ci?.mentionedJid, ['628@s.whatsapp.net']);
  });

  // ═══ JALUR B: proto mentah (tombol) -> relayMessage ══════════════════════

  for (const [label, inner] of [
    ['interactiveMessage', { interactiveMessage: { body: { text: 'M' }, footer: { text: '' } } }],
    ['buttonsMessage', { buttonsMessage: { contentText: 'M', footerText: 'f', headerType: 1 } }],
    ['listMessage', { listMessage: { title: 'M', description: 'd', buttonText: 'B', listType: 1, sections: [] } }],
  ]) {
    await ok(`B. ${label} lolos jalur relayMessage`, () => {
      const wam = generateWAMessageFromContent('g@g.us', inner, { userJid: 'me@s.whatsapp.net' });
      assert.strictEqual(getContentType(wam.message), label);
    });
  }

  await ok('B4. adapter mendeteksi proto mentah (biar nggak kena "Invalid media type")', () => {
    assert.strictEqual(isRawProto({ interactiveMessage: {} }), true);
    assert.strictEqual(isRawProto({ buttonsMessage: {} }), true);
    assert.strictEqual(isRawProto({ listMessage: {} }), true);
    assert.strictEqual(isRawProto({ text: 'x' }), false);
    assert.strictEqual(isRawProto(null), false);
  });

  // ═══ Kode "budget" lu: buttonsMessage + locationMessage + jpegThumbnail ══
  await ok('B5. buttonsMessage + locationMessage + jpegThumbnail lolos UTUH', () => {
    const btns = {
      buttonsMessage: {
        locationMessage: { degreesLatitude: 0, degreesLongitude: 0, name: 'Bot', address: 'x', jpegThumbnail: Buffer.from('t') },
        contentText: 'menu', footerText: 'f', headerType: 6,
        buttons: [{ buttonId: 'menu', buttonText: { displayText: 'MENU' }, type: 1 }],
      },
    };
    const wam = generateWAMessageFromContent('g@g.us', btns, { userJid: 'me@s.whatsapp.net' });
    assert.strictEqual(getContentType(wam.message), 'buttonsMessage');
    const b = normalizeMessageContent(wam.message).buttonsMessage;
    assert.strictEqual(b.headerType, 6);
    assert.ok(b.locationMessage.jpegThumbnail, 'jpegThumbnail ilang');
    assert.strictEqual(b.buttons[0].buttonId, 'menu');
    assert.strictEqual(b.buttons[0].buttonText.displayText, 'MENU');
  });

  console.log(`\nbaileys-send-paths: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
