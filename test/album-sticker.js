// Uji buatStickerPack: pack = satu WebP berisi N frame (satu sticker = satu frame) + tray PNG 252×252.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const { buatStickerPack } = require('../engine/sticker');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uji_pack_'));
const warna = ['red', 'lime', 'blue', 'yellow'];
const bufs = warna.map((w, i) => {
  const f = path.join(dir, `src_${i}.webp`);
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', `color=${w}:s=509x512`, '-frames:v', '1', f]);
  assert.strictEqual(r.status, 0, 'ffmpeg bikin sumber gagal');
  return fs.readFileSync(f);
});

(async () => {
  const pack = await buatStickerPack(bufs, { nama: 'Uji Pack' });

  assert.strictEqual(pack.pack.toString('ascii', 0, 4), 'RIFF', 'pack bukan RIFF');
  assert.strictEqual(pack.pack.toString('ascii', 8, 12), 'WEBP', 'pack bukan WEBP');
  let off = 12, anmf = 0, vp8x = false;
  while (off + 8 <= pack.pack.length) {
    const id = pack.pack.toString('ascii', off, off + 4);
    const sz = pack.pack.readUInt32LE(off + 4);
    if (id === 'ANMF') anmf++;
    if (id === 'VP8X') vp8x = true;
    off += 8 + sz + (sz % 2);
  }
  assert.ok(vp8x, 'nggak ada chunk VP8X');
  assert.strictEqual(anmf, bufs.length, `frame pack ${anmf} != sticker ${bufs.length}`);
  assert.strictEqual(pack.stickers.length, bufs.length, 'metadata sticker nggak sinkron');
  for (const s of pack.stickers) {
    assert.ok(/^[A-Za-z0-9+/]{43}=\.webp$/.test(s.fileName), 'fileName bukan base64 sha256: ' + s.fileName);
    assert.strictEqual(s.isAnimated, false, 'sticker diam kok isAnimated true');
  }
  assert.strictEqual(pack.tray.toString('ascii', 1, 4), 'PNG', 'tray bukan PNG');
  assert.strictEqual(pack.tray.readUInt32BE(16), 252, 'lebar tray bukan 252');
  assert.strictEqual(pack.tray.readUInt32BE(20), 252, 'tinggi tray bukan 252');
  assert.ok(pack.pack.length < 500 * 1024, 'pack kegedean: ' + pack.pack.length);

  console.log(`OK pack ${pack.pack.length}B frame ${anmf} tray ${pack.tray.length}B`);
  fs.rmSync(dir, { recursive: true, force: true });
})().catch(e => { console.error('ADA GAGAL:', e.message); process.exit(1); });
