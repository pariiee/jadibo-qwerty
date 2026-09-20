// Montase 10 frame dari sticker final + dari GIF sumber, buat dilihat mata.
const axios = require('axios'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawnSync } = require('child_process'); require('dotenv').config();
const { videoKeStickerWebp, addStickerExif } = require('./engine/sticker');
(async () => {
  const res = await axios.get(`${process.env.BASE_API}api/maker/attp`, { params: { text: 'yapar labs' },
    headers: { 'X-API-Key': process.env.KEY_API }, responseType: 'arraybuffer', timeout: 30000 });
  const gif = path.join(os.tmpdir(), 'm_in.gif'); fs.writeFileSync(gif, Buffer.from(res.data));
  const out = path.join(os.tmpdir(), 'm_out.webp');
  const { buf } = await videoKeStickerWebp(gif, out, { regang: 12.5, fps: 6, halus: true });
  const final = await addStickerExif(buf, process.env.STICKER_PACK_NAME, process.env.STICKER_AUTHOR);
  const fpath = path.join(os.tmpdir(), 'm_final.webp'); fs.writeFileSync(fpath, final);
  const hasil = path.join(os.tmpdir(), 'montase_final.png');
  let d = spawnSync('ffmpeg', ['-y','-v','error','-i',fpath,'-vf','select=not(mod(n\,6)),scale=180:180,tile=5x2',hasil],{encoding:'utf8'});
  console.log('final:', d.status, String(d.stderr).slice(-150));
  const gifpng = path.join(os.tmpdir(), 'montase_gif.png');
  d = spawnSync('ffmpeg', ['-y','-v','error','-i',gif,'-vf','scale=180:180,tile=5x4',gifpng],{encoding:'utf8'});
  console.log('gif  :', d.status, String(d.stderr).slice(-150));
  console.log(hasil); console.log(gifpng);
})();
