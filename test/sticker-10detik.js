'use strict';

/**
 * test/sticker-10detik.js
 * Kunci perilaku `.s`/`.sticker` untuk video & GIF:
 *   - dipotong 10 detik (dulu 5 detik)
 *   - hasilnya tetap masuk batas 500KB WhatsApp
 * Butuh ffmpeg + ffprobe (ada di Windows & kedua VPS).
 */

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { spawnSync } = require('child_process');
const { videoKeStickerWebp, MAX_DETIK_STICKER } = require('../engine/sticker');

assert.strictEqual(MAX_DETIK_STICKER, 10, 'durasi sticker harus 10 detik');

// Jalur video di plugin harus lewat helper ini — bukan ffmpeg sendiri-sendiri
// dengan cap 5 detik yang bisa balik lagi tanpa ketahuan.
// (Cek dibatasi ke blok `case 'sticker'` … `case 'wm'`: .attp/.bratvid masih
// punya cap 5 detik sendiri karena itu animasi dari server, bukan video user.)
const srcPlugin = fs.readFileSync(path.join(__dirname, '..', 'plugins', '04-tools.js'), 'utf8');
const blokSticker = srcPlugin.slice(srcPlugin.indexOf("case 'sticker':"), srcPlugin.indexOf("case 'wm':"));
assert.ok(blokSticker.length > 500, 'blok case sticker/wm nggak ketemu di 04-tools.js');
assert.ok(/videoKeStickerWebp\(/.test(blokSticker), '.s/.sticker harus lewat engine/sticker.videoKeStickerWebp');
assert.ok(!/00:00:05/.test(blokSticker), 'cap 5 detik balik lagi di jalur .s/.sticker');

const tmp     = os.tmpdir();
const inMp4   = path.join(tmp, `tes_sticker_in_${Date.now()}.mp4`);
const outWebp = path.join(tmp, `tes_sticker_out_${Date.now()}.webp`);

const gen = spawnSync('ffmpeg', [
  '-y', '-v', 'error', '-f', 'lavfi', '-i', 'gradients=s=640x480:d=12:speed=0.02',
  '-pix_fmt', 'yuv420p', '-r', '30', inMp4,
], { encoding: 'utf8' });
assert.strictEqual(gen.status, 0, 'gagal bikin video uji: ' + String(gen.stderr || '').slice(-300));

// Durasi dibaca langsung dari container WebP (chunk ANMF), bukan lewat
// ffprobe/ffmpeg: ffmpeg 6.1 di VPS nggak mau nge-decode animated WebP
// (ffmpeg 9 lokal bisa), jadi parser sendiri bebas dari beda versi itu.
// ANMF payload: 16 byte header, durasi frame = 3 byte little-endian di offset 12.
function durasiWebp(buf) {
  assert.strictEqual(buf.toString('ascii', 0, 4), 'RIFF', 'bukan file RIFF');
  assert.strictEqual(buf.toString('ascii', 8, 12), 'WEBP', 'bukan file WebP');
  let off = 12, ms = 0, frame = 0;
  while (off + 8 <= buf.length) {
    const id   = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'ANMF') {
      const p = off + 8;
      ms += buf[p + 12] | (buf[p + 13] << 8) | (buf[p + 14] << 16);
      frame++;
    }
    off += 8 + size + (size % 2);
  }
  return { ms, frame };
}

(async () => {
  const { buf, tangga } = await videoKeStickerWebp(inMp4, outWebp);
  const kb = Math.round(buf.length / 1024);
  const { ms, frame } = durasiWebp(buf);
  const detik = ms / 1000;

  console.log(`  video 12 detik → sticker ${kb}KB, durasi ${detik.toFixed(2)}s (${frame} frame), tangga ${tangga ? `${tangga.px}px/${tangga.fps}fps/q${tangga.q}` : '(semua tangga kepakai)'}`);

  assert.ok(frame > 0, 'sticker nggak punya frame animasi (ANMF kosong)');
  assert.ok(detik >= 9.5, `durasi ${detik}s — harusnya ~10 detik, jangan balik ke 5`);
  assert.ok(buf.length <= 500 * 1024, `sticker ${kb}KB > 500KB (batas WhatsApp)`);

  try { fs.unlinkSync(inMp4); } catch {}
  try { fs.unlinkSync(outWebp); } catch {}

  // ── Skenario berat: video penuh noise → tangga harus turun sendiri ────────
  const inBerat  = path.join(tmp, `tes_sticker_berat_in_${Date.now()}.mp4`);
  const outBerat = path.join(tmp, `tes_sticker_berat_out_${Date.now()}.webp`);
  const genBerat = spawnSync('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x480:d=12:rate=30',
    '-pix_fmt', 'yuv420p', inBerat,
  ], { encoding: 'utf8' });
  assert.strictEqual(genBerat.status, 0, 'gagal bikin video uji berat: ' + String(genBerat.stderr || '').slice(-200));

  const berat = await videoKeStickerWebp(inBerat, outBerat);
  const kbBerat = Math.round(berat.buf.length / 1024);
  console.log(`  video 12 detik (noise) → sticker ${kbBerat}KB, tangga ${berat.tangga ? `${berat.tangga.px}px/${berat.tangga.fps}fps/q${berat.tangga.q}` : '(semua kepakai)'}`);
  assert.ok(berat.tangga, 'video berat nggak harus sampai kehabisan semua tangga — turunin rung-nya');
  assert.ok(berat.tangga.px < 512, 'video berat harusnya udah turun resolusi, ini masih 512px');
  assert.ok(berat.buf.length <= 500 * 1024, `sticker berat ${kbBerat}KB > 500KB`);

  try { fs.unlinkSync(inBerat); } catch {}
  try { fs.unlinkSync(outBerat); } catch {}

  console.log('✅ sticker-10detik: video 12s → sticker 10 detik & ≤500KB');
})();
