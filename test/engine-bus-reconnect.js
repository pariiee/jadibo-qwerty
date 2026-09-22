'use strict';
/**
 * test/engine-bus-reconnect.js — cermin "bot jalan" harus keisi sendiri.
 *
 * Bug yang dijaga: worker restart → `_siap = false` → push `{type:'running'}`
 * cuma masuk buffer → kalau flush() dipanggil SEBELUM bot dinyalain, push
 * terakhir nggak pernah kekirim dan web nggak tau bot hidup lagi (tombol
 * start/stop salah tebak sampai ada orang klik).
 *
 * fetch-nya distub, bukan server HTTP beneran: yang diuji urutan buffer/flush,
 * bukan TCP-nya. Stub = nggak ada socket, tes nggak bisa flaky.
 */
const fs   = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'workers', 'botWorker.js'), 'utf8');

// Ambil fungsi apa adanya dari sumber (bukan disalin) supaya tes ikut gagal
// kalau isinya berubah — bukan cuma kalau namanya hilang.
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
function jalankan(activeBots) {
  const terkirim = [];
  let webMati = true;
  const fetchPalsu = async (url, opt) => {
    if (webMati) throw new Error('ECONNREFUSED');
    terkirim.push(JSON.parse(opt.body));
    return { ok: true };
  };
  const api = new Function(
    'fetch', 'activeBots', 'WEB_PORT', 'KUNCI', 'setInterval',
    `const _buffer = []; let _siap = false;
     ${['post', 'kirimEvent', 'flush'].map(ambil).join('\n')}
     return { kirimEvent, flush, siap: () => _siap, buffer: () => _buffer.length };`
  )(fetchPalsu, activeBots, 3000, 'kunci-tes', () => ({ unref() {} }));
  return { ...api, terkirim, hidupkanWeb: () => { webMati = false; } };
}

(async () => {
  // 1. Worker boot waktu web mati → event ditahan, bukan dibuang.
  const bots = new Map([[1, {}], [2, {}]]);
  const w = jalankan(bots);
  await w.kirimEvent({ type: 'log', pesan: 'bot mulai' });
  if (w.siap()) throw new Error('GAGAL: worker ngerasa tersambung padahal web belum nyala');
  if (w.buffer() !== 1) throw new Error(`GAGAL: buffer harus 1, dapat ${w.buffer()}`);
  if (w.terkirim.length) throw new Error('GAGAL: ada yang kekirim padahal web mati');
  console.log('  ok   web mati → event ditahan di buffer, nggak dibuang');

  // 2. Web balik → flush() (dipanggil boot() SETELAH bot nyala) nge-push semuanya.
  w.hidupkanWeb();
  await w.flush();
  if (!w.siap()) throw new Error('GAGAL: flush() sukses tapi _siap nggak jadi true');
  await w.kirimEvent({ type: 'running', ids: [...bots.keys()] });

  const running = w.terkirim.filter((e) => e.type === 'running').pop();
  if (!running) throw new Error('GAGAL: web nggak pernah nerima daftar bot yang jalan');
  if (JSON.stringify(running.ids) !== '[1,2]') {
    throw new Error(`GAGAL: ids harus [1,2], dapat ${JSON.stringify(running.ids)}`);
  }
  const log = w.terkirim.find((e) => e.type === 'log');
  if (!log) throw new Error('GAGAL: event lama yang ditahan buffer nggak ikut ke-flush');
  console.log(`  ok   web balik → cermin keisi ids ${JSON.stringify(running.ids)} + buffer dikuras`);

  // 3. flush() di boot() HARUS setelah auto-start — kalau sebelum, push "running"
  //    (dan tiap event sebelumnya) nyangkut di buffer dan nggak pernah kekirim.
  const iFlush = src.indexOf('await flush();');
  if (iFlush < src.indexOf('auto-start')) {
    throw new Error('GAGAL: flush() dipanggil SEBELUM auto-start — push "running" nyangkut di buffer');
  }
  console.log('  ok   flush() di boot() jalan setelah auto-start bot');

  // 4. Web restart sendiri (worker nggak di-restart) → harus ada penyambung ulang.
  if (!/setInterval\(\(\) => \{ if \(!_siap\) flush\(\); \}/.test(src)) {
    throw new Error('GAGAL: nggak ada retry flush() — web restart = cermin basi selamanya');
  }
  console.log('  ok   ada retry flush() selagi web belum tersambung');

  // 5. Cron stats di web nggak boleh polling ke worker lagi (mubazir + bisa kelewat).
  const webSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const iCron  = webSrc.indexOf("cron.schedule('*/10");
  const cron   = webSrc.slice(iCron, webSrc.indexOf('});', iCron));
  if (cron.includes('engineBus.sinkron()')) {
    throw new Error('GAGAL: cron stats masih polling engineBus.sinkron() tiap 10 detik');
  }
  console.log('  ok   cron stats nggak polling worker lagi');

  // 6. Sinkron saat boot harus ada tapi TERBATAS — kalau nggak ada, web yang
  //    restart nggak pernah tau worker udah jalan; kalau nggak berhenti, itu
  //    polling lagi lewat pintu belakang.
  const iBoot = webSrc.indexOf('engineBus.sinkron()');
  const boot  = webSrc.slice(iBoot - 400, iBoot + 120);
  if (iBoot < 0 || !boot.includes('clearInterval')) {
    throw new Error('GAGAL: sinkron saat boot nggak ada / nggak berhenti (jadi polling)');
  }
  console.log('  ok   sinkron saat boot ada dan berhenti sendiri');

  console.log('engine-bus-reconnect: PASS');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
