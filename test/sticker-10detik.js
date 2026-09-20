'use strict';

/**
 * test/sticker-10detik.js
 * Kunci perilaku `.s`/`.sticker`/`.attp` untuk video & GIF:
 *   - canvas persis 512×512 (WA nolak ukuran lain → sticker di-flatten jadi
 *     gambar diam = frame pertama doang, keliatan "stuck 1 warna")
 *   - durasi 10 detik (dulu 5 detik), hasilnya tetap masuk batas 500KB WhatsApp
 * Butuh ffmpeg (ada di Windows & kedua VPS).
 */

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { spawnSync } = require('child_process');
const { videoKeStickerWebp, MAX_DETIK_STICKER, UKURAN_STICKER } = require('../engine/sticker');

assert.strictEqual(MAX_DETIK_STICKER, 10, 'durasi sticker harus 10 detik');
assert.strictEqual(UKURAN_STICKER, 512, 'canvas sticker harus 512');

// Jalur animasi di plugin harus lewat helper ini — bukan ffmpeg sendiri-sendiri
// dengan cap 5 detik yang bisa balik lagi tanpa ketahuan.
// `.attp`/`.bratvid` dulu punya cap 5 detik sendiri (sekarang ikut helper).
const srcPlugin = fs.readFileSync(path.join(__dirname, '..', 'plugins', '04-tools.js'), 'utf8');
const blokSticker = srcPlugin.slice(srcPlugin.indexOf("case 'sticker':"), srcPlugin.indexOf("case 'wm':"));
assert.ok(blokSticker.length > 500, 'blok case sticker/wm nggak ketemu di 04-tools.js');
assert.ok(/videoKeStickerWebp\(/.test(blokSticker), '.s/.sticker harus lewat engine/sticker.videoKeStickerWebp');
assert.ok(!/00:00:0[5-9]/.test(srcPlugin), 'cap durasi 5-9 detik balik lagi di 04-tools.js — pakai videoKeStickerWebp');

// `.bratvid` sumbernya 4,5 detik → di-loop biar genap 10 detik.
const blokBratvid = srcPlugin.slice(srcPlugin.indexOf("case 'bratvid':"), srcPlugin.indexOf("case 'bratvid':") + 1500);
assert.ok(/videoKeStickerWebp\([^)]*loop: true/.test(blokBratvid), '.bratvid harus lewat helper + loop (sumbernya 4,5 detik)');

// `.attp` sumbernya GIF 0,8 detik yang cuma muter warna → DIRENGGANG jadi 10
// detik, bukan di-loop: kalau di-loop warnanya keliatan ngulang terus dan
// stickernya berhenti di frame pertama (merah).
const blokAttp = srcPlugin.slice(srcPlugin.indexOf("case 'attp':"), srcPlugin.indexOf("case 'attp':") + 1500);
assert.ok(/videoKeStickerWebp\([^)]*regang: [\d.]+/.test(blokAttp), '.attp harus lewat helper + regang, bukan loop');
assert.ok(!/loop: true/.test(blokAttp), '.attp jangan di-loop lagi');

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

// Canvas dari chunk VP8X (3 byte little-endian, +1).
function ukuranWebp(buf) {
  const off = buf.indexOf('VP8X');
  assert.ok(off > 0, 'chunk VP8X nggak ketemu — bukan WebP animasi');
  const p = off + 8;
  return {
    w: 1 + (buf[p + 4] | (buf[p + 5] << 8) | (buf[p + 6] << 16)),
    h: 1 + (buf[p + 7] | (buf[p + 8] << 8) | (buf[p + 9] << 16)),
  };
}

function cek512(buf, label) {
  const { w, h } = ukuranWebp(buf);
  assert.strictEqual(w, 512, `${label}: canvas ${w}px — WA nolak selain 512px (sticker di-flatten jadi diam)`);
  assert.strictEqual(h, 512, `${label}: canvas ${h}px — WA nolak selain 512px (sticker di-flatten jadi diam)`);
}

(async () => {
  const { buf, tangga } = await videoKeStickerWebp(inMp4, outWebp);
  const kb = Math.round(buf.length / 1024);
  const { ms, frame } = durasiWebp(buf);
  const detik = ms / 1000;
  const uk = ukuranWebp(buf);

  console.log(`  video 12 detik → sticker ${kb}KB ${uk.w}x${uk.h}, durasi ${detik.toFixed(2)}s (${frame} frame), tangga ${tangga ? `${tangga.fps}fps/q${tangga.q}` : '(semua tangga kepakai)'}`);

  assert.ok(frame > 0, 'sticker nggak punya frame animasi (ANMF kosong)');
  assert.ok(detik >= 9.5, `durasi ${detik}s — harusnya ~10 detik, jangan balik ke 5`);
  assert.ok(buf.length <= 500 * 1024, `sticker ${kb}KB > 500KB (batas WhatsApp)`);
  cek512(buf, 'video 12 detik');

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
  const ukBerat = ukuranWebp(berat.buf);
  console.log(`  video 12 detik (noise) → sticker ${kbBerat}KB ${ukBerat.w}x${ukBerat.h}, tangga ${berat.tangga ? `${berat.tangga.fps}fps/q${berat.tangga.q}` : '(semua kepakai)'}`);
  assert.ok(berat.tangga, 'video berat nggak harus sampai kehabisan semua tangga — turunin rung-nya');
  assert.ok(berat.tangga.fps < 12, 'video berat harusnya udah turun fps, ini masih 12fps');
  assert.ok(berat.buf.length <= 500 * 1024, `sticker berat ${kbBerat}KB > 500KB`);
  cek512(berat.buf, 'video berat');

  try { fs.unlinkSync(inBerat); } catch {}
  try { fs.unlinkSync(outBerat); } catch {}

  // ── Sumber pendek (kasus .bratvid: 4,5 detik) → loop genapin 10 detik ────
  const inPendek  = path.join(tmp, `tes_sticker_pendek_in_${Date.now()}.gif`);
  const outPendek = path.join(tmp, `tes_sticker_pendek_out_${Date.now()}.webp`);
  const genPendek = spawnSync('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x320:d=0.8:rate=25', inPendek,
  ], { encoding: 'utf8' });
  assert.strictEqual(genPendek.status, 0, 'gagal bikin GIF pendek: ' + String(genPendek.stderr || '').slice(-200));

  const pendek = await videoKeStickerWebp(inPendek, outPendek, { loop: true });
  const dPendek = durasiWebp(pendek.buf);
  console.log(`  sumber 0,8 detik + loop → sticker ${(dPendek.ms / 1000).toFixed(2)}s (${dPendek.frame} frame), ${Math.round(pendek.buf.length / 1024)}KB`);
  assert.ok(dPendek.ms / 1000 >= 9.5, `sumber 0,8s harusnya di-loop jadi 10 detik, ini ${(dPendek.ms / 1000).toFixed(2)}s`);
  assert.ok(pendek.buf.length <= 500 * 1024, 'sticker hasil loop > 500KB');
  cek512(pendek.buf, 'sumber pendek + loop');

  try { fs.unlinkSync(inPendek); } catch {}
  try { fs.unlinkSync(outPendek); } catch {}

  // ── Kasus .attp: sumber 0,8 detik DIRENGGANG jadi 10 detik ───────────────
  // Kalau di-loop, frame-nya digandain (0,8s @10fps → 100 frame) dan warnanya
  // keliatan ngulang; diregang → 20 frame @2fps, sekali jalan sampai habis.
  const inRegang  = path.join(tmp, `tes_sticker_regang_in_${Date.now()}.gif`);
  const outRegang = path.join(tmp, `tes_sticker_regang_out_${Date.now()}.webp`);
  const genRegang = spawnSync('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=500x500:d=0.8:rate=25', inRegang,
  ], { encoding: 'utf8' });
  assert.strictEqual(genRegang.status, 0, 'gagal bikin GIF 0,8s: ' + String(genRegang.stderr || '').slice(-200));

  const regang = await videoKeStickerWebp(inRegang, outRegang, { regang: 12.5, fps: 2 });
  const dRegang = durasiWebp(regang.buf);
  console.log(`  sumber 0,8 detik + regang 12,5× → sticker ${(dRegang.ms / 1000).toFixed(2)}s (${dRegang.frame} frame), ${Math.round(regang.buf.length / 1024)}KB`);
  assert.ok(dRegang.ms / 1000 >= 9.5, `sumber 0,8s diregang harus 10 detik, ini ${(dRegang.ms / 1000).toFixed(2)}s`);
  assert.ok(dRegang.frame <= 25, `sumber 0,8s @2fps harusnya ~20 frame, ini ${dRegang.frame} — kayaknya di-loop, bukan diregang`);
  assert.ok(regang.buf.length <= 500 * 1024, 'sticker hasil regang > 500KB');
  cek512(regang.buf, 'sumber 0,8s + regang');

  try { fs.unlinkSync(inRegang); } catch {}
  try { fs.unlinkSync(outRegang); } catch {}

  console.log('✅ sticker-10detik: canvas 512×512, durasi 10 detik, ≤500KB');
})();
