'use strict';

/**
 * engine/thumbnail.js
 * Helper: generate jpegThumbnail dari buffer media
 * - image (jpeg/png/webp/dll) → pakai sharp
 * - video (mp4/dll)           → extract frame pertama pakai ffmpeg
 * `size` = sisi terpanjang (default 72 = thumbnail mini; 200 = header banner).
 * Return: Buffer JPEG kecil, atau null kalau gagal
 */

const os   = require('os');
const path = require('path');
const fs   = require('fs');

async function genThumbnail(buffer, mimetype, size = 72) {
  try {
    const mime = (mimetype || '').toLowerCase();

    if (/^image\//.test(mime)) {
      // ── Image → sharp resize ──────────────────────────────────────────────
      const sharp = require('sharp');
      return await sharp(buffer)
        .resize(size, size, { fit: 'inside' })
        .jpeg({ quality: 70 })
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
          '-vf', 'scale=72:72:force_original_aspect_ratio=decrease',
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

module.exports = { genThumbnail };
