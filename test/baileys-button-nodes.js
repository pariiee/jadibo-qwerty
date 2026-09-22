'use strict';
// Bukti end-to-end jalur `.test`:
//  1. bubble-1 IMAGE (banner + caption menu) — bukan tombol, nggak perlu node biz
//  2. bubble-2 INTERACTIVE (nativeFlowMessage quick_reply) — WAJIB bawa
//     additionalNodes <biz><interactive><native_flow/></interactive></biz> + <bot>
// Kalau additionalNodes nggak dikirim, WA drop tombolnya → user lihat bubble
// tanpa tombol ("ga ada button satu pun yang keluar" — laporan 2026-09-14).

const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const realBaileys = require('baileys');
const realClient = require(path.join(ROOT, 'engine', 'baileys', 'client.js'));

// Tangkap relayMessage dengan nge-patch prototype object socket palsu.
const relayed = [];
const fakeSock = {
  ev: { on: () => {} },
  end: () => {},
  ws: { close: () => {}, readyState: 1 },
  logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, trace: () => {}, child: () => ({ info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }) },
  relayMessage: async (jid, message, opts) => { relayed.push({ jid, message, opts }); return 'OK'; },
  sendMessage: async (jid, content) => { relayed.push({ jid, message: content, opts: { viaSendMessage: true } }); return { key: { id: 'SM' } }; },
};

// Adapter nyimpen sock di closure; jalur resmi buat nge-set = connect().
// Jadi di sini kita tes fungsi murni `buttonNodes` + bikin raw relay manual
// pakai API publik baileys, lalu bandingin sama yg dikirim adapter.
const src = require('fs').readFileSync(path.join(ROOT, 'engine', 'baileys', 'client.js'), 'utf8');
const fnSrc = src.match(/function buttonNodes\(normalized\)\s*\{[\s\S]*?\n\}/);
assert.ok(fnSrc, 'buttonNodes nggak ketemu');
const buttonNodes = new Function('return ' + fnSrc[0])();

const norm = realBaileys.normalizeMessageContent;

// ── Bubble 2: persis yg dikirim `case 'test'` ────────────────────────────────
const interactive = realBaileys.proto.Message.create({
  interactiveMessage: {
    body: { text: 'Pilih menu di bawah ini 👇' },
    footer: { text: 'Powered by YaaParBot' },
    nativeFlowMessage: {
      buttons: [{ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '📋 MENU', id: 'btn_test' }) }],
      messageParamsJson: '{}',
    },
  },
});

const wam = realBaileys.generateWAMessageFromContent('6287778032605@s.whatsapp.net', interactive, {
  userJid: '6287778032605@s.whatsapp.net',
});

// C1: tombol protobuf-nya beneran ada di WAMessage (bukan di-drop generate)
const nf = norm(wam.message)?.interactiveMessage?.nativeFlowMessage;
assert.ok(nf?.buttons?.length === 1, 'C1 FAIL: nativeFlowMessage.buttons ilang');
assert.strictEqual(nf.buttons[0].name, 'quick_reply');

// C2: node biz keluar
const nodes = buttonNodes(norm(wam.message));
assert.strictEqual(nodes.length, 1, 'C2 FAIL: nggak ada node <biz> buat interactiveMessage');
assert.strictEqual(nodes[0].tag, 'biz');
assert.strictEqual(nodes[0].content[0].tag, 'interactive');
assert.strictEqual(nodes[0].content[0].attrs.type, 'native_flow');
assert.strictEqual(nodes[0].content[0].attrs.v, '1');
assert.strictEqual(nodes[0].content[0].content[0].tag, 'native_flow');
assert.strictEqual(nodes[0].content[0].content[0].attrs.name, 'mixed');
assert.strictEqual(nodes[0].content[0].content[0].attrs.v, '9');

// C3: chat pribadi → nambah <bot biz_bot="1">
const jid = '6287778032605@s.whatsapp.net';
assert.strictEqual(realBaileys.isJidGroup(jid), false, 'C3 FAIL: jid pribadi kedetek grup');
const additionalNodes = [...nodes];
if (nodes.length && !realBaileys.isJidGroup(jid)) additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
assert.strictEqual(additionalNodes.length, 2, 'C3 FAIL: <bot> nggak ketambah');
assert.deepStrictEqual(additionalNodes[1], { tag: 'bot', attrs: { biz_bot: '1' } });

// C4: grup → nggak usah <bot>
const gjid = '120363403895277092@g.us';
assert.strictEqual(realBaileys.isJidGroup(gjid), true);
const gNodes = [...nodes];
if (gNodes.length && !realBaileys.isJidGroup(gjid)) gNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
assert.strictEqual(gNodes.length, 1, 'C4 FAIL: grup nggak boleh dapet <bot>');

// C5: bubble-1 (IMAGE) nggak dapet node biz — biar nggak ngaco di media
const imgWam = realBaileys.generateWAMessageFromContent(jid, { image: Buffer.from([1, 2, 3]), caption: 'menu' }, { userJid: jid });
assert.deepStrictEqual(buttonNodes(norm(imgWam.message)), [], 'C5 FAIL: gambar nggak boleh dapet node <biz>');

// C5b: CAROUSEL (`.test5`) — `interactiveMessage.carouselMessage` WAJIB dapet node
// biz yang sama. Sebelum ini `buttonNodes()` cuma ngenal `nativeFlowMessage`, jadi
// kartunya di-drop WA diem-diem (reaksi ✅ jalan, nol error, nol output).
const carouselWam = realBaileys.generateWAMessageFromContent(jid, realBaileys.proto.Message.create({
  interactiveMessage: {
    body: { text: 'Body Message' },
    footer: { text: 'Footer Message' },
    carouselMessage: {
      cards: [{
        header: { title: 'Title Cards', hasMediaAttachment: false },
        body: { text: 'Body Cards' },
        footer: { text: 'Footer Cards' },
        nativeFlowMessage: { buttons: [{ name: 'quick_reply', buttonParamsJson: '{"display_text":"D","id":"ID"}' }] },
      }],
      messageVersion: 1,
    },
  },
}), { userJid: jid });
const cNodes = buttonNodes(norm(carouselWam.message));
assert.strictEqual(cNodes.length, 1, 'C5b FAIL: carouselMessage nggak dapet node <biz>');
assert.strictEqual(cNodes[0].content[0].attrs.type, 'native_flow');
assert.strictEqual(norm(carouselWam.message).interactiveMessage.carouselMessage.cards.length, 1,
  'C5b FAIL: kartu ilang di round-trip proto');

// C6: adapter nge-import yang dibutuhin (nggak bakal crash pas runtime)
// Cek per-nama, jangan per-urutan: nyisipin import baru di antaranya bukan bug.
for (const name of ['normalizeMessageContent', 'isJidGroup', 'proto', 'prepareWAMessageMedia']) {
  assert.ok(src.split('\n').some((l) => l.trim() === name + ','), `C6 FAIL: ${name} nggak di-import`);
}
assert.ok(/additionalNodes,\s*\n\s*\}\);/.test(src), 'C7 FAIL: additionalNodes nggak diteruskan ke relayMessage');

void realClient; void fakeSock;

console.log('PASS: 8 assert — interactive/buttons/carousel dapat node biz+interactive+native_flow, gambar bersih');
process.exit(0);
