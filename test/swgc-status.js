'use strict';
/**
 * test/swgc-status.js — regresi `.swgc` (status grup).
 *
 * Bug nyata (dilaporkan Pak): reply video → `.swgc` → 
 *   `❌ Gagal kirim status grup: Cannot read properties of undefined (reading 'replace')`
 * Akarnya: handler manggil `client.message.upload(buffer, {...})` yang di adapter
 * cuma dioper mentah ke `sock.waUploadToServer(buffer, opts)` — padahal signature
 * Baileys beda (butuh path file + fileEncSha256B64). Akibatnya
 * `encodeBase64EncodedStringForUpload(undefined)` → `.replace` di undefined.
 *
 * Dua hal yang dijaga tes ini:
 *  1. media WAJIB disiapkan lewat `client.message.prepareMedia` (Baileys yang
 *     enkripsi + upload), bukan `message.upload` warisan zapo.
 *  2. `groupStatusMessageV2` WAJIB lewat jalur relay (`isRawProto`), karena
 *     `sock.sendMessage` nolak dengan "Invalid media type".
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const OK = (nama, fn) => {
  try { fn(); console.log('  ok  ' + nama); pass++; }
  catch (e) { console.log('  FAIL ' + nama + ' → ' + e.message); fail++; }
};

console.log('swgc-status:');

const klien = require('../engine/baileys/client.js');

OK('groupStatusMessageV2 lewat jalur relay (bukan sendMessage)', () => {
  const isRawProto = klien.isRawProto || (klien.default && klien.default.isRawProto);
  assert.strictEqual(typeof isRawProto, 'function', 'isRawProto nggak diekspor');
  assert.strictEqual(isRawProto({ groupStatusMessageV2: { message: {} } }), true);
});

const SRC = fs.readFileSync(path.join(__dirname, '..', 'plugins', '02-group.js'), 'utf8');

OK('handler .swgc pakai prepareMedia (bukan message.upload)', () => {
  assert.ok(/message\.prepareMedia\(/.test(SRC), 'prepareMedia nggak dipakai di 02-group.js');
  assert.ok(!/message\.upload\(/.test(SRC), 'masih ada pemanggilan message.upload() yang rusak');
});

OK('tiga tipe media (gambar/video/audio) semuanya lewat prepareMedia', () => {
  for (const t of ['image', 'video', 'audio']) {
    assert.ok(new RegExp(`prepareMedia\\(buffer, \\{ type: '${t}'`).test(SRC), `tipe ${t} belum pakai prepareMedia`);
  }
});

OK('adapter nggak lagi nerusin buffer ke waUploadToServer', () => {
  const ad = fs.readFileSync(path.join(__dirname, '..', 'engine', 'baileys', 'client.js'), 'utf8')
    .split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))   // buang baris komentar (biar nggak false positive)
    .join('\n');
  assert.ok(!/waUploadToServer\(buffer/.test(ad), 'masih ada waUploadToServer(buffer, ...) — signature-nya salah');
});

console.log(`\nswgc-status: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
