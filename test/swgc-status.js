// .swgc — status grup nggak jadi walau emoji centang nongol.
// Bentuk proto-nya nyontek refrensi-botz/plugins/owner-upswtag.js:
// messageSecret 32 byte DI DALAM groupStatusMessageV2.message.
const assert = require('node:assert');
const { groupStatusContent } = require('../engine/baileys/client');

let gagal = 0;
const ok = (nama, fn) => {
  try { fn(); console.log(`  PASS  ${nama}`); }
  catch (e) { gagal++; console.log(`  FAIL  ${nama}\n        ${e.message}`); }
};

(async () => {
  const TEKS = groupStatusContent({ extendedTextMessage: { text: 'test' } });

  // Gejala: `.swgc test` keluar teks biasa, bukan status. Sekarang teksnya
  // harus nyempil di dalam envelope, bukan di top-level.
  ok('teks dibungkus groupStatusMessageV2', () =>
    assert.equal(TEKS.groupStatusMessageV2?.message?.extendedTextMessage?.text, 'test'));
  ok('teks nggak bocor ke top-level', () =>
    assert.equal(TEKS.extendedTextMessage, undefined));

  for (const [tipe, key] of [['foto', 'imageMessage'], ['video', 'videoMessage']]) {
    const s = groupStatusContent({
      [key]: { url: 'https://x/y', mimetype: tipe === 'video' ? 'video/mp4' : 'image/jpeg', mediaKey: Buffer.alloc(32) },
    });
    const dalam = s.groupStatusMessageV2?.message;

    // Inti fix: WA nolak diem-diem (nggak ada error, centang tetap nongol)
    // kalau messageSecret nggak ada. 32 byte, di dalam envelope.
    ok(`${tipe}: messageSecret 32 byte di dalam`, () =>
      assert.equal(dalam?.messageContextInfo?.messageSecret?.length, 32));
    ok(`${tipe}: medianya ikut`, () => assert.ok(dalam?.[key]));
    // Kalau media nongkrong di top-level, WA baca ini sebagai media biasa —
    // bukan status grup. Justru itu yang bikin "jatuh jadi pesan teks".
    ok(`${tipe}: media nggak di top-level`, () =>
      assert.equal(s[key], undefined));
  }

  const beda = new Set([
    groupStatusContent({ extendedTextMessage: { text: 'a' } }).groupStatusMessageV2.message.messageContextInfo.messageSecret?.toString('hex'),
    groupStatusContent({ extendedTextMessage: { text: 'a' } }).groupStatusMessageV2.message.messageContextInfo.messageSecret?.toString('hex'),
  ]);
  ok('secret diacak tiap kirim (bukan konstanta)', () => assert.equal(beda.size, 2));

  console.log(gagal ? `\nswgc-status: ${gagal} FAIL` : '\nswgc-status: semua PASS');
  process.exit(gagal ? 1 : 0);
})();
