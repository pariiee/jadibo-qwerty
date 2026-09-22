'use strict';
// Web dan bot sekarang dua proses. Yang diuji:
//   1) web beneran nggak nyentuh engine lagi (kalau iya, restart web = bot putus),
//   2) jalur perintahnya beneran jalan + nolak kunci yang salah + bilang apa
//      adanya kalau worker mati (bukan diem-diem sukses),
//   3) CSP nggak lagi butuh 'unsafe-inline' dan nggak ada handler inline ketinggalan.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const dir = path.join(__dirname, '..');
const baca = (p) => fs.readFileSync(path.join(dir, p), 'utf8');

// ── 1. Batas proses ─────────────────────────────────────────────────────────
const srv = baca('server.js');
assert.ok(!/require\('\.\/engine\//.test(srv),
  'server.js masih require engine — restart web bakal mutus bot');
assert.ok(!/new Map\(\)/.test(baca('controllers/botController.js')),
  'botController masih nyimpen state bot di memori proses web');
const rt = baca('engine/runtime.js');
for (const nama of ['activeBots', 'activeGroupsPerBot', 'activeChannelsPerBot']) {
  assert.ok(rt.includes(nama), 'engine/runtime.js harus punya ' + nama);
}
assert.ok(!/controllers\/botController/.test(baca('engine/whatsappEngine.js')),
  'whatsappEngine masih ambil state dari controller web');

const worker = baca('workers/botWorker.js');
assert.ok(/server\.listen\(PORT, '127\.0\.0\.1'/.test(worker),
  'worker harus dengerin 127.0.0.1 doang, jangan kebuka ke luar');
assert.ok(/x-internal-key/.test(srv) && /x-internal-key/.test(worker),
  'jalur internal harus dicek kuncinya dua arah');
assert.ok(/app\.post\('\/internal\/engine-event'/.test(srv),
  'web harus punya pintu buat event dari worker');

// ── 2. CSRF ─────────────────────────────────────────────────────────────────
assert.ok(/new URL\(asal\)\.host/.test(srv) && /req\.get\('origin'\)/.test(srv),
  'web harus nolak POST yang Origin-nya bukan host sendiri');

// ── 3. CSP ──────────────────────────────────────────────────────────────────
assert.ok(!/'unsafe-inline'/.test(srv.split('scriptSrc')[1].split(']')[0]),
  "scriptSrc masih 'unsafe-inline'");
assert.ok(!/scriptSrcAttr/.test(srv), 'scriptSrcAttr harus hilang bareng handler inline');
const html = ['public/index.html', 'public/dashboard.html', 'public/bot-detail.html',
  'public/partials/head.html', 'public/partials/nav.html', 'public/partials/sidebar.html',
  'public/partials/topbar.html', 'public/partials/footer.html'].map(baca).join('\n');
const sisa = html.match(/\son[a-z]+\s*=\s*["']/g) || [];
assert.deepStrictEqual(sisa, [], 'masih ada handler inline: ' + sisa.join(', '));
assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html),
  'masih ada <script> inline di halaman');

// ── 4. Jalur perintah web → worker (kontrak HTTP-nya, worker palsu) ──────────
process.env.WORKER_PORT = '3098';
process.env.INTERNAL_KEY = 'kunci-uji';
const bus = require('../config/engineBus');

const diterima = [];
const palsu = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    if (req.headers['x-internal-key'] !== 'kunci-uji') { res.writeHead(401).end(); return; }
    const body = JSON.parse(raw);
    diterima.push(body);
    res.writeHead(200, { 'content-type': 'application/json' })
       .end(JSON.stringify(body.op === 'stop'
         ? { ok: false, status: 400, message: 'Bot tidak sedang berjalan' }
         : { ok: true, ids: [7], message: 'Bot sedang dimulai' }));
  });
});

(async () => {
  await new Promise((ok) => palsu.listen(3098, '127.0.0.1', ok));

  const out = await bus.start(7, true);
  assert.strictEqual(out.message, 'Bot sedang dimulai');
  assert.deepStrictEqual(diterima[0], { op: 'start', botId: 7, args: { usePairing: true } },
    'perintah start harus sampai apa adanya ke worker');

  // Cermin "bot jalan" udah dihapus total: nggak ada pemakai produksi, jadi
  // ngerawatnya cuma ngasih beban tiap 10 detik. jangan balik lagi.
  for (const nama of ['isRunning', 'runningIds', 'sinkron', '_jalan']) {
    assert.ok(!bus[nama] && !baca('config/engineBus.js').includes('_jalan ='),
      `engineBus masih punya ${nama} — cermin itu udah nggak dipakai siapa-siapa`);
  }
  assert.ok(!/cron\.schedule\('\/10 \* \* \* \* \*'[\s\S]{0,400}sinkron/.test(srv),
    'cron 10 detik masih nyentuh sinkron — polling balik lagi');

  // Worker nolak → pesannya diteruskan, status-nya ikut (400 bukan 500).
  await assert.rejects(() => bus.stop(7), (e) => e.status === 400 && /tidak sedang berjalan/.test(e.message));

  await new Promise((ok) => palsu.close(ok));
  // Worker mati → harus bilang apa adanya, bukan diem-diem "sukses".
  await assert.rejects(() => bus.start(7, false),
    (e) => e.status === 503 && /Proses bot sedang tidak jalan/.test(e.message));

  console.log('pisah-proses OK');
})().catch((e) => { console.error(e); process.exit(1); });
