// Baca sticker final pakai sharp (libvips/libwebp) — pendekatan dekoder keluarga yang sama dgn WA.
const fs = require('fs'); const path = require('path'); const os = require('os');
const axios = require('axios'); require('dotenv').config();
const { videoKeStickerWebp, addStickerExif } = require('./engine/sticker');
(async () => {
  const res = await axios.get(`${process.env.BASE_API}api/maker/attp`, { params: { text: 'yapar labs' },
    headers: { 'X-API-Key': process.env.KEY_API }, responseType: 'arraybuffer', timeout: 30000 });
  const gif = path.join(os.tmpdir(), 's_in.gif'); fs.writeFileSync(gif, Buffer.from(res.data));
  const out = path.join(os.tmpdir(), 's_out.webp');
  const { buf } = await videoKeStickerWebp(gif, out, { regang: 12.5, fps: 6, halus: true });
  const final = await addStickerExif(buf, process.env.STICKER_PACK_NAME, process.env.STICKER_AUTHOR);
  const f = path.join(os.tmpdir(), 's_final.webp'); fs.writeFileSync(f, final);
  const sharp = require('sharp');
  const meta = await sharp(f, { animated: true }).metadata();
  console.log('sharp meta:', JSON.stringify({ width: meta.width, height: meta.height, pages: meta.pages, delay: meta.delay ? meta.delay.slice(0, 5) : null, loop: meta.loop, format: meta.format, hasAlpha: meta.hasAlpha }));
  const { data, info } = await sharp(f, { animated: true }).raw().toBuffer({ resolveWithObject: true });
  const per = info.width * info.height * info.channels;
  const n = info.pages || Math.floor(data.length / per);
  console.log('frame terdekode sharp:', n, 'channels', info.channels);
  const warna = [];
  for (let i = 0; i < n; i += 6) {
    const f2 = data.slice(i * per, (i + 1) * per); let r = 0, g = 0, b = 0, c = 0;
    for (let p = 0; p < per; p += info.channels) {
      const a = info.channels === 4 ? f2[p + 3] : 255;
      if (a > 8 && (Math.abs(f2[p] - 255) > 25 || Math.abs(f2[p + 1] - 255) > 25 || Math.abs(f2[p + 2] - 255) > 25)) { r += f2[p]; g += f2[p + 1]; b += f2[p + 2]; c++; }
    }
    warna.push(c ? '#' + [r, g, b].map(v => Math.round(v / c).toString(16).padStart(2, '0')).join('') : '----');
  }
  console.log('warna per ~1 detik (dekoder libwebp):', warna.join(' '));
})();
