'use strict';

// Bukti format pack (bukan cuma "kodenya jalan"):
// 1. ZIP store-only isi cover + N sticker, nama file = base64(sha256 isi).webp
// 2. thumbnail JPEG 252×252
// 3. media key: dua info HKDF beda → kunci beda; enkripsi diakhiri MAC 10 byte
const assert = require('assert');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const {
  buatPaketSticker, ukuranWebp, kunciMedia, enkripsi, zipStore, bagiSticker,
  UKURAN_TRAY, KUNCI_ZIP, KUNCI_THUMB,
} = require('../engine/stickerPack');

// Baca central directory ZIP (offset 0, cuma buat entry terakhir) — pembaca
// independen dari zipStore(), jadi kalau writer-nya salah, ini yang gagal.
function bacaZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, 'EOCD ZIP nggak ketemu');
  const jumlah = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < jumlah; i++) {
    assert.strictEqual(buf.readUInt32LE(p), 0x02014b50, 'signature central directory salah');
    const metode = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const ukuran = buf.readUInt32LE(p + 24);
    const namaLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const komentarLen = buf.readUInt16LE(p + 32);
    const lokal = buf.readUInt32LE(p + 42);
    const nama = buf.subarray(p + 46, p + 46 + namaLen).toString();
    const ukuranLokal = buf.readUInt32LE(lokal + 22);
    const namaLokal = buf.readUInt16LE(lokal + 26);
    const extraLokal = buf.readUInt16LE(lokal + 28);
    const isi = buf.subarray(lokal + 30 + namaLokal + extraLokal, lokal + 30 + namaLokal + extraLokal + ukuranLokal);
    out.push({ nama, metode, crc, ukuran, isi, namaLokal, extraLokal });
    p += 46 + namaLen + extraLen + komentarLen;
  }
  return out;
}

