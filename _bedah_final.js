// Cek byte-level file FINAL yang dikirim: VP8X flags (bit animasi/alpha/exif), chunk ANIM, ANMF, warna per frame.
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
require('dotenv').config();
const { videoKeStickerWebp, addStickerExif } = require('./engine/sticker');

function bedah(label, buf) {
  const p = buf.indexOf('VP8X');
  const flags = buf[p + 8];
  const chunks = [];
  let off = 12, frame = 0, ms = 0, loop = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    chunks.push(id);
    if (id === 'ANIM') loop = buf.readUInt16LE(off + 8 + 4);
    if (id === 'ANMF') { const q = off + 8; ms += buf[q + 12] | (buf[q + 13] << 8) | (buf[q + 14] << 16); frame++; }
    off += 8 + size + (size % 2);
  }
  const w = 1 + (buf[p + 4] | (buf[p + 5] << 8) | (buf[p + 6] << 16));
  const h = 1 + (buf[p + 7] | (buf[p + 8] << 8) | (buf[p + 9] << 16));
  console.log(`${label}: ${Math.round(buf.length / 1024)}KB canvas ${w}x${h}`);
  console.log(`  VP8X flags=0x${flags.toString(16).padStart(2, '0')} (animasi=${!!(flags & 0x02)} alpha=${!!(flags & 0x10)} exif=${!!(flags & 0x08)})`);
  console.log(`  chunk: ${[...new Set(chunks)].join(' ')} | ANMF ${frame} | durasi ${(ms / 1000).toFixed(2)}s | loop ANIM=${loop}`);
}

// warna teks per frame dari file final (decode lokal, ffmpeg 9 bisa)
function warnaPerFrame(file) {
  const raw = path.join(os.tmpdir(), `wpf_${Date.now()}.rgba`);
  const d = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', raw], { encoding: 'utf8' });
  if (d.status !== 0) return '(decode gagal)';
  const buf = fs.readFileSync(raw); const per = 512 * 512 * 4; const n = Math.floor(buf.length / per);
  const out = [];
  for (let i = 0; i < n; i += 6) {
    const f = buf.slice(i * per, (i + 1) * per); let r = 0, g = 0, b = 0, c = 0;
    for (let p = 0; p < per; p += 4) if (f[p + 3] > 8 && (Math.abs(f[p] - 255) > 25 || Math.abs(f[p + 1] - 255) > 25 || Math.abs(f[p + 2] - 255) > 25)) { r += f[p]; g += f[p + 1]; b += f[p + 2]; c++; }
    out.push(c ? '#' + [r, g, b].map(v => Math.round(v / c).toString(16).padStart(2, '0')).join('') : '----');
  }
  fs.unlinkSync(raw);
  return out.join(' ') + `\n  (${out.length} sampel dari ${n} frame)`;
}

(async () => {
  const res = await axios.get(`${process.env.BASE_API}api/maker/attp`, {
    params: { text: 'yapar labs' }, headers: { 'X-API-Key': process.env.KEY_API },
    responseType: 'arraybuffer', timeout: 30000,
  });
  const gif = path.join(os.tmpdir(), `f_in_${Date.now()}.gif`);
  fs.writeFileSync(gif, Buffer.from(res.data));
  const out = path.join(os.tmpdir(), `f_out_${Date.now()}.webp`);
  const { buf } = await videoKeStickerWebp(gif, out, { regang: 12.5, fps: 6, halus: true });
  bedah('ffmpeg output', buf);
  const final = await addStickerExif(buf, process.env.STICKER_PACK_NAME, process.env.STICKER_AUTHOR);
  bedah('setelah EXIF  ', final);
  const fpath = path.join(os.tmpdir(), `f_final_${Date.now()}.webp`);
  fs.writeFileSync(fpath, final);
  console.log('warna tiap ~1 detik:', await warnaPerFrame(fpath));
  fs.unlinkSync(gif); fs.unlinkSync(out); fs.unlinkSync(fpath);
})();
