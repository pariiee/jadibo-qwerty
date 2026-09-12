'use strict';
/**
 * libcheck.js — self-check untuk engine/jid.js + engine/api.js
 * Jalankan: node libcheck.js
 *
 * upload() diuji ke HTTP server lokal yang meniru response YaPari,
 * jadi yang diuji kode ASLI-nya, bukan salinan.
 */

const http = require('http');
const assert = require('assert');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.log(`[FAIL] ${name}\n       ${e.message}`); fail++; }
};
const okAsync = async (name, fn) => {
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.log(`[FAIL] ${name}\n       ${e.message}`); fail++; }
};

// ─── engine/jid.js ────────────────────────────────────────────────────────────
const jid = require(path.resolve('engine/jid.js'));

ok('bare() buang @domain dan :device', () => {
  assert.strictEqual(jid.bare('628123456789:5@s.whatsapp.net'), '628123456789');
  assert.strictEqual(jid.bare('123456@lid'), '123456');
  assert.strictEqual(jid.bare(undefined), '');
});

ok('isLid / isPn bedain tipe', () => {
  assert.strictEqual(jid.isLid('123@lid'), true);
  assert.strictEqual(jid.isLid('123@s.whatsapp.net'), false);
  assert.strictEqual(jid.isPn('123@s.whatsapp.net'), true);
});

ok('toPn / toLid bersihin non-digit', () => {
  assert.strictEqual(jid.toPn('62812-3456'), '628123456@s.whatsapp.net');
  assert.strictEqual(jid.toLid('62812 3456'), '628123456@lid');
});

ok('cacheLidFromMeta isi cache dua arah', () => {
  jid.cacheLidFromMeta([{ jid: '999@lid', phoneNumber: '628999' }]);
  assert.strictEqual(jid.lidToPn('999@lid'), '628999@s.whatsapp.net');
  assert.strictEqual(jid.pnToLid('628999@s.whatsapp.net'), '999@lid');
});

ok('lidToPn lewat jid non-LID -> apa adanya (no-op)', () => {
  assert.strictEqual(jid.lidToPn('6281@s.whatsapp.net'), '6281@s.whatsapp.net');
});

ok('cache diabaikan kalau phoneNumber kosong', () => {
  jid.cacheLidFromMeta([{ jid: '888@lid' }]);
  assert.strictEqual(jid.lidToPn('888@lid'), '888@lid');
});

// Async fallback pakai client palsu (meniru stores.contacts zapo)
const fakeClient = {
  stores: {
    contacts: {
      getByJid: async (j) => (j === '777@lid' ? { jid: j, phoneNumber: '628777@s.whatsapp.net', lid: j } : null),
      getByPhoneNumber: async (pn) => (pn === '628666' ? { jid: '666@lid', lid: '666@lid', phoneNumber: '628666@s.whatsapp.net' } : null),
    },
  },
};

(async () => {
  await okAsync('lidToPnAsync: cache kosong -> store -> ketemu PN', async () => {
    assert.strictEqual(await jid.lidToPnAsync(fakeClient, '777@lid'), '628777@s.whatsapp.net');
    // sudah ke-cache -> panggilan kedua tidak perlu store lagi
    assert.strictEqual(jid.lidToPn('777@lid'), '628777@s.whatsapp.net');
  });

  await okAsync('pnToLidAsync: nomor -> LID', async () => {
    assert.strictEqual(await jid.pnToLidAsync(fakeClient, '628666@s.whatsapp.net'), '666@lid');
    assert.strictEqual(jid.pnToLid('628666@s.whatsapp.net'), '666@lid');
  });

  await okAsync('async tidak nemu / store error -> balikin input, tidak throw', async () => {
    assert.strictEqual(await jid.lidToPnAsync(fakeClient, '111@lid'), '111@lid');
    assert.strictEqual(await jid.lidToPnAsync({}, '222@lid'), '222@lid');
    assert.strictEqual(await jid.pnToLidAsync(null, '628000@s.whatsapp.net'), '628000@s.whatsapp.net');
  });

  // ─── engine/api.js ──────────────────────────────────────────────────────────
  const calls = [];
  let emptyMode = false; // kalau true, response tanpa URL -> upload() harus throw
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      calls.push({ url: req.url, key: req.headers['x-api-key'] });
      if (emptyMode) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, results: {} }));
      } else if (req.url === '/api/tools/upload') {
        // BENTUK ASLI v1: results.file_url, expires "24 jam"
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          results: { file_url: 'https://uguu.example/f.jpg', expires: '24 jam', size: 70, provider: 'uguu.se' },
        }));
      } else if (req.url === '/api/tools/upload-v2') {
        // BENTUK ASLI v2: `result` (bukan `results`), `url` (bukan `file_url`), expires "Permanen"
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          result: { url: 'https://top4top.example/v2.jpg', expires: 'Permanen', size: 70, provider: 'top4top.io' },
        }));
      } else if (req.url.startsWith('/api/tools/empty')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, results: {} }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, results: { echo: req.url } }));
      }
    });
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  process.env.BASE_API = `http://127.0.0.1:${port}/`; // sengaja pakai trailing slash
  process.env.KEY_API  = 'test-key';

  const api = require(path.resolve('engine/api.js'));

  ok('base() buang trailing slash', () => {
    assert.strictEqual(api.base(), `http://127.0.0.1:${port}`);
  });

  ok('upload() -> file_url + kirim X-API-Key', async () => {}); // placeholder, diuji async di bawah

  await okAsync('upload() v1 -> file_url dari results.*, expires "24 jam"', async () => {
    const url = await api.upload(Buffer.from('fakejpeg'), 'foto.jpg', 'image/jpeg');
    assert.strictEqual(url, 'https://uguu.example/f.jpg');
    const c = calls.find(x => x.url === '/api/tools/upload');
    assert.ok(c, 'endpoint upload tidak dipanggil');
    assert.strictEqual(c.key, 'test-key');
  });

  await okAsync('upload({v2:true}) -> BACA result.url (bukan results.file_url!) + expires Permanen', async () => {
    const info = await api.uploadInfo(Buffer.from('x'), 'a.jpg', 'image/jpeg', { v2: true, timeout: 5000 });
    assert.strictEqual(info.url, 'https://top4top.example/v2.jpg');
    assert.strictEqual(info.expires, 'Permanen');
    assert.strictEqual(info.provider, 'top4top.io');
    assert.ok(calls.some(x => x.url === '/api/tools/upload-v2'));
  });

  await okAsync('upload() throw kalau response tidak ada URL', async () => {
    emptyMode = true;
    await assert.rejects(
      () => api.upload(Buffer.from('x'), 'a.jpg', 'image/jpeg', { v2: true }),
      /Upload gagal/
    );
    emptyMode = false;
  });

  await okAsync('apiGet() nembak path + balikin data.results', async () => {
    const res = await api.apiGet('api/maker/brat', { params: { text: 'hi' } });
    assert.strictEqual(res.data.ok, true);
    assert.ok(calls.some(x => x.url.startsWith('/api/maker/brat')));
  });

  await okAsync('apiPost() kirim JSON', async () => {
    const res = await api.apiPost('api/tools/foo', { a: 1 });
    assert.strictEqual(res.data.ok, true);
  });

  server.close();
  console.log(`\n${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
