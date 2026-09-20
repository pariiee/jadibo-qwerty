'use strict';

/**
 * engine/stickerPack.js
 * Bikin sticker pack WhatsApp yang beneran (bukan N sticker dikirim beruntun).
 *
 * Yang dikirim WA itu `stickerPackMessage`, dan isinya CUMA 2 file:
 *   1. ZIP (store-only) isi semua sticker + cover  → `fileSha256`/`directPath`
 *   2. thumbnail JPEG 252×252                       → `thumbnail*`
 * Keduanya WAJIB dienkripsi pakai SATU media key yang sama (proto cuma punya
 * satu field `mediaKey`), cuma beda info HKDF-nya. Uploadnya di adapter
 * (`engine/baileys/client.js` → `kirimStickerPack`).
 *
 * Nama file di dalam ZIP = `<base64 sha256 isi> .webp`, cover = `<packId>.webp`
 * dan WAJIB entry pertama — WA baca itu buat gambar tray pack.
 *
 * ponytail: ZIP-nya store-only (sticker udah kompres sendiri) dan ditulis
 * tangan, ~50 baris. Tambah dep zip kalau suatu hari butuh deflate/cek CRC.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const UKURAN_STICKER_PACK = 512;
const UKURAN_TRAY = 252;
// WA nolak pack > 60 sticker (batas WA Web). Minimal di bawah ini bukan aturan
// WA — cuma ambang akal-akalan biar nggak kirim "pack" 1 gambar.
const MIN_STICKER_PACK = 3;
const MAKS_STICKER_PACK = 60;

const KUNCI_ZIP = 'WhatsApp Sticker Pack Keys';
const KUNCI_THUMB = 'WhatsApp Sticker Pack Thumbnail Keys';

const SKALA_PACK = `scale=${UKURAN_STICKER_PACK}:${UKURAN_STICKER_PACK}:force_original_aspect_ratio=decrease,pad=${UKURAN_STICKER_PACK}:${UKURAN_STICKER_PACK}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;

// ─── ZIP store-only ──────────────────────────────────────────────────────────
// Layoutnya nyontek `create_sticker_pack_zip()` whatsapp-rust (wacore/src/zip.rs).
function zipStore(entri) {
  const zlib = require('zlib');
  const lokal = [];
  const pusat = [];
  let offset = 0;
  // jam DOS: cuma dipakai kalau tanggal lokal nggak valid; WA nggak peduli isinya
  const jam = 0;
  const tanggal = 33; // 1980-01-01

  for (const { nama, isi } of entri) {
    const namaBuf = Buffer.from(nama, 'utf8');
    const crc = zlib.crc32(isi);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);            // version needed
    head.writeUInt16LE(0x0800, 6);        // flag: nama UTF-8
    head.writeUInt16LE(0, 8);             // method 0 = store
    head.writeUInt16LE(jam, 10);
    head.writeUInt16LE(tanggal, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(isi.length, 18);   // compressed = ukuran asli
    head.writeUInt32LE(isi.length, 22);
    head.writeUInt16LE(namaBuf.length, 26);
    head.writeUInt16LE(0, 28);            // extra len
    lokal.push(head, namaBuf, isi);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);             // version made by
    dir.writeUInt16LE(20, 6);             // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(jam, 12);
    dir.writeUInt16LE(tanggal, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(isi.length, 20);
    dir.writeUInt32LE(isi.length, 24);
    dir.writeUInt16LE(namaBuf.length, 28);
    dir.writeUInt32LE(offset, 42);        // offset local header
    pusat.push(dir, namaBuf);

    offset += head.length + namaBuf.length + isi.length;
  }

  const cd = Buffer.concat(pusat);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entri.length, 8);
  eocd.writeUInt16LE(entri.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...lokal, cd, eocd]);
}

// ─── Media key ───────────────────────────────────────────────────────────────
// Sama persis kayak expandMediaKey di Baileys, cuma info HKDF-nya yang beda.
// (Sticker pack nggak ada di MEDIA_HKDF_KEY_MAPPING, jadi ditulis sendiri.)
function kunciMedia(mediaKey, info) {
  const { hkdf } = require('baileys');
  const expanded = hkdf(mediaKey, 112, { info });
  return {
    iv: expanded.subarray(0, 16),
    cipherKey: expanded.subarray(16, 48),
    macKey: expanded.subarray(48, 80),
  };
}

// AES-256-CBC + MAC 10 byte. Ini yang bikin pack/thumbnail diterima WA:
// 10 byte terakhir body = HMAC-SHA256(iv‖body)[:10].
function enkripsi(plain, kunci) {
  const c = require('crypto');
  const iv = c.randomBytes(16);
  const cipher = c.createCipheriv('aes-256-cbc', kunci.cipherKey, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = c.createHmac('sha256', kunci.macKey).update(iv).update(body).digest().subarray(0, 10);
  // Yang diupload WA: iv ‖ ciphertext ‖ mac(10) — receiver motong 16 depan + 10 belakang.
  return { isi: Buffer.concat([iv, body, mac]), iv, body, mac };
}

// ─── Ukuran & animasi WebP dari header (nggak perlu ffmpeg/sharp) ────────────
// Dipakai buat skip ffmpeg kalau stickernya udah 512×512 — di VPS ffmpeg 6.1
// nggak bisa decode WebP bergerak, jadi makin jarang dipanggil makin aman.
function ukuranWebp(buf) {
  const chunk = buf.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8X') {
    // Flag bit 0x02 di byte pertama VP8X = ada animasi (cara WA Web).
    // Ngecek chunk `ANIM` juga bisa, tapi flag ini yang dipakai referensi.
    return {
      w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3),
      animasi: (buf[20] & 0x02) !== 0,
    };
  }
  if (chunk === 'VP8 ') { // lossy
    return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff, animasi: false };
  }
  if (chunk === 'VP8L') { // lossless
    const b = buf.readUInt32LE(21);
    return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1, animasi: false };
  }
  return null;
}

// ─── Rakit pack ──────────────────────────────────────────────────────────────
// `sticker`: [{ isi: Buffer, emoji?: string }] — sudah WebP (isi = apa adanya
// dari Telegram; WA baca dari ZIP, jadi EXIF packname nggak perlu).
// WA minta minimal 3 sticker, dan nama file DI DALAM ZIP itu yang jadi identitas
// sticker (`<base64 sha256 isi>.webp`), bukan dedupe list di proto.
async function buatPaketSticker(sticker, { nama = 'Sticker Pack', packId = crypto.randomUUID() } = {}) {
  if (sticker.length < MIN_STICKER_PACK) {
    throw new Error(`Pack WhatsApp minimal ${MIN_STICKER_PACK} sticker (dapet ${sticker.length})`);
  }
  if (sticker.length > MAKS_STICKER_PACK) sticker = sticker.slice(0, MAKS_STICKER_PACK);

  const ff = (args) => new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit code ${code}`))));
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack_'));
  try {
    const berkas = [];
    const sudah = new Map(); // nama entry ZIP → isi (nama = identitas unik sticker)
    for (let i = 0; i < sticker.length; i++) {
      const isi0 = sticker[i].isi;
      const uk = ukuranWebp(isi0);
      let isi = isi0;
      // Banyak sticker Telegram udah persis 512×512 — kalau iya, kirim apa adanya.
      if (!uk || uk.w !== UKURAN_STICKER_PACK || uk.h !== UKURAN_STICKER_PACK) {
        const urut = String(i).padStart(3, '0');
        const masuk = path.join(dir, `in_${urut}.webp`);
        const keluar = path.join(dir, `s_${urut}.webp`);
        fs.writeFileSync(masuk, isi0);
        // Canvas WAJIB 512×512 (sama kayak sticker biasa) — WA nolak ukuran lain.
        await ff(['-i', masuk, '-vf', SKALA_PACK, '-c:v', 'libwebp', keluar]);
        isi = fs.readFileSync(keluar);
      }
      const nama = crypto.createHash('sha256').update(isi).digest('base64url') + '.webp';
      // ZIP cuma boleh punya SATU entry per nama; sticker kembar tetap masuk
      // proto (tray di HP nampil N), file-nya cukup sekali.
      if (!sudah.has(nama)) sudah.set(nama, isi);
      berkas.push({
        nama,
        isAnimated: uk ? uk.animasi : (isi[20] & 0x02) !== 0,
        emoji: sticker[i].emoji || '',
      });
    }

    // Cover WAJIB entry pertama di ZIP — WA pakai itu buat gambar tray pack.
    // Sumbernya sticker pertama hasil normalisasi.
    const coverIsi = sudah.get(berkas[0].nama);
    const coverMasuk = path.join(dir, 'cover_src.webp');
    fs.writeFileSync(coverMasuk, coverIsi);
    const coverPath = path.join(dir, 'cover.jpg');
    await ff(['-i', coverMasuk,
      '-vf', `scale=${UKURAN_TRAY}:${UKURAN_TRAY}:force_original_aspect_ratio=increase,crop=${UKURAN_TRAY}:${UKURAN_TRAY}`,
      '-q:v', '5', coverPath]);

    const stickerPack = zipStore([
      { nama: `${packId}.webp`, isi: coverIsi },
      ...[...sudah.entries()].map(([nama, isi]) => ({ nama, isi })),
    ]);
    const thumbPack = fs.readFileSync(coverPath);

    return {
      zip: stickerPack, thumb: thumbPack, packId,
      nama: String(nama).slice(0, 128),
      // `emojis` cuma buat label di HP, dan user contohin `emojis: [""]` — kalau
      // emoji Telegram-nya string kosong, kirim array kosong aja.
      sticker: berkas.map((b) => ({
        fileName: b.nama, isAnimated: b.isAnimated, isLottie: false,
        mimetype: 'image/webp', accessibilityLabel: '',
        emojis: b.emoji ? [b.emoji] : [],
      })),
    };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = {
  buatPaketSticker, ukuranWebp, zipStore,
  // dipakai test/album-sticker.js buat ngecek kunci & enkripsi
  kunciMedia, enkripsi, KUNCI_ZIP, KUNCI_THUMB,
  UKURAN_TRAY, UKURAN_STICKER_PACK, MIN_STICKER_PACK, MAKS_STICKER_PACK, SKALA_PACK,
};