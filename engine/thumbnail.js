'use strict';

/**
 * engine/thumbnail.js
 * Helper: generate jpegThumbnail (72x72) dari buffer media
 * - image (jpeg/png/webp/dll) → pakai sharp
 * - video (mp4/dll)           → extract frame pertama pakai ffmpeg
 * Return: Buffer JPEG kecil, atau null kalau gagal
 */

const os   = require('os');
const path = require('path');
const fs   = require('fs');

/**
 * WA cuma nampilin `imageMessage` kalau tipenya JPEG (atau PNG). WebP lolos
 * upload tanpa error, stanza-nya diterima, tapi bubble-nya kosong — kayak
 * `.tt` di photo mode TikTok (CDN-nya cuma kasih `.webp`, varian `.jpeg` 403).
 * Jadi tiap gambar yang mau dikirim dikonversi dulu ke JPEG di sini, satu
 * tempat, biar semua pemanggil (.tt/.pinterest/.threads/...) kena.
 * Return { buf, ct } — ct selalu `image/jpeg` kalau konversi berhasil.
 */
async function jpegkan(buffer, mimetype) {
  const mime = (mimetype || '').split(';')[0].trim().toLowerCase() || 'image/jpeg';
  if (mime === 'image/jpeg' || mime === 'image/png') return { buf: buffer, ct: mime };
  try {
    const sharp = require('sharp');
    const buf   = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
    return { buf, ct: 'image/jpeg' };
  } catch {
    return { buf: buffer, ct: mime };   // sharp nggak bisa baca → kirim apa adanya
  }
}

async function genThumbnail(buffer, mimetype, size = 72) {
  try {
    const mime = (mimetype || '').toLowerCase();

    if (/^image\//.test(mime)) {
      // ── Image → sharp resize ──────────────────────────────────────────────
      const sharp = require('sharp');
      return await sharp(buffer)
        .resize(size, size, { fit: 'inside' })
        .jpeg({ quality: 80 })
        .toBuffer();
    }

    if (/^video\//.test(mime)) {
      // ── Video → ffmpeg extract frame pertama ──────────────────────────────
      const { spawn } = require('child_process');
      const ext    = mime === 'video/3gpp' ? '3gp' : 'mp4';
      const tmpIn  = path.join(os.tmpdir(), `thumb_in_${Date.now()}.${ext}`);
      const tmpOut = path.join(os.tmpdir(), `thumb_out_${Date.now()}.jpg`);
      fs.writeFileSync(tmpIn, buffer);

      await new Promise((resolve) => {
        const ff = spawn('ffmpeg', [
          '-y', '-i', tmpIn,
          '-vframes', '1',
          '-vf', `scale=${size}:${size}:force_original_aspect_ratio=decrease`,
          '-q:v', '5',
          tmpOut,
        ]);
        ff.on('error', () => resolve()); // ffmpeg tidak ada → thumbnail null, jangan sampai crash
        ff.on('close', resolve);
      });

      try { fs.unlinkSync(tmpIn); } catch {}

      if (fs.existsSync(tmpOut)) {
        const result = fs.readFileSync(tmpOut);
        try { fs.unlinkSync(tmpOut); } catch {}
        return result;
      }
    }
  } catch { /* gagal → return null */ }

  return null;
}

module.exports = { genThumbnail, jpegkan };
