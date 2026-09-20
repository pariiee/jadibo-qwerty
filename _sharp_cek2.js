// Banding alpha + warna frame: file SEBELUM EXIF vs SESUDAH EXIF. Slicing per halaman (512x512).
const fs = require('fs'); const path = require('path'); const os = require('os');
const axios = require('axios'); require('dotenv').config();
const sharp = require('sharp');
const { videoKeStickerWebp, addStickerExif } = require('./engine/sticker');

async function bedah(label, file) {
  const meta = await sharp(file, { animated: true }).metadata();
  const { data, info } = await sharp(file, { animated: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const S = 512, per = S * S * 4, pages = Math.floor(info.height / S);
  const warna = [], alpha = [];
  for (let i = 0; i < pages; i++) {
    const f = data.slice(i * per, (i + 1) * per);
    let r = 0, g = 0, b = 0, c = 0, transparan = 0;
    for (let p = 0; p < per; p += 4) {
      if (f[p + 3] < 8) { transparan++; continue; }
      if (Math.abs(f[p] - 255) > 25 || Math.abs(f[p + 1] - 255) > 25 || Math.abs(f[p + 2] - 255) > 25) { r += f[p]; g += f[p + 1]; b += f[p + 2]; c++; }
    }
    warna.push(c ? '#' + [r, g, b].map(v => Math.round(v / c).toString(16).padStart(2, '0')).join('') : '----');
    alpha.push(Math.round(transparan / (per / 4) * 100));
  }
  console.log(`${label}: pages ${pages} hasAlphaMeta=${meta.hasAlpha} channels=${info.channels} loop=${meta.loop} delay0=${meta.delay && meta.delay[0]}`);
  console.log(`  warna/1s : ${warna.filter((_, i) => i % 6 === 0).join(' ')}`);
  console.log(`  %transparan (frame 0,10,20,30,40,50): ${[0,10,20,30,40,50].map(i => alpha[i]).join(' ')}`);
  const px = [];
  for (const [x, y] of [[10, 10], [256, 256], [100, 400]]) {
    const o = (256 * S + x) * 4;
    px.push(`(${x},${y})=rgba(${data[o]},${data[o+1]},${data[o+2]},${data[o+3]})`);
  }
  console.log(`  piksel frame 30: ${px.join(' ')}`);
}

(async () => {
  const res = await axios.get(`${process.env.BASE_API}api/maker/attp`, { params: { text: 'yapar labs' },
    headers: { 'X-API-Key': process.env.KEY_API }, responseType: 'arraybuffer', timeout: 30000 });
  const gif = path.join(os.tmpdir(), 's2_in.gif'); fs.writeFileSync(gif, Buffer.from(res.data));
  const out = path.join(os.tmpdir(), 's2_out.webp');
  const { buf } = await videoKeStickerWebp(gif, out, { regang: 12.5, fps: 6, halus: true });
  await bedah('SEBELUM EXIF', out);
  const final = await addStickerExif(buf, process.env.STICKER_PACK_NAME, process.env.STICKER_AUTHOR);
  const f2 = path.join(os.tmpdir(), 's2_final.webp'); fs.writeFileSync(f2, final);
  await bedah('SESUDAH EXIF', f2);
  // pembanding: GIF sumber
  await bedah('GIF SUMBER  ', gif);
})();
