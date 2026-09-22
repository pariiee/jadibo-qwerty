'use strict';

/**
 * test/tt-photo-webp.js
 * Photo mode TikTok cuma nolak kasih `.webp` (CDN nolak varian .jpg/.jpeg = 403).
 * Baileys memetakan `image` → `image/jpeg` (MIMETYPE_MAP di Utils/messages.js),
 * jadi ImageMessage ber-mimetype `image/webp` terkirim tapi bubble-nya kosong:
 * user cuma lihat ✅ lalu sepi. Handler `.tt` wajib mengubahnya ke JPEG dulu.
 */

const assert = require('assert');
const path   = require('path');
const axios  = require('axios');

try { require('dotenv').config(); } catch { /* opsional */ }

const ROOT = path.resolve(__dirname, '..');
const sharp = require(path.join(ROOT, 'node_modules/sharp'));

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

const API_PHOTO = {
  data: {
    success: true,
    results: { type: 'photo', title: 'judul foto', author: { nickname: 'penulis' }, images: ['https://cdn.test/a.webp'] },
  },
};

const sent = [];
const mkCtx = () => ({
  isCmd: true, command: 'tt', args: ['https://vt.tiktok.com/ZSqEGMwFT/'],
  jid: '123@g.us', sender: '628111@s.whatsapp.net', isGroup: true,
  botData: { prefix: '.', footer_text: 'footer' },
  client: { message: { send: async (jid, c) => { sent.push(c); } } },
  reply: async (t) => { sent.push({ text: String(t) }); },
  react: async () => {},
});

(async () => {
  const handler = require(path.join(ROOT, 'plugins/04-tools.js'));
  const webp = await sharp({ create: { width: 200, height: 260, channels: 3, background: '#e91e63' } }).webp().toBuffer();
  const realGet = axios.get;
  const stub = (body, ct) => {
    axios.get = async (url) => String(url).includes('api/download/tiktok')
      ? API_PHOTO
      : { data: body, headers: { 'content-type': ct } };
  };

  await ok('photo TikTok (webp) → gambar terkirim sebagai JPEG', async () => {
    sent.length = 0; stub(webp, 'image/webp');
    const handled = await handler(mkCtx());
    assert.strictEqual(handled, true, 'handler harus return true');
    const img = sent.find(m => m.type === 'image');
    assert.ok(img, 'NGGAK ada gambar dikirim — ✅ muncul tapi output kosong');
    assert.strictEqual(img.mimetype, 'image/jpeg', `mimetype masih ${img.mimetype} → WA nggak nampilin bubble-nya`);
    assert.strictEqual(img.media.slice(0, 3).toString('hex'), 'ffd8ff', 'isi media bukan JPEG (magic bytes salah)');
    assert.ok(img.jpegThumbnail, 'jpegThumbnail nggak ada');
  });

  await ok('gambar sudah JPEG → nggak dikonversi ulang (byte utuh)', async () => {
    sent.length = 0;
    const jpg = await sharp(webp).jpeg().toBuffer();
    stub(jpg, 'image/jpeg');
    await handler(mkCtx());
    const img = sent.find(m => m.type === 'image');
    assert.ok(img, 'gambar nggak dikirim');
    assert.strictEqual(img.media.length, jpg.length, 'jpeg dikonversi ulang padahal sudah jpeg');
  });

  axios.get = realGet;
  console.log(`\ntt-photo-webp: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
