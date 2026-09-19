// Patch node_modules Baileys: `getMediaType()` di relayMessage() dipanggil
// dgn pesan MENTAH, jadi dia ngeliat `groupStatusMessageV2` (bukan video) dan
// balikin undefined -> attr `mediatype` di node <enc> nggak ditulis, WA
// diam-diam nolak render medianya (teks tetep jalan, foto/video dijadiin teks).
//
// `normalizeMessageContent()` memang membedah `groupStatusMessageV2` (lihat
// getFutureProofMessage di lib/Utils/messages.js:659) — itu yg kita mau.
//
// Dipanggil `postinstall`, idempoten: aman diulang.
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'node_modules', 'baileys', 'lib', 'Socket', 'messages-send.js');
const ASAL = 'const mediaType = getMediaType(message);';
const PATCH = 'const mediaType = getMediaType(normalizeMessageContent(message) || message);';

if (!fs.existsSync(FILE)) {
  console.log('[patch-baileys] node_modules/baileys belum ada — dilewati');
  process.exit(0);
}

const isi = fs.readFileSync(FILE, 'utf8');
if (isi.includes(PATCH)) {
  console.log('[patch-baileys] sudah terpasang');
  process.exit(0);
}
if (!isi.includes(ASAL)) {
  console.error('[patch-baileys] pola nggak ketemu — versi baileys berubah?');
  process.exit(1);
}

fs.writeFileSync(FILE, isi.replace(ASAL, PATCH));
console.log('[patch-baileys] terpasang: mediatype status grup');
