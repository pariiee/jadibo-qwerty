'use strict';
// .brat "abu kaya kosong" = teks kekecilan di canvas 512. assert: setelah
// gambarKeStickerWebp(), objek harus ngisi frame jauh lebih banyak.
const assert = require('assert');
const sharp = require('sharp');
const { gambarKeStickerWebp, UKURAN_STICKER } = require('../engine/sticker');

// Tinta = pixel gelap. Simetris sama cara WA nampilin sticker.
async function tinta(buf) {
  const { data } = await sharp(buf).ensureAlpha().flatten({ background: '#fff' })
    .greyscale().raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (const v of data) if (v < 250) n++;
  return n / data.length * 100;
}

// Sumber tiruan kayak BE brat: objek kecil di tengah canvas 500×500 putih.
const sumber = async () => sharp({ create: { width: 500, height: 500, channels: 3, background: '#fff' } })
  .composite([{
    input: await sharp({ create: { width: 179, height: 91, channels: 3, background: '#000' } }).png().toBuffer(),
    top: 42, left: 45,
  }]).png().toBuffer();

(async () => {
  const png = await sumber();

  // pembanding: pipeline LAMA (resize contain, background transparan)
  const lama = await sharp(png)
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 90 }).toBuffer();
  const tintaLama = await tinta(lama);

  const hasil = await gambarKeStickerWebp(png);
  const m = await sharp(hasil).metadata();
  const tintaBaru = await tinta(hasil);

  const cek = (nama, ok) => console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${nama}`);
  let gagal = 0;
  const assert2 = (nama, ok) => { if (!ok) gagal++; cek(nama, ok); };

  assert.strictEqual(m.width, UKURAN_STICKER, 'lebar harus 512');
  assert.strictEqual(m.height, UKURAN_STICKER, 'tinggi harus 512');
  assert.strictEqual(m.format, 'webp');
  assert2('canvas persis 512x512 (WA tolak selain ini)', m.width === 512 && m.height === 512);

  // Inti bug: teks kekecilan. Harus naik jauh, bukan cuma beda tipis.
  assert2(`objek ngisi frame: tinta ${tintaLama.toFixed(1)}% -> ${tintaBaru.toFixed(1)}% (naik >=5x)`,
    tintaBaru >= tintaLama * 5);
  assert2(`tinta akhir > 15% (sekarang ~2,9%, harus ~23%)`, tintaBaru > 15);

  // contain: objek utuh. Buktinya RASIO bbox nggak berubah (kalau di-`cover`,
  // sisi yang nggak muat dipotong → rasio melenceng).
  const { data, info } = await sharp(hasil).flatten({ background: '#fff' }).greyscale()
    .raw().toBuffer({ resolveWithObject: true });
  let x0 = info.width, y0 = info.height, x1 = -1, y1 = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if (data[y * info.width + x] < 128) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  assert2('objek kelihatan (ada pixel gelap)', x1 >= 0);
  const rasioAsal = 179 / 91, rasioHasil = (x1 - x0 + 1) / (y1 - y0 + 1);
  assert2(`rasio objek utuh ${rasioAsal.toFixed(2)} vs ${rasioHasil.toFixed(2)} (bukan di-cover/crop)`,
    Math.abs(rasioAsal - rasioHasil) / rasioAsal < 0.03);

  if (gagal) { console.error(`sticker-brat: GAGAL ${gagal} assert`); process.exit(1); }
  console.log(`sticker-brat: PASS — tinta ${tintaLama.toFixed(1)}% -> ${tintaBaru.toFixed(1)}%, 512x512, objek utuh`);
})();
