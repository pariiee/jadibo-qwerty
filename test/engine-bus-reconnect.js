'use strict';
/**
 * test/engine-bus-reconnect.js — event worker→web harus selamat kalau web mati.
 *
 * Bug yang dijaga: worker boot waktu web belum listen → semua event masuk buffer
 * dan `_siap` nggak pernah jadi true kalau flush() dipanggil di urutan yang salah.
 * Efeknya log/status/QR bot hilang permanen sampai worker di-restart manual.
 *
 * Sekalian: cermin "bot jalan" (`_jalan`) + polling 10 detik udah dihapus karena
 * nggak ada pemakai produksi. Dijaga di sini biar nggak balik lagi.
 *
 * fetch distub, bukan server HTTP beneran: yang diuji urutan buffer/flush, bukan
 * TCP-nya. Stub = nggak ada socket, tes nggak bisa flaky.
 */
const fs   = require('fs');
const path = require('path');

const dir  = path.join(__dirname, '..');
const baca = (p) => fs.readFileSync(path.join(dir, p), 'utf8');
const src  = baca('workers/botWorker.js');

// Ambil fungsi apa adanya dari sumber (bukan disalin) supaya tes ikut gagal kalau
// isinya berubah — bukan cuma kalau namanya hilang.
function ambil(nama) {
  const i = src.indexOf(`async function ${nama}(`);
  if (i < 0) throw new Error(`nggak nemu ${nama}() di botWorker.js`);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
  }
}

// `webMati` = true bikin fetch nolak, persis kayak web belum listen.
function jalankan() {
  const terkirim = [];
  let webMati = true;
  const fetchPalsu = async (url, opt) => {
    if (webMati) throw new Error('ECONNREFUSED');
    terkirim.push(JSON.parse(opt.body));
    return { ok: true };
  };
  const api = new Function(
    'fetch', 'WEB_PORT', 'KUNCI', 'setInterval',
    `const _buffer = []; let _siap = false;
     ${['post', 'kirimEvent', 'flush'].map(ambil).join('\n')}
     return { kirimEvent, flush, siap: () => _siap, buffer: () => _buffer.length };`
  )(fetchPalsu, 3000, 'kunci-tes', () => ({ unref() {} }));
  return { ...api, terkirim, hidupkanWeb: () => { webMati = false; } };
}

(async () => {
  // 1. Web mati → event ditahan, bukan dibuang, dan nggak nembak request.
  const w = jalankan();
  await w.kirimEvent({ type: 'log', payload: { level: 'info', message: 'bot mulai' } });
  await w.kirimEvent({ type: 'status', payload: { status: 'connected' } });
  if (w.siap()) throw new Error('GAGAL: worker ngerasa tersambung padahal web belum nyala');
  if (w.buffer() !== 2) throw new Error(`GAGAL: buffer harus 2, dapat ${w.buffer()}`);
  if (w.terkirim.length) throw new Error('GAGAL: ada yang kekirim padahal web mati');
  console.log('  ok   web mati → event ditahan di buffer, nggak dibuang');

  // 2. Web balik → flush() nge-ping dulu, terus nguras buffer APA ADANYA + urut.
  w.hidupkanWeb();
  await w.flush();
  if (!w.siap()) throw new Error('GAGAL: flush() sukses tapi _siap nggak jadi true');
  if (w.buffer() !== 0) throw new Error('GAGAL: buffer belum kekuras habis');
  const tipe = w.terkirim.map((e) => e.type);
  if (tipe[0] !== 'ping') throw new Error(`GAGAL: yang pertama harus ping, dapat ${tipe[0]}`);
  if (JSON.stringify(tipe.slice(1)) !== '["log","status"]') {
    throw new Error(`GAGAL: event harus kekirim urut & utuh, dapat ${JSON.stringify(tipe)}`);
  }
  console.log(`  ok   web balik → buffer dikuras urut: ${JSON.stringify(tipe)}`);

  // 3. Sesudah nyambung, event langsung lewat — nggak numpuk di buffer.
  await w.kirimEvent({ type: 'qr', payload: { qr: 'x' } });
  if (w.buffer() !== 0) throw new Error('GAGAL: event nyangkut di buffer padahal udah nyambung');
  console.log('  ok   sesudah nyambung, event lewat langsung');

  // 4. flush() di boot() HARUS setelah auto-start, biar event auto-start ikut kebawa.
  if (src.indexOf('await flush();') < src.indexOf('auto-start')) {
    throw new Error('GAGAL: flush() dipanggil SEBELUM auto-start — event auto-start nyangkut');
  }
  console.log('  ok   flush() di boot() jalan setelah auto-start bot');

  // 5. Web restart sendiri → harus ada penyambung ulang, dan diam saat sehat.
  if (!/setInterval\(\(\) => \{ if \(!_siap\) flush\(\); \}, 3000\)\.unref\(\)/.test(src)) {
    throw new Error('GAGAL: nggak ada retry flush() — web restart = event ilang selamanya');
  }
  console.log('  ok   ada retry flush() tiap 3 detik selagi web belum tersambung');

  // 6. Cermin "bot jalan" + polling-nya udah dihapus — jangan balik lagi.
  const busSrc = baca('config/engineBus.js');
  for (const sisa of ['_jalan', 'isRunning', 'runningIds', 'sinkron']) {
    if (busSrc.includes(sisa)) throw new Error(`GAGAL: ${sisa} balik lagi di engineBus.js`);
  }
  const webSrc = baca('server.js');
  const iCron  = webSrc.indexOf("cron.schedule('*/10");
  if (webSrc.slice(iCron, webSrc.indexOf('});', iCron)).includes('sinkron')) {
    throw new Error('GAGAL: cron stats masih polling worker tiap 10 detik');
  }
  console.log('  ok   cermin "bot jalan" + polling 10 detik masih terhapus');

  console.log('engine-bus-reconnect: PASS');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
