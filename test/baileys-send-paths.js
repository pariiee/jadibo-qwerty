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

  // ═══ `nativeFlowInfo` nempel di tombol `buttonsMessage` (jalur `.test4`) ════
  // Ini yang bikin tombol sebaris DAN dropdown hidup sekaligus. Kalau Baileys
  // atau proto-nya berubah dan field ini dibuang di jalur kirim, tombol 📂 bakal
  // balik jadi tombol mati (bubble kedua) — test ini yang nangkep lebih dulu.
  await ok('B6. buttonsMessage + nativeFlowInfo.single_select selamat di jalur kirim', () => {
    const params = JSON.stringify({
      title: '📂',
      sections: [{ title: 'Kategori', highlight_label: 'YaaPar Menu',
        rows: [{ title: 'INFO', description: '14 Command', id: '.menu info' }] }],
    });
    const wam = generateWAMessageFromContent('g@g.us', {
      buttonsMessage: {
        contentText: 'menu', footerText: 'f', headerType: 6,
        buttons: [{ buttonId: 'btn_cat', buttonText: { displayText: '📂' }, type: 1,
          nativeFlowInfo: { name: 'single_select', paramsJson: params } }],
      },
    }, { userJid: 'me@s.whatsapp.net' });
    const b = normalizeMessageContent(wam.message).buttonsMessage;
    assert.strictEqual(b.buttons[0].buttonId, 'btn_cat');
    assert.strictEqual(b.buttons[0].nativeFlowInfo.name, 'single_select', 'nativeFlowInfo dibuang');
    assert.strictEqual(JSON.parse(b.buttons[0].nativeFlowInfo.paramsJson).sections[0].rows[0].id, '.menu info');
  });

  // ═══ .owner kirim kontak — sendMessage nolak, relayMessage nerima ══════════
  // Gejala nyata: [20.43.44] owner: Invalid media type
  await ok('C1. contactMessage dideteksi proto-mentah (jalur relayMessage)', () => {
    assert.strictEqual(isRawProto({ contactMessage: { displayName: 'X', vcard: 'v' } }), true);
    assert.strictEqual(isRawProto({ contactsArrayMessage: { contacts: [] } }), true);
    assert.strictEqual(isRawProto({ locationMessage: { degreesLatitude: 0 } }), true);
    assert.strictEqual(isRawProto({ liveLocationMessage: {} }), true);
    assert.strictEqual(isRawProto({ pollCreationMessageV3: {} }), true);
  });

  await ok('C2. contactMessage -> relayMessage, vcard UTUH (yang dibaca WA)', () => {
    const vcard = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:AL', 'TEL;type=CELL;type=VOICE;waid=6287778032605:+6287778032605', 'END:VCARD'].join('\n');
    const wam = generateWAMessageFromContent('g@g.us',
      { contactMessage: { displayName: 'AL', vcard } }, { userJid: 'me@s.whatsapp.net' });
    assert.strictEqual(getContentType(wam.message), 'contactMessage');
    assert.strictEqual(normalizeMessageContent(wam.message).contactMessage.vcard, vcard);
  });

  await ok('C3. teks/gambar BIASA jangan ikut ke relayMessage (tetap jalur sendMessage)', () => {
    assert.strictEqual(isRawProto({ text: 'x' }), false);
    assert.strictEqual(isRawProto(toBaileysContent({ type: 'image', media: Buffer.from('x') })), false);
    assert.strictEqual(isRawProto({ react: { text: '🔥', key: {} } }), false);
  });

  console.log(`\nbaileys-send-paths: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
