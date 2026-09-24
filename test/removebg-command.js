'use strict';
/**
 * test/removebg-command.js
 * `.removebg` / `.rbg`: gambar dikirim ke endpoint YaPari `api/tools/removebg`
 * (mode `url`, jadi buffer WA di-upload dulu), hasilnya dikirim balik sebagai
 * DOKUMEN PNG — bukan image message, karena WA nge-JPEG ulang image → alpha rusak.
 *
 * Handler dijalankan beneran dengan ctx palsu; axios & engine/api di-stub biar
 * nggak nembak jaringan.
 */
const assert  = require('assert');
const path    = require('path');
const Module  = require('module');

const BE = path.join(__dirname, '..');

// ── Stub axios: cuma yang dipanggil handler (get removebg) ───────────────────
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(32)]);
const callAxios = [];
const axiosStub = {
  create: () => axiosStub,
  get: async (url, opts) => { callAxios.push({ url, opts }); return { status: 200, data: PNG }; },
  post: async () => ({ status: 200, data: {} }),
};

// ── Stub engine/api (upload + url/auth) biar nggak nembak API beneran ────────
const apiPath = require.resolve(path.join(BE, 'engine', 'api.js'));
const apiStub = {
  base: () => 'https://yapari.web.id',
  url: (p) => `https://yapari.web.id/${String(p).replace(/^\/+/, '')}`,
  auth: () => ({ 'X-API-Key': 'uji' }),
  upload: async (buf, filename, mime) => { apiStub._upload = { filename, mime, len: buf.length }; return 'https://d.uguu.se/uji.jpg'; },
  uploadInfo: async () => ({ url: 'https://d.uguu.se/uji.jpg' }),
  apiGet: async () => ({ data: {} }),
  apiPost: async () => ({ data: {} }),
};

const asli = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'axios') return axiosStub;
  const resolved = (() => { try { return Module._resolveFilename(req, parent); } catch { return null; } })();
  if (resolved === apiPath) return apiStub;
  return asli.apply(this, arguments);
};

const handler = require('../plugins/04-tools');
const { ALL_COMMANDS, CATS } = require('../plugins/01-info');
const { limitedCmds } = require('../plugins/04-tools');

// ── 1. Kecatat di menu + kena limit ─────────────────────────────────────────
assert.ok(ALL_COMMANDS.includes('removebg') && ALL_COMMANDS.includes('rbg'), '`removebg` & `rbg` harus ada di ALL_COMMANDS');
assert.ok(CATS.tools.includes('removebg') && CATS.tools.includes('rbg'), 'keduanya harus ada di kategori tools');
assert.ok(limitedCmds.has('removebg') && limitedCmds.has('rbg'), 'keduanya harus kena limit');
console.log('✓ 1. removebg + rbg kecatat di menu tools & kena limit');

// ── Harness ────────────────────────────────────────────────────────────────
const GAMBAR = Buffer.alloc(2048, 7);
const ctxGambar = (command, quoted) => {
  const kirim = [], balasan = [], reacts = [];
  const gambarMsg = { imageMessage: { mimetype: 'image/jpeg', mediaKey: Buffer.alloc(4).toString('base64'), fileSha256: '', fileEncSha256: '' } };
  return {
    kirim, balasan, reacts,
    ctx: {
      isCmd: true, isGroup: true, command, args: [],
      jid: '120363418054099388@g.us', sender: '6287778032605@s.whatsapp.net',
      botData: { prefix: '.', bot_number: '628123456789', owner_number: '6287778032605' },
      reply: async (t) => balasan.push(String(t)),
      react: async (e) => reacts.push(e),
      sock: {},
      msg: { message: quoted
        ? { extendedTextMessage: { contextInfo: { quotedMessage: gambarMsg } } }
        : gambarMsg },
      client: {
        message: {
          downloadBytes: async () => GAMBAR,
          send: async (jid, content) => { kirim.push(content); return {}; },
        },
      },
    },
  };
};

(async () => {
  // ── 2. Reply gambar → upload dulu, GET endpoint mode url, kirim DOKUMEN PNG ─
  for (const cmd of ['removebg', 'rbg']) {
    callAxios.length = 0;
    const h = ctxGambar(cmd, true);
    const handled = await handler(h.ctx);

    assert.strictEqual(handled, true, `.${cmd} harus ditangani plugin tools`);
    assert.ok(apiStub._upload, `.${cmd} harus upload buffer ke API dulu (mode url)`);
    assert.strictEqual(callAxios[0].url, 'https://yapari.web.id/api/tools/removebg', `.${cmd} harus nembak endpoint removebg`);
    assert.strictEqual(callAxios[0].opts.params.url, 'https://d.uguu.se/uji.jpg', `.${cmd} harus pakai URL hasil upload`);
    assert.strictEqual(callAxios[0].opts.headers['X-API-Key'], 'uji', `${cmd} harus kirim X-API-Key`);

    const out = h.kirim[0];
    assert.ok(out, `.${cmd} harus ngirim hasil`);
    assert.strictEqual(out.type, 'document', `.${cmd} harus kirim sebagai DOKUMEN (image message bikin alpha hilang)`);
    assert.strictEqual(out.mimetype, 'image/png', `.${cmd} mimetype harus image/png`);
    assert.ok(/\.png$/.test(out.fileName), `.${cmd} nama file harus .png, dapat: ${out.fileName}`);
    assert.ok(out.media.subarray(0, 4).equals(PNG.subarray(0, 4)), `.${cmd} isi harus PNG apa adanya`);
    assert.ok(h.reacts.includes('✅'), `.${cmd} harus react sukses tanpa ada reply error`);
    assert.strictEqual(h.balasan.length, 0, `.${cmd} sukses nggak boleh ada balasan error: ${h.balasan}`);
  }
  console.log('✓ 2. reply gambar -> upload -> GET ?url= -> dokumen PNG (removebg & rbg)');

  // ── 3. Tanpa gambar → kasih contoh pakai, jangan nembak API ────────────────
  const kosong = ctxGambar('removebg', false);
  kosong.ctx.msg = { conversation: '.removebg' };
  callAxios.length = 0;
  const handledKosong = await handler(kosong.ctx);
  assert.strictEqual(handledKosong, true, '.removebg tanpa gambar tetap harus ditangani (biar nggak jatuh ke plugin lain)');
  assert.ok(/Penggunaan|reply gambar/i.test(kosong.balasan.join(' ')), '.removebg tanpa gambar harus kasih contoh pakai');
  assert.strictEqual(kosong.kirim.length, 0, '.removebg tanpa gambar nggak boleh ngirim apa-apa');
  assert.strictEqual(callAxios.length, 0, '.removebg tanpa gambar nggak boleh nembak API');
  console.log('✓ 3. tanpa gambar -> pesan contoh pakai, API nggak dipanggil');

  console.log('\nSemua tes removebg lewat.');
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
