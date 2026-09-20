// Cek ZIP pack pakai PARSER ORANG LAIN (python zipfile), bukan parser sendiri —
// ZIP-nya ditulis tangan, jadi kalau strukturnya salah WA bakal nampilin kosong.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buatPaketSticker } = require('../engine/stickerPack');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zipcek_'));
const warna = ['red', 'green', 'blue', 'orange'];
const sticker = warna.map((w, i) => {
  const out = path.join(dir, `s${i}.webp`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', `color=${w}:size=512x512`, '-frames:v', '1', out]);
  return { isi: fs.readFileSync(out), emoji: '😀' };
});

(async () => {
  const pack = await buatPaketSticker(sticker, { nama: 'Zip Cek', packId: '11111111-2222-3333-4444-555555555555' });
  const zipPath = path.join(dir, 'pack.zip');
  fs.writeFileSync(zipPath, pack.zip);
  const py = String.raw`
import zipfile, sys, hashlib, base64
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
assert bad is None, "CRC rusak di " + str(bad)
names = z.namelist()
print("entry:", len(names))
print("pertama:", names[0])
for n in names:
    d = z.read(n)
    assert d[:4] == b"RIFF" and d[8:12] == b"WEBP", n + " bukan webp"
    if not n.endswith(".webp") or n == names[0]:
        continue
    want = base64.urlsafe_b64encode(hashlib.sha256(d).digest()).decode().rstrip("=") + ".webp"
    assert n == want, n + " != " + want
print("OK python zipfile: semua entry kebaca, CRC valid, nama = base64url(sha256)")
`;
  fs.writeFileSync(path.join(dir, 'cek.py'), py);
  console.log(execFileSync('C:/Users/gabut/AppData/Local/Programs/Python/Python314/python.exe',
    [path.join(dir, 'cek.py'), zipPath]).toString().trim());
  fs.rmSync(dir, { recursive: true, force: true });
})();
