'use strict';
/**
 * test/zapo-adapter-coverage.js
 * Jaring pengaman: tiap path zapo-js yang engine/zapo/client.js panggil HARUS
 * ada di instance WaClient asli. Kalau zapo naik versi & rename method, tes ini
 * gagal DI LOKAL — bukan pas bot mati di VPS jam 3 pagi.
 *
 * Sekaligus ngecek helper murni adapter (terjemahan konten/opsi/meta).
 * Jalankan: node test/zapo-adapter-coverage.js
 */

const assert = require('assert');
const { WaClient, createStore } = require('zapo-js');
const A = require('../engine/zapo/client');

// ── 1. Semua path zapo yang dipanggil adapter harus ada ───────────────────────
const PATHS = [
  'message.send', 'message.upload', 'message.downloadBytes', 'message.sendReceipt',
  'group.queryGroupMetadata', 'group.queryAllGroups', 'group.queryInviteCode',
  'group.addParticipants', 'group.removeParticipants',
  'group.promoteParticipants', 'group.demoteParticipants',
  'group.leaveGroup', 'group.setSubject', 'group.setDescription', 'group.setSetting',
  'group.joinGroupViaInvite', 'group.approveMembershipRequests', 'group.rejectMembershipRequests',
  'profile.getProfilePicture', 'profile.setProfilePicture', 'profile.setStatus',
  'business.getBusinessProfile', 'business.getVerifiedName',
  'privacy.blockUser', 'privacy.unblockUser',
  'newsletter.follow',
  'auth.requestPairingCode',
  'status.send',
  // inti client (dipakai engine/adapter buat siklus hidup)
  'connect', 'disconnect', 'logout', 'getCredentials', 'getState',
];

// Kontak: zapo naruh di bawah `stores.contacts`; adapter nembus ke situ.
const PATHS_KONTAK = [
  'stores.contacts.getByJid', 'stores.contacts.getByPhoneNumber',
];

function buatClient() {
  const { createSqliteStore } = require('@zapo-js/store-sqlite');
  const domains = ['auth', 'signal', 'preKey', 'session', 'identity', 'senderKey',
                   'appState', 'messages', 'threads', 'contacts', 'privacyToken'];
  const store = createStore({
    backends: { sqlite: createSqliteStore({ path: ':memory:' }) },
    providers: Object.fromEntries(domains.map((d) => [d, 'sqlite'])),
  });
  return new WaClient({ store, sessionId: 'coverage-test' });
}

const walk = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

console.log('── 1. API zapo-js (wajib ada) ──');
const client = buatClient();
const hilang = [];
for (const p of PATHS) {
  const fn = walk(client, p);
  const ok = typeof fn === 'function';
  if (!ok) hilang.push(p);
  console.log(`  ${ok ? '✓' : '✗'} client.${p}`);
}

console.log('\n── 2. Jalur kontak (salah satu harus ada) ──');
const kontakAda = PATHS_KONTAK.filter((p) => typeof walk(client, p) === 'function');
for (const p of PATHS_KONTAK) console.log(`  ${kontakAda.includes(p) ? '✓' : '·'} client.${p}`);
if (!kontakAda.length) hilang.push('contacts.*');

console.log('\n── 3. Helper murni adapter ──');
const { toZapoContent, isRawProto, normalisasiPesan, normalizeGroupMeta, bareJid, asJids } = A;

assert.strictEqual(bareJid('6281:12@s.whatsapp.net'), '6281@s.whatsapp.net', 'bareJid buang device suffix');
assert.deepStrictEqual(asJids('a@s.whatsapp.net'), ['a@s.whatsapp.net'], 'asJids bungkus single');
assert.strictEqual(isRawProto({ text: 'hai' }), false, 'teks biasa bukan proto');
assert.strictEqual(isRawProto({ interactiveMessage: {} }), true, 'interactiveMessage = proto mentah');
assert.strictEqual(isRawProto({ imageMessage: { url: 'x' } }), true, 'imageMessage = proto mentah');
// Bahasa Baileys lama DITERJEMAHIN ke bahasa zapo (`type` + `media`) — zapo
// nggak ngenalin `{ text }` / `{ image }` polos; content-nya jadi kosong 0 byte.
assert.deepStrictEqual(toZapoContent({ text: 'hai' }), { type: 'text', text: 'hai' }, 'teks -> type:text');
assert.deepStrictEqual(
  toZapoContent({ image: 'buf', caption: 'cap' }),
  { type: 'image', media: 'buf', caption: 'cap' },
  'gambar+caption -> type:image',
);
assert.deepStrictEqual(
  toZapoContent({ document: 'buf', fileName: 'a.pdf', mimetype: 'application/pdf' }),
  { type: 'document', media: 'buf', fileName: 'a.pdf', mimetype: 'application/pdf' },
  'dokumen -> type:document',
);
// Bahasa zapo yang sudah benar DITERUSKAN UTUH — dulu `type`/`media`/`target`
// dibuang di sini, bikin SEMUA command kirim pesan jadi 0 byte.
const zapoAsli = { type: 'revoke', target: { id: 'A', remoteJid: 'g@g.us', fromMe: true } };
assert.strictEqual(toZapoContent(zapoAsli), zapoAsli, 'bahasa zapo TIDAK diubah');
const protoMentah = { interactiveMessage: { body: { text: 'x' } } };
assert.strictEqual(toZapoContent(protoMentah), protoMentah, 'proto mentah TIDAK diubah (nativeFlow aman)');
assert.strictEqual(normalisasiPesan({ messageTimestamp: 1700000000 }).timestamp, 1700000000000, 'detik -> ms');
assert.strictEqual(normalisasiPesan({ messageTimestamp: 1700000000000 }).timestamp, 1700000000000, 'ms tetap ms');
console.log('  ✓ bareJid, asJids, isRawProto, toZapoContent, normalisasiPesan');

