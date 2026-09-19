'use strict';
/**
 * test/swgc-media-mediatype.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Check buat dua hal yang bikin `.swgc` media gagal (teks jalan, foto/video
 * nggak):
 *
 *  1. Bentuk proto: messageSecret 32 byte di DUA tempat — messageContextInfo
 *     luar DAN di dalam groupStatusMessageV2.message. Media HARUS tetap di
 *     dalam groupStatusMessageV2.message (kalau digelembungin ke luar, WA baca
 *     sebagai media biasa, bukan status grup).
 *  2. Patch Baileys: `getMediaType()` cuma ngintip key paling luar, jadi media
 *     di status grup harus di-normalisasi dulu. Tanpa patch, attr `mediatype`
 *     nggak ditulis → WA drop medianya diem-diem (emoji centang tetap nongol).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { groupStatusContent } = require('../engine/baileys/client');

// Tiru logika getMediaType() Baileys (versi ringkas — cukup buat ngecek).
const getMediaType = (m) =>
  m?.imageMessage ? 'image' : m?.videoMessage ? (m.videoMessage.gifPlayback ? 'gif' : 'video') : '';

const VIDEO = {
  videoMessage: {
    url: 'https://mmg.whatsapp.net/x.enc',
    mimetype: 'video/mp4',
    fileSha256: Buffer.alloc(32, 1),
    fileLength: 1234,
    mediaKey: Buffer.alloc(32, 2),
    fileEncSha256: Buffer.alloc(32, 3),
    directPath: '/v/x',
    mediaKeyTimestamp: 1,
    seconds: 3,
    caption: 'test',
  },
};

const FOTO = {
  imageMessage: { url: 'https://mmg.whatsapp.net/y.enc', mimetype: 'image/jpeg' },
};

async function main() {
  // ── 1. Patch Baileys kepasang ─────────────────────────────────────────────
  {
    const f = path.join(__dirname, '..', 'node_modules', 'baileys', 'lib', 'Socket', 'messages-send.js');
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(
      s.includes('getMediaType(normalizeMessageContent(message) || message)'),
      'patch mediatype belum kepasang — jalanin: node scripts/patch-baileys.js',
    );
    assert.ok(
      !/const mediaType = getMediaType\(message\);/.test(s),
      'varian lama masih ada: mediaType = getMediaType(message)',
    );
    console.log('  ✓ patch Baileys: mediatype baca konten yg udah di-normalisasi');
  }

  // ── 2. Bentuk proto status grup ───────────────────────────────────────────
  {
    const out = await groupStatusContent(VIDEO, async () => 'upload-mock');

    // media tetap DI DALAM, jangan digelembungin ke luar
    assert.ok(!out.videoMessage, 'videoMessage nggak boleh nongkrong di top-level');
    assert.ok(out.groupStatusMessageV2, 'groupStatusMessageV2 wajib ada');

    const dalam = out.groupStatusMessageV2.message;
    assert.ok(dalam.videoMessage, 'videoMessage harus di dalam groupStatusMessageV2.message');
    assert.strictEqual(dalam.videoMessage.caption, 'test', 'caption harus kebawa');

    // messageSecret 32 byte, dua tempat, nilainya sama
    const luar = out.messageContextInfo?.messageSecret;
    const diDalam = dalam.messageContextInfo?.messageSecret;
    assert.ok(Buffer.isBuffer(luar), 'messageSecret luar harus Buffer');
    assert.ok(Buffer.isBuffer(diDalam), 'messageSecret dalam harus Buffer');
    assert.strictEqual(luar.length, 32, 'messageSecret harus 32 byte');
    assert.strictEqual(diDalam.length, 32, 'messageSecret dalam harus 32 byte');
    assert.ok(luar.equals(diDalam), 'messageSecret luar & dalam harus sama nilainya');

    // sekali lagi → secret-nya harus beda (acak tiap kirim)
    const lagi = await groupStatusContent(VIDEO, async () => "upload-mock");
    assert.ok(
      !luar.equals(lagi.messageContextInfo.messageSecret),
      'messageSecret harus diacak tiap panggilan',
    );

    console.log('  ✓ bentuk proto: media di dalam, messageSecret 32 byte x2, acak');
  }

  // ── 3. Simulasi: mediatype kebaca setelah normalisasi ─────────────────────
  {
    const out = await groupStatusContent(FOTO, async () => "upload-mock");

    assert.strictEqual(getMediaType(out), '', 'sebelum normalisasi: mediaType kosong (ini bug-nya)');
    assert.strictEqual(
      getMediaType(out.groupStatusMessageV2.message),
      'image',
      'sesudah normalisasi: mediaType harus kebaca',
    );

    console.log('  ✓ simulasi: mediaType kosong → kebaca setelah normalisasi');
  }

  console.log('swgc-media-mediatype: PASS');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
