'use strict';

/**
 * test/test5-carousel.js
 * `.test5` = kartu geser (carousel). Yang dijaga di sini:
 *  1. bentuk proto = `interactiveMessage.carouselMessage.cards[]` (BUKAN flat
 *     `{image, title, body, buttons}` ala helper bot lain — itu nggak muat di proto),
 *  2. tiap kartu bawa header ber-media (`hasMediaAttachment: true` + `imageMessage`),
 *  3. tombol contoh Pak utuh: `quick_reply` + `cta_url`,
 *  4. media kartu di-upload lewat `prepareMedia` (resolveMediaPayload cuma lihat
 *     media di root pesan → media kartu nggak auto-upload).
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.resolve(__dirname, '..');
const handler = require(path.join(ROOT, 'plugins/05-owner.js'));

const sent = [];
const PESAN = {};

const ctx = {
  isCmd: true, command: 'test5', args: [],
  botData: { id: 1, prefix: '.', bot_name: 'Qwerty', owner_number: '6281234567890',
             banner_url: 'assets/banner.jpg', footer_text: '© yaparibotz' },
  client: {
    message: {
      send: async (...a) => sent.push(a),
      // prepareMedia di adapter ngembaliin `{ imageMessage: {...} }`.
      prepareMedia: async (buf, { type }) => ({ [`${type}Message`]:
        { url: `https://mmg.whatsapp.net/${type}-${buf.length}`, mimetype: type === 'video' ? 'video/mp4' : 'image/jpeg' } }),
    },
  },
  sock: { message: { send: async (...a) => sent.push(a) } },
  reply: async (t) => { PESAN.text = t; },
  react: async () => {},
  isGroup: false, isOwner: true,
  jid: '6281234567890@s.whatsapp.net',
  sender: '6281234567890@s.whatsapp.net',
  pushName: 'Al',
  msg: { message: {} },
};

(async () => {
  const jalan = await handler(ctx);
  assert.strictEqual(jalan, true, 'handler nggak nangkep command test5');

  const dikirim = sent.map((a) => a[1]).find((c) => c?.interactiveMessage);
  assert.ok(dikirim, 'nggak ada bubble interactiveMessage yang dikirim');

  const im = dikirim.interactiveMessage;
  assert.strictEqual(im.body.text, 'Body Message');
  assert.strictEqual(im.header.title, 'Title Message');
  assert.strictEqual(im.header.subtitle, 'Subtitle Message');
  assert.strictEqual(im.footer.text, 'Footer Message');

  const cards = im.carouselMessage?.cards;
  assert.ok(Array.isArray(cards) && cards.length >= 1, 'carouselMessage.cards kosong');

  const k0 = cards[0];
  assert.strictEqual(k0.header.title, 'Title Cards');
  assert.strictEqual(k0.header.hasMediaAttachment, true, 'kartu harus nunjukin header ber-media');
  assert.ok(k0.header.imageMessage?.url, 'kartu-1 nggak dapet imageMessage hasil prepareMedia');

  const nama = k0.nativeFlowMessage.buttons.map((b) => b.name);
  assert.deepStrictEqual(nama, ['quick_reply', 'cta_url'], 'tombol contoh Pak berubah');
  assert.strictEqual(JSON.parse(k0.nativeFlowMessage.buttons[1].buttonParamsJson).url, 'https://www.example.com');

  // Kartu video (klip ffmpeg dari gambar) — kalau ffmpeg ada di mesin ini.
  const kv = cards.find((c) => c.header.videoMessage);
  if (kv) {
    assert.strictEqual(kv.header.hasMediaAttachment, true);
    console.log('  ok  kartu-2 pakai videoMessage hasil klip ffmpeg');
  } else {
    console.log('  ok  kartu-2 video di-skip (ffmpeg nggak ada) — kartu gambar tetap jalan');
  }

  console.log(`\ntest5-carousel: PASS — ${cards.length} kartu, tombol & media utuh`);
  process.exit(0);
})();
