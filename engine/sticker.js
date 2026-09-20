'use strict';

/**
 * engine/sticker.js
 * Helper lintas-plugin: inject EXIF metadata (packname/author) ke WebP sticker.
 * Dipakai 04-tools (.s/.wm) dan 05-owner (.get) supaya sticker hasil kirim
 * pakai packname/author dari .env (STICKER_PACK_NAME / STICKER_AUTHOR).
 */

// ─── Inject EXIF metadata ke WebP sticker pakai node-webpmux ─────────────────
async function addStickerExif(webpBuffer, packname, author) {
  try {
    const webp = require('node-webpmux');
    const { tmpdir } = require('os');
    const crypto = require('crypto');
    const path   = require('path');
    const fs     = require('fs');

    const tmpIn  = path.join(tmpdir(), `exif_in_${crypto.randomBytes(4).toString('hex')}.webp`);
    const tmpOut = path.join(tmpdir(), `exif_out_${crypto.randomBytes(4).toString('hex')}.webp`);
    fs.writeFileSync(tmpIn, webpBuffer);

    const img      = new webp.Image();
    const json     = {
      'sticker-pack-id':        'https://yapari.web.id',
      'sticker-pack-name':      packname || 'YaaParBot',
      'sticker-pack-publisher': author   || 'yapari.web.id',
      'emojis':                 [''],
    };
    const exifAttr  = Buffer.from([0x49,0x49,0x2A,0x00,0x08,0x00,0x00,0x00,0x01,0x00,0x41,0x57,0x07,0x00,0x00,0x00,0x00,0x00,0x16,0x00,0x00,0x00]);
    const jsonBuff  = Buffer.from(JSON.stringify(json), 'utf-8');
    const exif      = Buffer.concat([exifAttr, jsonBuff]);
    exif.writeUIntLE(jsonBuff.length, 14, 4);

    await img.load(tmpIn);
    try { fs.unlinkSync(tmpIn); } catch {}
    img.exif = exif;
    await img.save(tmpOut);

    const result = fs.readFileSync(tmpOut);
    try { fs.unlinkSync(tmpOut); } catch {}
    return result;
  } catch {
    return webpBuffer; // fallback ke buffer asli kalau gagal
  }
}

// ─── Video/GIF → WebP sticker animasi ───────────────────────────────────────
// Batas WhatsApp untuk sticker animasi itu UKURAN (500KB), bukan durasi. Jadi
// durasi dipatok 10 detik dan yang diturunkan bertahap itu resolusi + fps +
// quality, sampai masuk 400KB (sisain ruang buat EXIF & overhead kirim).
// ponytail: 3 tangga udah nutup video 10 detik pada umumnya; tambah tangga
// kalau nanti masih ada yang kejegal.
const TANGGA_STICKER = [
  { fps: 12, px: 512, q: 70 },
  { fps: 10, px: 320, q: 55 },
  { fps: 8,  px: 256, q: 40 },
];
const MAX_DETIK_STICKER = 10;
const TARGET_STICKER_KB = 400;

// Dipakai .s/.sticker (video & GIF) dan .wm. Return buffer WebP (belum EXIF).
async function videoKeStickerWebp(inPath, outPath, { detik = MAX_DETIK_STICKER, tangga = TANGGA_STICKER } = {}) {
  const { spawn } = require('child_process');
  const fs = require('fs');
  const durasi = `00:00:${String(detik).padStart(2, '0')}`;
  let terakhir = null;
  let terpilih = null;

  for (const t of tangga) {
    const scale = `scale='min(${t.px},iw)':'min(${t.px},ih)':force_original_aspect_ratio=decrease`;
    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-y', '-i', inPath,
        '-vcodec', 'libwebp',
        '-vf', `${scale},fps=${t.fps}`,
        '-loop', '0', '-ss', '00:00:00', '-t', durasi,
        '-preset', 'default', '-an', '-quality', String(t.q), outPath,
      ]);
      ff.on('error', reject);
      ff.on('close', code => code !== 0 ? reject(new Error(`ffmpeg exit code ${code}`)) : resolve());
    });
    terakhir = fs.readFileSync(outPath);
    if (terakhir.length <= TARGET_STICKER_KB * 1024) { terpilih = { ...t, buf: terakhir }; break; }
  }

  return { buf: terpilih ? terpilih.buf : terakhir, tangga: terpilih || null };
}

module.exports = { addStickerExif, videoKeStickerWebp, TANGGA_STICKER, MAX_DETIK_STICKER };