(async () => {
  // Sticker palsu tapi valid: ffmpeg bikin 2 WebP 512×512 + 1 bergerak.
  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'uji_pack_'));
  const ff = (args) => {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    assert.strictEqual(r.status, 0, 'ffmpeg gagal: ' + r.stderr);
  };
  const sumber = [];
  const warna = ['1e90ff', 'ff8c00', '32cd32'];
  for (let i = 0; i < 3; i++) {
    const f = require('path').join(dir, `u${i}.webp`);
    // warna beda biar sha256-nya beda (kalau sama, ZIP bakal punya nama duplikat)
    ff(['-f', 'lavfi', '-i', `color=c=0x${warna[i]}:s=512x512:d=1`,
      '-frames:v', '1', '-c:v', 'libwebp', f]);
    sumber.push({ isi: require('fs').readFileSync(f), emoji: ['😋', '', '😎'][i] });
  }
  // Ke-4 sengaja NON-512 → wajib lewat ffmpeg (pad transparan ke 512×512).
  const kecil = require('path').join(dir, 'kecil.webp');
  ff(['-f', 'lavfi', '-i', 'color=c=0xff00ff:s=300x200:d=1', '-frames:v', '1', '-c:v', 'libwebp', kecil]);
  sumber.push({ isi: require('fs').readFileSync(kecil), emoji: '😴' });
  assert.deepStrictEqual(ukuranWebp(sumber[0].isi), { w: 512, h: 512, animasi: false },
    'ukuranWebp harus baca 512×512 dari header');
  assert.strictEqual(ukuranWebp(sumber[3].isi).w, 300, 'ukuranWebp harus baca 300 dari header');

  const packId = 'c3bc2239-1da7-40a4-a75f-c1ccc3e3da46';
  const pack = await buatPaketSticker(sumber, { nama: 'uji pack', packId });

  // 1. ZIP — 1 cover + 4 sticker
  const isiZip = bacaZip(pack.zip);
  assert.strictEqual(isiZip.length, 5, 'harus 5 entry: cover + 4 sticker');
  assert.strictEqual(isiZip[0].nama, `${packId}.webp`, 'cover wajib entry pertama');
  assert.deepStrictEqual(isiZip.map((e) => e.metode), [0, 0, 0, 0, 0], 'zip harus store-only (method 0)');
  assert.strictEqual(isiZip.length, new Set(isiZip.map((e) => e.nama)).size, 'nama entry ZIP harus unik');
  for (const e of isiZip) {
    assert.strictEqual(e.ukuran, e.isi.length, `${e.nama}: ukuran lokal != ukuran pusat`);
    assert.strictEqual(e.crc, require('zlib').crc32(e.isi) >>> 0, `${e.nama}: CRC salah`);
    assert.ok(e.isi.subarray(0, 4).toString() === 'RIFF' && e.isi.subarray(8, 12).toString() === 'WEBP',
      `${e.nama}: isinya bukan WebP`);
    assert.ok(/^[A-Za-z0-9_-]+\.webp$/.test(e.nama) || e.nama === `${packId}.webp`,
      `${e.nama}: nama harus base64url TANPA padding + .webp`);
  }
  // Yang udah 512×512 harus dikirim APA ADANYA (ffmpeg 6.1 di VPS nggak bisa
  // decode WebP bergerak — jadi jangan lewat ffmpeg kalau nggak perlu).
  for (let i = 0; i < 3; i++) {
    assert.ok(isiZip[1 + i].isi.equals(sumber[i].isi), `sticker ${i} 512×512 kena re-encode ffmpeg`);
  }
  // Yang 300×200 wajib dipad ke 512×512 oleh ffmpeg.
  assert.deepStrictEqual(
    { w: ukuranWebp(isiZip[4].isi).w, h: ukuranWebp(isiZip[4].isi).h }, { w: 512, h: 512 },
    'sticker non-512 harus dipad jadi 512×512');
  assert.deepStrictEqual(pack.sticker.map((s) => s.fileName), isiZip.slice(1).map((e) => e.nama),
    'fileName di proto harus sama dengan nama di ZIP');
  for (const s of pack.sticker) {
    const cari = isiZip.find((e) => e.nama === s.fileName);
    assert.strictEqual(s.fileName, crypto.createHash('sha256').update(cari.isi).digest('base64url') + '.webp',
      'nama file harus base64url(sha256 isi).webp');
  }
  assert.strictEqual(pack.sticker[0].isAnimated, false, 'WebP diam harus isAnimated:false');
  assert.deepStrictEqual(pack.sticker[1].emojis, [], 'emoji kosong → array kosong (bukan [""])');

  // 2. Thumbnail 252×252 JPEG
  assert.strictEqual(pack.thumb[0], 0xff, 'thumbnail harus JPEG');
  assert.strictEqual(pack.thumb[1], 0xd8, 'thumbnail harus JPEG');

  // Dedupe: isi sama → nama ZIP sama → file-nya cukup sekali di ZIP, tapi
  // sticker kembar TETAP masuk proto (tray di HP nampil 5, bukan 4).
  const kembar = sumber.concat([{ isi: sumber[0].isi, emoji: '🔁' }]);
  const packDedupe = await buatPaketSticker(kembar, { nama: 'dedupe', packId });
  assert.strictEqual(packDedupe.sticker.length, 5, 'sticker kembar tetap masuk proto');
  assert.strictEqual(bacaZip(packDedupe.zip).length, 5, 'ZIP: cover + 4 file unik');
  assert.strictEqual(packDedupe.sticker[4].fileName, packDedupe.sticker[0].fileName,
    'sticker kembar nunjuk file yang sama');

  // 3. Media key
  const mediaKey = crypto.randomBytes(32);
  const k1 = kunciMedia(mediaKey, KUNCI_ZIP);
  const k2 = kunciMedia(mediaKey, KUNCI_THUMB);
  assert.notDeepStrictEqual(k1.cipherKey, k2.cipherKey, 'zip & thumbnail harus kunci beda');
  assert.notDeepStrictEqual(k1.iv, k2.iv, 'zip & thumbnail harus IV beda');
  const e1 = enkripsi(Buffer.from('tes'), k1);
  assert.ok(e1.iv.equals(k1.iv), 'IV wajib turunan mediaKey, bukan acak');
  assert.strictEqual(e1.body.length % 16, 0, 'CBC harus kelipatan 16');
  const harap = crypto.createHmac('sha256', k1.macKey).update(e1.iv).update(e1.body).digest().subarray(0, 10);
  assert.ok(e1.mac.equals(harap), 'MAC 10 byte salah');
  assert.strictEqual(e1.isi.length, e1.body.length + 10, 'isi = ciphertext + mac (IV nggak ikut)');
  assert.ok(e1.isi.subarray(0, e1.body.length).equals(e1.body), 'ciphertext harus di depan');
  assert.ok(e1.isi.subarray(-10).equals(e1.mac), '10 byte terakhir = MAC');
  // Regresi rt 207: IV pernah ikut ke-upload → WA baca ZIP geser 16 byte → pack kosong.
  const balik = crypto.createDecipheriv('aes-256-cbc', k1.cipherKey, e1.iv);
  assert.strictEqual(Buffer.concat([balik.update(e1.isi.subarray(0, -10)), balik.final()]).toString(), 'tes',
    'isi yang diupload harus bisa didekripsi pakai IV turunan mediaKey');

  // 3b. SIMULASI PENERIMA (WA): cuma modal mediaKey. MAC harus cocok dan header
  // ZIP harus ADA DI OFFSET 0 — inilah yang bikin pack kepakai, bukan blank.
  const mk = crypto.randomBytes(32);
  const kz = kunciMedia(mk, KUNCI_ZIP);
  const encZip = enkripsi(pack.zip, kz);
  const mkUlang = kunciMedia(mk, KUNCI_ZIP); // receiver hitung sendiri dari mediaKey
  const macUlang = crypto.createHmac('sha256', mkUlang.macKey)
    .update(mkUlang.iv).update(encZip.isi.subarray(0, -10)).digest().subarray(0, 10);
  assert.ok(macUlang.equals(encZip.isi.subarray(-10)), 'MAC penerima nggak cocok');
  const dZip = crypto.createDecipheriv('aes-256-cbc', mkUlang.cipherKey, mkUlang.iv);
  const plainUlang = Buffer.concat([dZip.update(encZip.isi.subarray(0, -10)), dZip.final()]);
  assert.strictEqual(plainUlang.subarray(0, 4).toString('hex'), '504b0304',
    'penerima harus lihat header ZIP di offset 0');
  assert.ok(plainUlang.equals(pack.zip), 'hasil dekripsi penerima != ZIP asli');

  // 4. Cover lama masih jalan (kode lama nggak boleh ikut rusak)
  const zip = zipStore([{ nama: 'a.txt', isi: Buffer.from('hai') }]);
  assert.strictEqual(zip.subarray(0, 4).toString('hex'), '504b0304', 'local header ZIP salah');
  assert.strictEqual(bacaZip(zip)[0].crc, require('zlib').crc32(Buffer.from('hai')) >>> 0);

  assert.strictEqual(UKURAN_TRAY, 252, 'tray WA 252px');

  // 5. Pecah pack: WA batas 60 per pack → 130 sticker = 3 kartu (60/60/10)
  const urut = (n) => Array.from({ length: n }, (_, i) => i);
  assert.deepStrictEqual(bagiSticker(urut(130)).map((b) => b.length), [60, 60, 10], '130 → 60/60/10');
  assert.deepStrictEqual(bagiSticker(urut(60)).map((b) => b.length), [60], 'pas 60 → 1 pack');
  assert.deepStrictEqual(bagiSticker(urut(61)).map((b) => b.length), [60, 1], '61 → 60 + 1');
  assert.deepStrictEqual(bagiSticker(urut(5)).map((b) => b.length), [5], 'di bawah batas → 1 pack');
  assert.deepStrictEqual(bagiSticker(urut(130)).flat(), urut(130), 'urutan sticker nggak boleh berubah');

  require('fs').rmSync(dir, { recursive: true, force: true });
  console.log(`OK pack ${pack.zip.length}B ${pack.sticker.length} sticker tray ${pack.thumb.length}B`);
  console.log(`OK ZIP ${isiZip.map((e) => e.nama.slice(0, 10)).join(' | ')}`);
})().catch((e) => { console.error('GAGAL:', e.message); process.exit(1); });
