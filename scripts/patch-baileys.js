'use strict';
/**
 * scripts/patch-baileys.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Baileys 7.0.0-rc14, `lib/Socket/messages-send.js` baris ~469:
 *
 *     const mediaType = getMediaType(message);
 *
 * `getMediaType()` cuma ngintip KEY PALING LUAR. Buat status grup (.swgc)
 * medianya nyempil di `groupStatusMessageV2.message`, jadi key paling luarnya
 * `groupStatusMessageV2` → `mediaType` kosong → attr `mediatype` di node <enc>
 * nggak ditulis → WA terima stanza-nya (emoji centang nongol) tapi media-nya
 * diem-diem nggak dirender. Teks jalan, gambar/video nggak. Nol error, nol log.
 *
 * Fix-nya satu baris: normalisasi dulu sebelum ditebak tipenya. Ini persis yang
 * dilakuin `wolfsocket` (fork Baileys yang punya `sock.sendGroupStatus()`).
 *
 * node_modules di-gitignore, jadi patch ini dijalanin tiap `npm install`
 * lewat `postinstall` di package.json. Idempoten — aman dipanggil berkali-kali.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'node_modules', 'baileys', 'lib', 'Socket', 'messages-send.js');
const ASLI = 'const mediaType = getMediaType(message);';
const PATCHED = 'const mediaType = getMediaType(normalizeMessageContent(message) || message);';

function main() {
  if (!fs.existsSync(FILE)) {
    console.log('[patch-baileys] baileys belum ke-install — dilewati');
    return;
  }
  const s = fs.readFileSync(FILE, 'utf8');
  if (s.includes(PATCHED)) {
    console.log('[patch-baileys] sudah terpasang');
    return;
  }
  if (!s.includes(ASLI)) {
    console.log('[patch-baileys] pola nggak ketemu (versi baileys beda?) — dilewati');
    return;
  }
  fs.writeFileSync(FILE, s.replace(ASLI, PATCHED));
  console.log('[patch-baileys] terpasang: mediatype status grup');
}

if (require.main === module) main();
module.exports = { main, FILE, ASLI, PATCHED };
