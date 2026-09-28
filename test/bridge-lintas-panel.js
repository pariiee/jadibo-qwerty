'use strict';
/**
 * Uji engine/bridge.js — jalur lintas panel (labs → engine zapo).
 *
 * Yang dibuktikan:
 *   1. rute /internal/op cuma melayani loopback + kunci yang benar
 *   2. relay nggak nimpa broadcast app sendiri — dua-duanya jalan
 *   3. event beneran nyampe ke /internal/engine-event panel labs
 *   4. panel labs mati → kirim event nggak melempar (proses aman)
 *
 * Semua lewat server palsu lokal, jadi nggak nyentuh DB/WhatsApp.
 */
const assert = require('assert');
const http = require('http');
const path = require('path');

const BRIDGE = path.join(__dirname, '..', 'engine', 'bridge.js');
process.env.INTERNAL_KEY = 'k'.repeat(32);

let gagal = 0, total = 0;
function ok(nama, fn) {
  total++;
  try { fn(); console.log('  ✓ ' + nama); }
  catch (e) { gagal++; console.log('  ✗ ' + nama + ' → ' + e.message); }
}
function muatUlang(envWebUrl) {
  process.env.ENGINE_WEB_URL = envWebUrl;
  delete require.cache[require.resolve(BRIDGE)];
  return require(BRIDGE);
}
function resPalsu() {
  const r = { kode: null, body: null };
  r.status = (k) => { r.kode = k; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
function reqPalsu({ ip = '127.0.0.1', key, body = {} } = {}) {
  return {
    socket: { remoteAddress: ip },
    body,
    get: (h) => (h.toLowerCase() === 'x-internal-key' ? key : undefined),
  };
}

(async () => {
  // ── Panel labs palsu ───────────────────────────────────────────────────────
  const terima = [];
  const palsu = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      terima.push({ url: req.url, key: req.headers['x-internal-key'], body: raw });
      res.writeHead(204).end();
    });
  });
  await new Promise((ok) => palsu.listen(0, '127.0.0.1', ok));
  const port = palsu.address().port;

  const bridge = muatUlang(`http://127.0.0.1:${port}`);

  // ── 1. Gerbang rute ────────────────────────────────────────────────────────
  ok('dari luar loopback → ditolak', () => {
    assert.strictEqual(bridge.dariLoopback(reqPalsu({ ip: '203.0.113.7' })), false);
  });
  ok('dari 127.0.0.1 / ::ffff:127.0.0.1 → lolos', () => {
    assert.strictEqual(bridge.dariLoopback(reqPalsu()), true);
    assert.strictEqual(bridge.dariLoopback(reqPalsu({ ip: '::ffff:127.0.0.1' })), true);
  });

  const resIp = resPalsu();
  await bridge.route(reqPalsu({ ip: '203.0.113.7', key: process.env.INTERNAL_KEY }), resIp);
  ok('rute dari IP luar → 403', () => assert.strictEqual(resIp.kode, 403));

  const res401 = resPalsu();
  await bridge.route(reqPalsu({ key: 'kunci-palsu' }), res401);
  ok('kunci salah → 401', () => assert.strictEqual(res401.kode, 401));

  // ── 2. Relay: lokal + panel labs, dua-duanya ───────────────────────────────
  const keLokal = [];
  const relay = bridge.pasangRelay((ev) => keLokal.push(ev));
  const ev = { botId: 4, type: 'log', payload: { message: 'halo' }, ts: 1 };
  relay(ev);
  ok('relay tetap kirim ke broadcast app sendiri', () => assert.strictEqual(keLokal.length, 1));
  await new Promise((r) => setTimeout(r, 300));
  ok('relay sekaligus teruskan ke panel labs', () => assert.strictEqual(terima.length, 1));
  ok('nyampe di /internal/engine-event', () => assert.strictEqual(terima[0].url, '/internal/engine-event'));
  ok('dibawa pakai header x-internal-key', () => assert.strictEqual(terima[0].key, process.env.INTERNAL_KEY));
  ok('bentuk event apa adanya (UI labs nggak perlu cabang)', () => {
    assert.deepStrictEqual(JSON.parse(terima[0].body), ev);
  });

  ok('broadcast app yang error nggak matiin relay', async () => {
    const relay2 = bridge.pasangRelay(() => { throw new Error('ws mati'); });
    relay2({ botId: 4, type: 'qr', payload: {} });
  });
  await new Promise((r) => setTimeout(r, 300));
  ok('event tetap keluar walau broadcast lokal error', () => assert.strictEqual(terima.length, 2));

  // ── 3. Panel labs mati → nggak melempar ───────────────────────────────────
  const bMati = muatUlang('http://127.0.0.1:1');
  ok('panel labs nggak bisa dihubungi → kirimEvent nggak throw', () => {
    bMati.kirimEvent({ botId: 4, type: 'log', payload: {} });
  });

  palsu.close();
  console.log('\n' + (gagal ? `✗ ${gagal} GAGAL` : `✓ semua lolos (${total}/${total})`));
  process.exit(gagal ? 1 : 0);
})();
