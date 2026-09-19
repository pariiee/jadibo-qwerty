// Kunci bug ".swgc jadi teks doang". Jalankan: node test/swgc-media.js
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');
const c = require('../engine/baileys/client.js');

let gagal = 0;
const ok = (nama, fn) => {
  try { fn(); console.log('  PASS  ' + nama); }
  catch (e) { console.log('  FAIL  ' + nama + ' -> ' + e.message); gagal++; }
};

(async () => {
  // Socket palsu: upload nggak nyentuh jaringan, relayMessage cuma dicatat.
  let relayed = null;
  let uploads = 0;
  const klien = c.createClient({ auth: { creds: {}, keys: {} }, saveCreds: () => {} });
  klien.__setSockUntukTes({
    logger: console,
    relayMessage: async (jid, msg) => { relayed = { jid, msg }; return 'ok'; },
    waUploadToServer: async () => { uploads++; return { url: 'https://x/y', directPath: '/y' }; },
  });

  // ── 1. Konten media ASLI lewat relayStatusGrup -> diterima WA ─────────────
  const buf = nodeCrypto.randomBytes(4096);
  const { videoMessage } = await klien.message.prepareMedia(buf, { type: 'video', mimetype: 'video/mp4' });
  ok('prepareMedia: video punya mediaKey (bukan video kosong)', () => assert.ok(videoMessage.mediaKey));

  await klien.message.relayStatusGrup('123@g.us', { videoMessage });
  ok('relayStatusGrup: envelope dibungkus groupStatusMessageV2', () =>
    assert.ok(relayed?.msg?.groupStatusMessageV2?.message?.videoMessage));
  ok('relayStatusGrup: video + mediaSecret masih utuh di dalam', () =>
    assert.ok(relayed.msg.groupStatusMessageV2.message.videoMessage.mediaKey));

  // ── 2. Video KOSONG (tanpa mediaKey) -> DITOLAK, bukan dikirim diam-diam ──
  relayed = null;
  await assert.rejects(
    () => klien.message.relayStatusGrup('123@g.us', { videoMessage: { mimetype: 'video/mp4' } }),
    /mediaKey/,
  );
  ok('relayStatusGrup: video tanpa mediaKey ditolak (ini yg dulu senyap)', () =>
    assert.strictEqual(relayed, null));

  // ── 3. downloadBytes: sumber teks DITOLAK, bukan cari pesan lain ──────────
  await assert.rejects(
    () => klien.message.downloadBytes({ conversation: '.swgc test' }),
    /bukan media|not a media/i,
  );
  await assert.rejects(
    () => klien.message.downloadBytes('.swgc test'),
    /bukan media|not a media/i,
  );
  ok('downloadBytes: sumber teks ditolak tegas (dulu fallback ke pesan terakhir)', () => {});

  console.log(gagal ? '\nswgc-media: ' + gagal + ' GAGAL' : '\nswgc-media: semua PASS');
  process.exit(gagal ? 1 : 0);
})();