const meta = { participants: [{ id: 'a@s.whatsapp.net', isAdmin: true }] };
normalizeGroupMeta(meta);
assert.strictEqual(meta.participants[0].jid, 'a@s.whatsapp.net', 'participant.id -> .jid (warisan Baileys)');
assert.strictEqual(meta.participants[0].isAdmin, true, 'isAdmin diteruskan');
assert.strictEqual(meta.participants[0].admin, 'admin', 'isAdmin -> admin string');
console.log('  ✓ normalizeGroupMeta');

console.log('\n── 4. Factory nolak input kosong ──');
assert.throws(() => A.createClient({}), /wajib diisi/, 'createClient tanpa client harus error jelas');
console.log('  ✓ createClient({}) melempar error yang bisa dibaca');

console.log('\n── 5. Kontrak export yang di-`require` plugins ──');
// plugins/02-group.js & 05-owner.js nge-`require` ini dari adapter. Kalau
// hilang, fitur antidelete / `.testai` mati (dan cuma kelihatan di produksi).
assert.strictEqual(typeof A.onMessageSent, 'function', 'onMessageSent ada (02-group)');
assert.ok(Array.isArray(A.AI_NODES), 'AI_NODES ada (05-owner)');
assert.ok(Array.isArray(A.BIZ_NODE), 'BIZ_NODE ada (05-owner)');
console.log('  ✓ onMessageSent, AI_NODES, BIZ_NODE');

if (hilang.length) {
  console.error(`\n❌ GAGAL — ${hilang.length} path zapo-js nggak ada: ${hilang.join(', ')}`);
  console.error('   Adapter manggil nama yang nggak ada di paket. Cek versi zapo-js.');
  process.exit(1);
}

// ── 6. Jalur antidelete: hook pesan terkirim HARUS kepanggil ─────────────────
(async () => {
  console.log('\n── 6. Hook pesan terkirim (antidelete 02-group) ──');
  const EventEmitter = require('events');
  const fakeEv = new EventEmitter();
  const fakeClient = {
    on: (...a) => fakeEv.on(...a),
    message: { send: async () => ({ id: 'MSG1', key: { id: 'MSG1', remoteJid: '6281@s.whatsapp.net' } }) },
    group: {}, stores: {},
  };
  const { client: adapt } = A.createClient({ client: fakeClient });

  let kena = 0;
  const lepas = A.onMessageSent(() => { kena++; });
  await adapt.message.send('6281@s.whatsapp.net', { text: 'halo' });
  assert.strictEqual(kena, 1, 'hook kepanggil pas pesan terkirim');
  lepas();
  await adapt.message.send('6281@s.whatsapp.net', { text: 'lagi' });
  assert.strictEqual(kena, 1, 'setelah unsubscribe, hook nggak kepanggil lagi');
  console.log('  ✓ hook kepanggil pas send(), dan bisa dilepas');

  console.log('\n── 7. Event masuk dinormalisasi (messages.upsert) ──');
  let diterima = null;
  adapt.on('messages.upsert', (p) => { diterima = p; });
  fakeEv.emit('message', {
    id: 'IN1', chatJid: '6282@s.whatsapp.net', senderJid: '6282@s.whatsapp.net',
    fromMe: false, pushName: 'Budi', messageTimestamp: 1700000000,
    message: { conversation: 'hai bot' },
  });
  assert.ok(diterima, 'engine dapet event messages.upsert');
  assert.strictEqual(diterima.messages[0].chatJid, '6282@s.whatsapp.net', 'chatJid diteruskan');
  assert.strictEqual(diterima.messages[0].message.conversation, 'hai bot', 'isi pesan utuh');
  assert.strictEqual(diterima.messages[0].timestamp, 1700000000000, 'timestamp dinormalkan ke ms');
  assert.strictEqual(diterima.messages[0].pushName, 'Budi', 'pushName diteruskan');
  console.log('  ✓ pesan masuk -> { key, message, chatJid, pushName, timestamp }');

  console.log('\n── 8. Aksi grup dinormalisasi (group-participants.update) ──');
  let gEv = null;
  adapt.on('group-participants.update', (p) => { gEv = p; });
  fakeEv.emit('group', {
    action: 'add', groupJid: '123@g.us', authorJid: '6281@s.whatsapp.net',
    participants: [{ jid: '6282:5@s.whatsapp.net' }],
  });
  assert.ok(gEv, 'engine dapet event grup');
  assert.strictEqual(gEv.action, 'add', 'aksi add diteruskan');
  assert.deepStrictEqual(gEv.participants, ['6282@s.whatsapp.net'], 'device suffix dibuang');
  console.log('  ✓ aksi grup -> { id, action, participants, author }');

  console.log(`\n✅ ${PATHS.length} path zapo-js + ${PATHS_KONTAK.length} kontak + 8 blok tes OK`);
})().catch((e) => {
  console.error('\n❌ GAGAL di blok async:', e.message);
  process.exit(1);
});
