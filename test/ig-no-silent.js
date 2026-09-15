'use strict';

/**
 * test/ig-no-silent.js
 * `.ig` TIDAK BOLEH "centang tapi sepi". Kalau unduhan media dari CDN Instagram
 * gagal (403/timeout), user WAJIB dapat pesan ❌ berisi alasannya — bukan diam.
 * Dulu `catch { continue; }` di loop unduh bikin media ilang tanpa jejak.
 */

const assert = require('assert');
const path   = require('path');
const axios  = require('axios');

try { require('dotenv').config(); } catch { /* opsional */ }

const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

const API_OK = { data: { success: true, results: { type: 'video', video: { sd: 'https://cdn.test/x.mp4' } } } };

// Stub axios SEBELUM plugin di-require. Plugin manggil `require('axios')` di dalam
// handler → instance yang sama dari cache node_modules, jadi stub-nya kepakai.
const realGet = axios.get;
const stub = (unduhGagal) => {
  axios.get = async (url) => {
    if (String(url).includes('api/download/instagram')) return API_OK;
    if (unduhGagal) {
      const e = new Error('Request failed with status code 403');
      e.response = { status: 403 };
      throw e;
    }
    return { data: Buffer.from('video'), headers: { 'content-type': 'video/mp4' } };
  };
};

const sent = [];
const mkCtx = () => ({
  isCmd: true, command: 'ig', args: ['https://www.instagram.com/reel/abc/'],
  jid: '123@g.us', sender: '628111@s.whatsapp.net', isGroup: true,
  botData: { prefix: '.', footer_text: 'footer' },
  client: { message: { send: async (jid, c) => { sent.push(c); } } },
  reply: async (t) => { sent.push({ text: String(t) }); },
  react: async () => {},
});

(async () => {
  const handler = require(path.join(ROOT, 'plugins/04-tools.js'));

  await ok('unduhan gagal (403) → user dikasih ❌ + alasannya', async () => {
    sent.length = 0; stub(true);
    const handled = await handler(mkCtx());
    assert.strictEqual(handled, true, 'handler harus return true');
    const err = sent.find(m => m.text?.includes('Gagal Instagram'));
    assert.ok(err, 'nggak ada pesan ❌ Gagal Instagram — handler diam');
    assert.ok(err.text.includes('403'), `alasan gagal nggak dilaporin: ${err.text}`);
  });

  await ok('unduhan sukses → video dikirim ke grup, tanpa pesan ❌', async () => {
    sent.length = 0; stub(false);
    await handler(mkCtx());
    assert.ok(sent.some(m => m.type === 'video'), 'video nggak dikirim');
    assert.ok(!sent.some(m => m.text?.includes('Gagal Instagram')), 'harusnya nggak ada error');
  });

  await ok('connect gagal SEKALI (ETIMEDOUT) → diulang, bukan langsung nyerah', async () => {
    sent.length = 0;
    let attempts = 0;
    axios.get = async (url) => {
      if (String(url).includes('api/download/instagram')) return API_OK;
      attempts++;
      if (attempts === 1) { const e = new Error('connect ETIMEDOUT 57.144.100.192:443'); e.code = 'ETIMEDOUT'; throw e; }
      return { data: Buffer.from('video'), headers: { 'content-type': 'video/mp4' } };
    };
    await handler(mkCtx());
    assert.ok(attempts >= 2, `nggak diulang (attempts=${attempts})`);
    assert.ok(sent.some(m => m.type === 'video'), 'video nggak dikirim padahal retry harusnya berhasil');
  });

  axios.get = realGet;
  console.log(`\nig-no-silent: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
