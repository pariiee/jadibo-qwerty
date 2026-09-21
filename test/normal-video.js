const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { normalVideo } = require('../engine/normalVideo');

// ── normalVideo: video 1 detik TANPA audio harus keluar punya track audio ─────
// Ini akar masalah ".twitter videonya ga bisa di putar": video X hasil cut
// datang tanpa track audio, dan WA nolak video kayak gitu.
const tmp = (n) => path.join(os.tmpdir(), `normtest_${Date.now()}_${n}`);

const bisu = tmp('bisu.mp4');
spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
  'testsrc=size=320x240:rate=10:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', bisu]);

const bersuara = tmp('bersuara.mp4');
spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
  'testsrc=size=320x240:rate=10:duration=1', '-f', 'lavfi', '-i',
  'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-shortest', bersuara]);

const ffprobe = (f, sel) => spawnSync('ffprobe',
  ['-v', 'error', '-select_streams', sel, '-show_entries', 'stream=codec_type',
    '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout || '';

const audioAda = (buf, nama) => {
  const f = tmp(nama);
  fs.writeFileSync(f, buf);
  const ada = /audio/.test(ffprobe(f, 'a'));
  fs.unlinkSync(f);
  return ada;
};

(async () => {
  const masuk = fs.readFileSync(bisu);
  const keluar = await normalVideo(masuk);

  assert.ok(Buffer.isBuffer(keluar) && keluar.length > 1024, 'keluaran kosong');
  assert.strictEqual(keluar.slice(8, 12).toString('latin1'), 'isom', 'brand mp4 bukan isom');
  assert.ok(audioAda(keluar, 'out1.mp4'), 'video bisu harus dapat track audio senyap');

  // video bersuara: audio ASLI jangan dihapus / diganti senyap
  const keluar2 = await normalVideo(fs.readFileSync(bersuara));
  assert.ok(audioAda(keluar2, 'out2.mp4'), 'video bersuara tetap harus punya audio');

  // buffer sampah: jangan meledak, balikin apa adanya
  const sampah = Buffer.from('ini bukan video sama sekali');
  assert.deepStrictEqual(await normalVideo(sampah), sampah, 'input ngaco harus balik apa adanya');
  assert.deepStrictEqual(await normalVideo(Buffer.alloc(0)), Buffer.alloc(0), 'buffer kosong aman');

  console.log('normalVideo: 0 FAIL');
})();
