// Banding struktur sticker RESMI WhatsApp (contoh animasi dari repo WhatsApp/stickers) vs punya kita.
const fs = require('fs'); const os = require('os'); const path = require('path'); const sharp = require('sharp');
const { spawnSync } = require('child_process');

function bedah(label, file) {
  const buf = fs.readFileSync(file);
  const p = buf.indexOf('VP8X');
  const flags = p >= 0 ? buf[p + 8] : null;
  let off = 12, frame = 0, ms = 0, loop = null, minMs = 1e9, maxMs = 0; const chunks = []; let animBg = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4); const size = buf.readUInt32LE(off + 4);
    chunks.push(id);
    if (id === 'ANIM') { animBg = buf.slice(off + 8, off + 12).toString('hex'); loop = buf.readUInt16LE(off + 12); }
    if (id === 'ANMF') { const q = off + 8; const d = buf[q + 12] | (buf[q + 13] << 8) | (buf[q + 14] << 16);
      ms += d; frame++; minMs = Math.min(minMs, d); maxMs = Math.max(maxMs, d); }
    off += 8 + size + (size % 2);
  }
  console.log(`${label}: ${Math.round(buf.length / 1024)}KB`);
  console.log(`  VP8X flags=${flags === null ? '-' : '0x' + flags.toString(16).padStart(2, '0')} anim=${flags !== null && !!(flags & 0x02)} alpha=${flags !== null && !!(flags & 0x10)}`);
  console.log(`  chunk=${[...new Set(chunks)].join(',')} ANMF=${frame} durasi=${(ms / 1000).toFixed(2)}s delay min/max=${minMs}/${maxMs}ms loop=${loop} bgcolor=${animBg}`);
}
(async () => {
  const ref = path.join(os.tmpdir(), 'ref_07_OK.webp');
  bedah('REF WA 07_OK', ref);
  const m = await sharp(ref, { animated: true }).metadata();
  console.log(`  sharp: ${m.width}x${m.height} pages=${m.pages} hasAlpha=${m.hasAlpha} delay0=${m.delay && m.delay[0]} loop=${m.loop}`);
  const out = path.join(os.tmpdir(), 's2_out.webp'), fin = path.join(os.tmpdir(), 's2_final.webp');
  if (fs.existsSync(out)) bedah('PUNYA KITA (sebelum EXIF)', out);
  if (fs.existsSync(fin)) bedah('PUNYA KITA (sesudah EXIF)', fin);
})();
