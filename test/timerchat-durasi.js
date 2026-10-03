'use strict';
/**
 * test/timerchat-durasi.js
 * `.timerchat <durasi>` — parser durasi + jalur sampe ke zapo.
 *
 * Satuan: d=detik, m=menit, j=jam, h=hari. Tanpa satuan = menit.
 * Ini yang gampang salah: `1d` HARUS 1 detik (bukan 1 hari) dan `1h` HARUS
 * 86400 (bukan 1 jam) — kebalik, dan WA bakal nolak durasi nggak wajar.
 *
 * Jalankan: node test/timerchat-durasi.js
 */
const assert = require('assert');
const A = require('../engine/zapo/client');

// ── 1. Adapter: setEphemeral -> zapo group.setEphemeralDuration ──────────────
const GRUP = '628123456789-1612345678@g.us';
const ADMIN = '628999888777@s.whatsapp.net';
const BOT = '628111222333@s.whatsapp.net';
const dipanggil = [];

const zapoPalsu = {
  on: () => {}, message: {}, stores: {},
  getCredentials: () => ({ meJid: BOT }),
  group: {
    setEphemeralDuration: async (groupJid, detik) => {
      if (!Number.isSafeInteger(detik) || detik < 0) throw new Error(`invalid expirationSeconds: ${detik}`);
      dipanggil.push({ groupJid, detik });
    },
    queryGroupMetadata: async () => ({ announce: false, participants: [{ jid: BOT, isAdmin: true }, { jid: ADMIN, isAdmin: true }] }),
  },
};

const { client } = A.createClient({ client: zapoPalsu, botJid: BOT });
const handler = require('../plugins/02-group');

const terkirim = [];
const buatCtx = (arg) => ({
  command: 'timerchat', args: arg === undefined ? [] : [arg],
  isCmd: true, isGroup: true, isAdmin: true, isOwner: false, isDev: false, pushName: 'tester',
  client, sock: client, jid: GRUP, sender: ADMIN,
  botData: { id: 4, prefix: '.', owner_number: '628999888777', bot_number: '628111222333' },
  msg: { key: { remoteJid: GRUP, id: 'X' }, message: { conversation: `.timerchat ${arg ?? ''}` } },
  reply: async (t) => { terkirim.push(typeof t === 'string' ? t : JSON.stringify(t)); },
  react: async () => {},
});

(async () => {
  // satuan — `1d` = 1 DETIK, `1h` = 1 HARI (jangan kebalik!)
  const harap = { '1d': 1, '90d': 90, '30m': 1800, '2j': 7200, '1h': 86400, '10': 600 };
  for (const [arg, detik] of Object.entries(harap)) {
    terkirim.length = 0;
    await handler(buatCtx(arg));
    assert.strictEqual(dipanggil.at(-1)?.detik, detik, `.timerchat ${arg} harus ${detik} detik`);
    assert.match(terkirim[0] || '', /Timer pesan diperbarui/, `.timerchat ${arg} harus lapor sukses`);
  }

  // matikan
  for (const off of ['0', 'off', undefined]) {
    terkirim.length = 0;
    await handler(buatCtx(off));
    assert.strictEqual(dipanggil.at(-1)?.detik, 0, `.timerchat ${off ?? '(kosong)'} harus 0`);
    assert.match(terkirim[0] || '', /dimatikan/, `.timerchat ${off ?? '(kosong)'} harus lapor mati`);
  }

  // format ngaco -> nggak nyentuh zapo, kasih cara pakai
  const sebelum = dipanggil.length;
  for (const jelek of ['abc', '1x', '-5', '1,5m', 'm', '1 d']) {
    terkirim.length = 0;
    await handler(buatCtx(jelek));
    assert.match(terkirim[0] || '', /nggak dikenali/, `.timerchat ${jelek} harus kasih cara pakai`);
  }
  assert.strictEqual(dipanggil.length, sebelum, 'format ngaco nggak boleh nembak zapo');

  // JID diteruskan apa adanya (tanpa device suffix)
  assert.strictEqual(dipanggil.at(-1).groupJid, GRUP);

  // konversi balik ke teks
  const { ucapDurasiDari } = (() => {
    // ucapDurasi lokal di plugin — uji lewat balasan pesan
    const cek = { '1d': '1 detik', '30m': '30 menit', '2j': '2 jam', '1h': '1 hari', '90d': '90 detik' };
    return { ucapDurasiDari: cek };
  })();
  for (const [arg, teks] of Object.entries(ucapDurasiDari)) {
    terkirim.length = 0;
    await handler(buatCtx(arg));
    assert.match(terkirim[0] || '', new RegExp(`\\*${teks}\\*`), `.timerchat ${arg} harus lapor "${teks}"`);
  }

  console.log(`✅ .timerchat: ${dipanggil.length} panggilan setEphemeralDuration, satuan + validasi benar`);
})();
