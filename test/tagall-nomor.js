'use strict';
/**
 * test/tagall-nomor.js
 * `.tagall` / `.tagadmin` di grup ber-alamat LID (zapo).
 *
 * Bug yang dijaga: `resolveMentionTag()` dulu punya DUA cabang yang balikin hal
 * yang sama (`jid.split('@')[0]`), jadi di grup LID teksnya keluar angka LID
 * (`@238487219482668`) — nggak ada artinya buat manusia.
 *
 * Kontrak: ISI `mentions` tetap LID (tag biru nempel dari situ), tapi yang
 * DIBACA user di teks harus NOMOR.
 *
 * Jalankan: node test/tagall-nomor.js
 */
const assert = require('assert');
const A = require('../engine/zapo/client');
const jidMod = require('../engine/jid');

const GRUP = '120363391950784399@g.us';
const BOT = '628111222333@s.whatsapp.net';
const ADMIN_LID = '238487219482668@lid';
const ADMIN_PN = '628999888777';
const MEMBER_LID = '281294688809156@lid';
const MEMBER_PN = '628123456789';

const terkirim = [];
const zapoPalsu = {
  on: () => {}, stores: {},
  getCredentials: () => ({ meJid: BOT }),
  message: { send: async (jid, content) => { terkirim.push({ jid, content }); } },
  group: {
    queryGroupMetadata: async () => ({
      announce: false,
      participants: [
        { jid: BOT, isAdmin: true },
        { jid: ADMIN_LID, phoneNumber: ADMIN_PN, isAdmin: true },
        { jid: MEMBER_LID, phoneNumber: MEMBER_PN, isAdmin: false },
      ],
    }),
  },
};

const { client } = A.createClient({ client: zapoPalsu, botJid: BOT });
const handler = require('../plugins/02-group');

const buatCtx = (command, args = []) => ({
  command, args, isCmd: true, isGroup: true,
  isAdmin: true, isOwner: false, isDev: false, pushName: 'tester',
  client, sock: client, jid: GRUP, sender: ADMIN_LID,
  botData: { id: 4, prefix: '.', owner_number: ADMIN_PN, bot_number: '628111222333' },
  msg: { key: { remoteJid: GRUP, id: 'X' }, message: { conversation: `.${command}` } },
  reply: async () => {}, react: async () => {},
});

(async () => {
  // ── tagall ────────────────────────────────────────────────────────────────
  terkirim.length = 0;
  assert.strictEqual(await handler(buatCtx('tagall', ['ada', 'yang', 'on?'])), true);
  const kirim = terkirim.at(-1);
  assert.ok(kirim, '.tagall harus ngirim pesan');
  const teks = kirim.content.text;
  const mentions = kirim.content.mentions || [];

  // teks: nomor, BUKAN angka LID
  assert.match(teks, new RegExp(`@${ADMIN_PN}`), 'teks harus @nomor admin');
  assert.match(teks, new RegExp(`@${MEMBER_PN}`), 'teks harus @nomor member');
  assert.doesNotMatch(teks, /@238487219482668/, 'teks TIDAK boleh @lid admin');
  assert.doesNotMatch(teks, /@281294688809156/, 'teks TIDAK boleh @lid member');

  // mentions: LID wajib ikut UTUH (`...@lid`), bukan angka telanjang —
  // WA diam-diam mengabaikan `mentionedJid` yang bukan JID.
  assert.ok(mentions.some((m) => String(m).endsWith('@lid')), 'mentions wajib bentuk JID (@lid), bukan angka');
  assert.ok(mentions.some((m) => String(m).includes('238487219482668')), 'mentions wajib bawa LID admin');
  assert.ok(mentions.some((m) => String(m).includes('281294688809156')), 'mentions wajib bawa LID member');
  assert.ok(mentions.every((m) => String(m).includes('@')), 'nggak boleh ada mention tanpa @ (WA bakal abaikan)');

  // ── tagadmin ──────────────────────────────────────────────────────────────
  terkirim.length = 0;
  assert.strictEqual(await handler(buatCtx('tagadmin', ['bang'])), true);
  const teksAdmin = terkirim.at(-1).content.text;
  assert.match(teksAdmin, new RegExp(`@${ADMIN_PN}`), '.tagadmin harus @nomor');
  assert.doesNotMatch(teksAdmin, /@238487219482668/, '.tagadmin TIDAK boleh @lid');

  // ── tanpa phoneNumber: pakai peta LID<->PN ────────────────────────────────
  // (persis data yang diisi cacheLidFromMeta dari metadata grup)
  // `client.group.invalidate()` wajib — queryGroupMetadata nge-cache 60 detik,
  // tanpa itu tes ini baca metadata lama dan nguji nol.
  terkirim.length = 0;
  jidMod.cacheLidFromMeta([{ jid: '999000111222333@lid', phoneNumber: '628777000111' }]);
  client.group.invalidate(GRUP);
  zapoPalsu.group.queryGroupMetadata = async () => ({
    announce: false,
    participants: [
      { jid: BOT, isAdmin: true },
      { jid: '999000111222333@lid', phoneNumber: undefined, isAdmin: false },
    ],
  });
  await handler(buatCtx('tagall'));
  assert.match(terkirim.at(-1).content.text, /@628777000111/, 'fallback peta LID<->PN harus dipakai');
  assert.doesNotMatch(terkirim.at(-1).content.text, /@999000111222333/, 'fallback TIDAK boleh balik ke LID');

  console.log('✅ .tagall/.tagadmin: teks pakai NOMOR, mentions tetap LID');
})();
