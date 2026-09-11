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

module.exports = { addStickerExif };
