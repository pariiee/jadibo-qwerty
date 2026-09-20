// Warna teks TIAP frame GIF asli dari API (bukan hasil olahan) + jumlah frame/delay.
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
require('dotenv').config();

(async () => {
  const res = await axios.get(`${process.env.BASE_API}api/maker/attp`, {
    params: { text: 'yapar labs' },
    headers: { 'X-API-Key': process.env.KEY_API },
    responseType: 'arraybuffer', timeout: 30000,
  });
  console.log('content-type:', res.headers['content-type'], '| bytes:', res.data.byteLength);
  console.log('magic:', Buffer.from(res.data).slice(0, 6).toString('ascii').replace(/[^\x20-\x7e]/g, '.'), '| hex:', Buffer.from(res.data).slice(0, 12).toString('hex'));
  const gif = path.join(os.tmpdir(), `src_${Date.now()}.gif`);
  fs.writeFileSync(gif, Buffer.from(res.data));

  const raw = path.join(os.tmpdir(), `src_${Date.now()}.rgba`);
  const d = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', gif, '-f', 'rawvideo', '-pix_fmt', 'rgba', raw], { encoding: 'utf8' });
  if (d.status !== 0) { console.log('decode gagal:', String(d.stderr).slice(-200)); return; }
  const buf = fs.readFileSync(raw);
  const W = 512, H = 512, per = W * H * 4, n = Math.floor(buf.length / per);
  console.log('frame terdekode:', n);
  const warna = [];
  for (let i = 0; i < n; i++) {
    const f = buf.slice(i * per, (i + 1) * per);
    let r = 0, g = 0, b = 0, c = 0;
    for (let p = 0; p < per; p += 4) {
      if (f[p + 3] > 8 && (Math.abs(f[p] - 255) > 25 || Math.abs(f[p + 1] - 255) > 25 || Math.abs(f[p + 2] - 255) > 25)) {
        r += f[p]; g += f[p + 1]; b += f[p + 2]; c++;
      }
    }
    warna.push((c ? '#' + [r, g, b].map(v => Math.round(v / c).toString(16).padStart(2, '0')).join('') : '----') + `(${c})`);
  }
  console.log('warna teks per frame:');
  console.log('  ' + warna.join(' '));
  fs.unlinkSync(gif); fs.unlinkSync(raw);
})();
