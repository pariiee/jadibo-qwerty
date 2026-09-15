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
const { toBaileysContent, isRawProto, attachMentions, rememberSent, lookupSent } = require('../engine/baileys/client');
const { mentionsForChat, cacheLidFromMeta, cacheLidFromKey, needsLidResolve, lidToPn, pnToLid, lidToPnAsync, pnToLidAsync } = require('../engine/jid');

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

  await ok('A7. mentions HARUS nempel di konten — opsi diabaikan Baileys', async () => {
    // jalur adapter: toBaileysContent + attachMentions (yang dipakai send())
    const res = await generateWAMessageContent(
      attachMentions(toBaileysContent({ text: 'halo @628' }), ['628@s.whatsapp.net']), mkOpts());
    assert.deepStrictEqual(
      normalizeMessageContent(res).extendedTextMessage.contextInfo.mentionedJid, ['628@s.whatsapp.net']);

    // bukti kenapa harus di konten: lewat opsi, mentionedJid nggak kebentuk
    const viaOpts = await generateWAMessageContent(toBaileysContent({ text: 'halo @628' }),
      { ...mkOpts(), mentions: ['628@s.whatsapp.net'] });
    assert.strictEqual(normalizeMessageContent(viaOpts).extendedTextMessage.contextInfo, undefined);
  });

  await ok('A6. grup LID: mentionedJid ikut nyertain bentuk LID-nya', () => {
    cacheLidFromMeta([{ jid: '111222333@lid', phoneNumber: '6287778032605' }]);
    assert.deepStrictEqual(
      mentionsForChat('120363418054099388@g.us', ['6287778032605@s.whatsapp.net']),
      ['6287778032605@s.whatsapp.net', '111222333@lid']
    );
    // non-grup / nggak ada mapping -> apa adanya
    assert.deepStrictEqual(mentionsForChat('628@s.whatsapp.net', ['6287778032605@s.whatsapp.net']),
      ['6287778032605@s.whatsapp.net']);
    assert.deepStrictEqual(mentionsForChat('x@g.us', ['628999@s.whatsapp.net']), ['628999@s.whatsapp.net']);
  });

  await ok('A10. retry receipt dijawab: getMessage nemu pesan yg kita kirim', () => {
    // Penerima minta kirim ulang -> Baileys panggil getMessage({...key, id}).
    // Kalau undefined, permintaannya di-drop senyap: log "terkirim" tapi HP
    // penerima kosong.
    assert.strictEqual(lookupSent({ id: 'nggak-ada' }), undefined);
    const wam = { key: { id: 'MSG1', remoteJid: '628111@s.whatsapp.net' }, message: { conversation: 'halo' } };
    rememberSent(wam);
    assert.deepStrictEqual(lookupSent({ id: 'MSG1', remoteJid: '135468066799657@lid' }), { conversation: 'halo' });
    // pesan tanpa isi / tanpa id jangan bikin map kotor
    rememberSent({ key: { id: 'MSG2' } });
    assert.strictEqual(lookupSent({ id: 'MSG2' }), undefined);
    // batas 300: yg paling tua kebuang, yg terbaru tetep ada
    for (let i = 0; i < 350; i++) rememberSent({ key: { id: 'B' + i }, message: { conversation: 'x' } });
    assert.strictEqual(lookupSent({ id: 'B349' }) !== undefined, true);
    assert.strictEqual(lookupSent({ id: 'B0' }), undefined);
  });

  await ok('A9. key pesan bawa PN -> LID ke-map di pesan PERTAMA (tanpa metadata)', () => {
    // Baileys v7 naruh PN di key: participantAlt/remoteJidAlt (messages-recv ~1277).
    // Ini yang bikin pesan pertama setelah restart nggak lagi butuh metadata grup.
    const key = { remoteJid: '120363418054099388@g.us', participant: '999888777@lid',
                  participantAlt: '628111222333@s.whatsapp.net' };
    assert.strictEqual(lidToPn('999888777@lid'), '999888777@lid'); // sebelum: mentah
    cacheLidFromKey(key);
    assert.strictEqual(lidToPn('999888777@lid'), '628111222333@s.whatsapp.net');
    assert.strictEqual(pnToLid('628111222333@s.whatsapp.net'), '999888777@lid');
    // grup LID -> PN: remoteJidAlt nunjuk grup, jangan sampai kepasang jadi "nomor"
    cacheLidFromKey({ remoteJid: '120363418054099388@g.us', remoteJidAlt: '120363418054099388@g.us' });
    assert.strictEqual(lidToPn('120363418054099388@g.us'), '120363418054099388@g.us');
    // DM LID -> PN
    cacheLidFromKey({ remoteJid: '555444333@lid', remoteJidAlt: '628999888777@s.whatsapp.net' });
    assert.strictEqual(lidToPn('555444333@lid'), '628999888777@s.whatsapp.net');
    // tanpa alt -> jangan ngarang
    cacheLidFromKey({ remoteJid: '628000111222@s.whatsapp.net' });
    assert.strictEqual(lidToPn('628000111222@s.whatsapp.net'), '628000111222@s.whatsapp.net');
    // suffix device (`628xx:0@...`) wajib dibuang — kalau ikut, `.kick` nampilin
    // "628xx:0" dan perbandingan nomor owner meleset.
    cacheLidFromKey({ remoteJid: '777666555@lid', remoteJidAlt: '628123456789:0@s.whatsapp.net' });
    assert.strictEqual(lidToPn('777666555@lid'), '628123456789@s.whatsapp.net');
  });

  await ok('A11. fallback peta LID bawaan Baileys (persist) juga dinormalisasi', async () => {
    // Baileys getPNForLID() balikin `628xx:0@s.whatsapp.net`.
    // LID yg belum ke-cache sama test di atas (kalau udah ke-cache, fallback nggak kepanggil)
    const fake = { lid: { getPn: async () => '628555666777:0@s.whatsapp.net',
                         getLid: async () => '555000111@lid' } };
    assert.strictEqual(await lidToPnAsync(fake, '555000111@lid'), '628555666777@s.whatsapp.net');
    assert.strictEqual(lidToPn('555000111@lid'), '628555666777@s.whatsapp.net');
    assert.strictEqual(await pnToLidAsync(fake, '628555666777@s.whatsapp.net'), '555000111@lid');
    assert.strictEqual(pnToLid('628555666777:0@s.whatsapp.net'), '555000111@lid');
  });

  await ok('A8. LID belum ke-map -> engine wajib baca metadata dulu', () => {
    // Jaring pengaman terakhir kalau key nggak bawa alt (peta belum keisi).
    // Kalau metadata nggak dibaca, sender/mention tetap LID -> isOwner meleset
    // (command owner diem) + @mention jadi teks polos.
    assert.strictEqual(needsLidResolve({ sender: '135468066799657@lid' }), true);
    assert.strictEqual(needsLidResolve({
      sender: '6287778032605@s.whatsapp.net', mentioned: ['135468066799657@lid'] }), true);
    assert.strictEqual(needsLidResolve({
      sender: '6287778032605@s.whatsapp.net', mentioned: ['6287711105760@s.whatsapp.net'] }), false);
    assert.strictEqual(needsLidResolve({}), false);
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
