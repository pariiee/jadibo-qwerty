// .swgc — status grup nggak jadi. Dua hal yang DIKUNCI di sini:
//
//  1. Envelope kita harus byte-identik dgn `groupStatus()` di
//     refrensi-botz/plugins/owner-upswtag.js. Kalau ini lewat, bentuk proto
//     BUKAN tersangkanya — jangan kejar-kejar bentuk proto lagi.
//  2. `relayStatusGrup` WAJIB kejangkau dari `client.message.send(jid, c,
//     { statusGrup: true })`. Dulu cek `statusGrup` ditaruh SETELAH
//     `isRawProto(content)` — padahal .swgc ngirim proto MENTAH dari
//     prepareMedia(), jadi malah nyasar ke sendRaw() = media BIASA, bukan
//     status. Di VPS ini TypeError (`relayStatusGrup` belum diekspor), cuma
//     kelihatan sebagai "❌ Gagal kirim status grup" karena ketelen catch.
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');
const baileys = require('baileys');
const { proto, generateWAMessageContent, generateWAMessageFromContent } = baileys;
const { groupStatusContent, createClient } = require('../engine/baileys/client');

const JID = '120363418054099388@g.us';
const VIDEO = { video: Buffer.alloc(2048, 7), mimetype: 'video/mp4', caption: 'test' };
const TEKS = { text: 'test' };

let gagal = 0;
const ok = (nama, fn) => {
  try { fn(); console.log(`  PASS  ${nama}`); }
  catch (e) { gagal++; console.log(`  FAIL  ${nama}\n        ${e.message}`); }
};

// Buffer -> hex, messageSecret -> <SECRET>: nilainya acak by design.
const norm = (o) => {
  if (Buffer.isBuffer(o)) return `<B${o.length}>`;
  if (Array.isArray(o)) return o.map(norm);
  if (o && typeof o === 'object') {
    const r = {};
    for (const k of Object.keys(o)) r[k] = k === 'messageSecret' ? '<SECRET>' : norm(o[k]);
    return r;
  }
  return o;
};

(async () => {
  // ── 1. Envelope kita == envelope referensi ────────────────────────────────
  for (const [nama, konten] of [['video', VIDEO], ['teks', TEKS]]) {
    const upload = async () => ({ url: 'https://mmg.whatsapp.net/x.enc', directPath: '/x' });
    const inside = await generateWAMessageContent(konten, { upload });
    const secret = nodeCrypto.randomBytes(32);
    const ref = generateWAMessageFromContent(JID, {
      messageContextInfo: { messageSecret: secret },
      groupStatusMessageV2: { message: { ...inside, messageContextInfo: { messageSecret: secret } } },
    }, {});
    const kita = generateWAMessageFromContent(
      JID, proto.Message.create(await groupStatusContent(konten, upload)), {},
    );
    const dec = (w) => proto.Message.decode(proto.Message.encode(w.message).finish());

    ok(`${nama}: envelope byte-identik dgn referensi`, () =>
      assert.strictEqual(JSON.stringify(norm(dec(kita))), JSON.stringify(norm(dec(ref)))));

    // round-trip encode/decode: inti keluhan "masih text" — kalau kontennya
    // udah nggak ada setelah serialize, WA cuma bisa nampilin teks.
    const dalam = dec(kita).groupStatusMessageV2?.message;
    ok(`${nama}: konten masih ada setelah round-trip`, () =>
      assert.ok(dalam?.videoMessage || dalam?.extendedTextMessage));
    ok(`${nama}: messageSecret 32 byte di luar + di dalam`, () => {
      assert.strictEqual(dec(kita).messageContextInfo?.messageSecret?.length, 32);
      assert.strictEqual(dalam?.messageContextInfo?.messageSecret?.length, 32);
    });
  }

  // ── 2. Jalur kirim: opts.statusGrup harus menang atas isRawProto ──────────
  const auth = { creds: baileys.initAuthCreds(), keys: { get: async () => ({}), set: async () => {} } };
  const silent = { level: 'silent', child: () => silent, info(){}, warn(){}, error(){}, debug(){}, trace(){} };
  const c = createClient({ auth, saveCreds: () => {}, logger: silent });

  ok('adapter mengekspor message.relayStatusGrup', () =>
    assert.strictEqual(typeof c.message.relayStatusGrup, 'function'));

  // Pasang socket palsu. Yang dicek BUKAN "relayMessage kepanggil" — sendRaw()
  // juga manggil itu. Yang dicek: yang direlay itu ENVELOPE STATUS GRUP
  // (ada groupStatusMessageV2), bukan videoMessage polos.
  const relayed = [];
  c.__setSockUntukTes({
    waUploadToServer: async () => ({ url: 'x', directPath: '/x' }),
    logger: silent,
    relayMessage: async (jid, message) => { relayed.push(message); },
    sendMessage: async () => { throw new Error('nyasar ke sendMessage'); },
    readMessages: () => {},
  });
  const wam = await c.message.send(JID, { videoMessage: { url: 'https://x/y', mimetype: 'video/mp4', mediaKey: Buffer.alloc(32, 1) } }, { statusGrup: true });
  ok('proto MENTAH + statusGrup -> yg direlay envelope status grup', () => {
    assert.strictEqual(relayed.length, 1, `relay dipanggil ${relayed.length}×`);
    assert.ok(relayed[0].groupStatusMessageV2, 'bukan envelope status grup');
  });
  ok('balikin WAMessage dgn key.id', () => assert.ok(wam.key.id));

  // ── 3. Media yang di-reply: string base64 -> Buffer ───────────────────────
  // `contextInfo.quotedMessage` bisa dateng sebagai string base64. Baileys
  // nolak itu di downloadMediaMessage, dan gagalnya nggak kebaca — gejalanya
  // cuma "media nggak ikut", bukan error. Perbaikannya di downloadBytes().
  const { perbaikiBufferMedia } = require('../engine/baileys/client');
  ok('base64 di quotedMessage -> Buffer', () => {
    const b64 = Buffer.alloc(32, 9).toString('base64');
    const quoted = {
      imageMessage: { mimetype: 'image/jpeg', mediaKey: b64, fileSha256: b64, fileEncSha256: b64 },
      contextInfo: { stanzaId: 'x' }, // bukan media — jangan disentuh
    };
    perbaikiBufferMedia(quoted);
    assert.ok(Buffer.isBuffer(quoted.imageMessage.mediaKey));
    assert.strictEqual(quoted.imageMessage.mediaKey.length, 32);
    assert.ok(Buffer.isBuffer(quoted.imageMessage.fileSha256));
    assert.deepStrictEqual(quoted.contextInfo, { stanzaId: 'x' });
  });
  ok('Buffer yg udah bener dibiarin apa adanya', () => {
    const buf = Buffer.alloc(32, 1);
    const m = { videoMessage: { mediaKey: buf, fileSha256: buf, fileEncSha256: buf } };
    perbaikiBufferMedia(m);
    assert.strictEqual(m.videoMessage.mediaKey, buf);
  });

  console.log(gagal ? `\nswgc-status: ${gagal} FAIL` : '\nswgc-status: semua PASS');
  process.exit(gagal ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
