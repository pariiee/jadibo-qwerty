'use strict';
/**
 * test/zapo-fakemsg-shape.js
 *
 * Kenapa tes ini ada: `.fakemsg` gagal di engine zapo
 *   `[fakemsg] cannot apply contextInfo: no compatible submessage found`
 * padahal di Baileys lancar. Sebabnya adapter zapo salah nerjemahin content:
 * plugin zapo sudah nulis BAHASA ZAPO (`{ type:'text' }`, `{ type:'revoke' }`),
 * tapi `toZapoContent` cuma ngenal bahasa Baileys lama, jadi `type`/`target`/
 * `media`/`contextInfo` dibuang → content jadi `{}` → 0 byte.
 *
 * Tes jalan lewat kode zapo yang ASLI (`buildMediaMessageContent` +
 * `resolveSendContextInfo` + `applyContextInfo`), bukan tiruan, jadi kalau zapo
 * ganti bahasa tes ini ikut gagal.
 */
const assert = require('assert');
const path = require('path');
const A = require('../engine/zapo/client.js');
const zapo = (p) => require(path.join(__dirname, '..', 'node_modules', 'zapo-js', 'dist', p));
const M = zapo('client/messaging/messages.js');
const CI = zapo('message/context-info.js');
const C = zapo('message/encode/content.js');
const { proto } = zapo('proto.js');

const JID = '628222@s.whatsapp.net';
const deps = {
  logger: { warn() {}, debug() {}, info() {}, error() {} },
  getCurrentCredentials: () => ({ meJid: '628111@s.whatsapp.net', meLid: '628111@s.whatsapp.net' }),
};
const ambilQuote = () => null; // quote nggak ketemu di cache — sama kayak produksi

/** content plugin -> adapter -> zapo -> proto. `opts` = opsi gaya Baileys. */
async function bangun(contentPlugin, opts = {}) {
  const o = A.toZapoOptions(opts, ambilQuote) || {};
  const body = A.toZapoContent(contentPlugin);
  const built = await M.buildMediaMessageContent(deps, body, { to: JID, recipientJid: JID });
  const ctx = CI.resolveSendContextInfo({
    contentLevel: body?.contextInfo,
    optionsLevel: o,
    quote: o.quote,
    mentions: o.mentions,
    meLid: '628111@s.whatsapp.net',
    targetJid: JID,
  });
  return ctx ? CI.applyContextInfo(built.message, ctx) : built.message;
}
const sub = (m) => Object.keys(m || {}).filter((k) => k !== 'messageContextInfo');
/** Byte proto: 0 = bubble kosong yang tetap "terkirim" (gagal senyap). */
const byte = (m) => proto.Message.encode(m).finish().length;
/** `edit` lewat `send()` — send() butuh client WA, jadi tes flag-nya lewat sumber. */
const SUMBER = require('fs').readFileSync(path.join(__dirname, '..', 'engine/zapo/client.js'), 'utf8');

const tes = [];
const it = (nama, fn) => tes.push({ nama, fn });

// ── Bahasa zapo diteruskan utuh (dulu dibolongin jadi {}) ────────────────────
it("bahasa zapo `{ type:'text' }` utuh", () => {
  assert.deepStrictEqual(A.toZapoContent({ type: 'text', text: 'hai' }), { type: 'text', text: 'hai' });
});
it("bahasa zapo `{ type:'revoke', target }` — `target` nggak hilang", () => {
  const t = { id: 'A', remoteJid: 'g@g.us', fromMe: true };
  assert.deepStrictEqual(A.toZapoContent({ type: 'revoke', target: t }), { type: 'revoke', target: t });
});
it('bahasa zapo `{ type:image, media }` — `media` nggak hilang', () => {
  const buf = Buffer.from('gambar');
  assert.strictEqual(A.toZapoContent({ type: 'image', media: buf }).media, buf);
});

// ── Bahasa Baileys lama: diterjemahin ke zapo, dan ISINYA nyampe ─────────────
it("teks Baileys `{ text }` -> extendedTextMessage terisi (bukan 0 byte)", async () => {
  const m = await bangun({ text: 'halo bre' });
  assert.strictEqual(m.extendedTextMessage.text, 'halo bre');
  assert.ok(byte(m) > 0, 'proto kosong');
});
it('`contextInfo` mentah diteruskan adapter (dulu dibuang total)', () => {
  const ci = { isGroupStatus: true };
  assert.deepStrictEqual(A.toZapoContent({ text: 'x', contextInfo: ci }).contextInfo, ci);
});
it('`mentions` nyampe ke proto akhir (dulu dibuang)', async () => {
  const m = await bangun({ text: 'hai', mentions: [JID] }, { mentions: [JID] });
  const sub = m.extendedTextMessage || m;
  assert.deepStrictEqual(sub.contextInfo.mentionedJid, ['628222']);
});
it('gambar Baileys `{ image, caption }` -> bentuk media yang DITERIMA zapo', () => {
  const buf = Buffer.from('jpg');
  const out = A.toZapoContent({ image: buf, caption: 'hai' });
  assert.ok(C.isSendMediaMessage(out), 'zapo nggak ngenalin hasilnya sebagai media');
  assert.strictEqual(out.media, buf);
  assert.strictEqual(out.caption, 'hai');
});

// ── Tiket aslinya: `.fakemsg` ────────────────────────────────────────────────
it('BAIK: bubble kosong + contextInfo mentah tembus (contextInfo nggak dibuang)', async () => {
  const m = await bangun({ text: '', contextInfo: { isGroupStatus: true } });
  assert.ok(byte(m) > 0, 'proto kosong');
});
it('`.fakemsg` langkah-1 lewat adapter SUNGGUHAN tembus tanda tangan zapo', async () => {
  // Susunan persis `plugins/06-proteksi.js` — adapter harus nerusin `contextInfo`.
  const m = await bangun({ text: '', contextInfo: { isGroupStatus: true } }, { quoted: { key: { id: 'X', remoteJid: JID, fromMe: false } } });
  assert.ok(m.extendedTextMessage || m.conversation, 'submessage teks nggak kebentuk');
});
it('hapus pesan `{ delete }` -> revoke yang valid (target wajib ada)', async () => {
  const m = await bangun({ delete: { remoteJid: JID, id: 'MSGID', fromMe: true } });
  assert.ok(m.protocolMessage, 'protocolMessage revoke nggak kebentuk');
  assert.strictEqual(m.protocolMessage.key.id, 'MSGID');
});
it('`.edit` + `messageId` dipetakan ke `editKey` zapo (target edit eksplisit)', () => {
  assert.ok(/content\?\.edit[\s\S]{0,80}editKey/.test(SUMBER), 'edit flag nggak jadi editKey');
  assert.ok(/opts\.messageId[\s\S]{0,40}editKey|editKey = \{ id: opts\.messageId/.test(SUMBER), 'messageId nggak dipakai');
  // content-nya tetap pesan teks biasa (bukan proto mentah)
  assert.strictEqual(A.toZapoContent({ edit: { id: 'A' }, text: 'promo' }).type, 'text');
});

// ── Jalan ────────────────────────────────────────────────────────────────────
(async () => {
  let gagal = 0;
  for (const t of tes) {
    try { await t.fn(); console.log('  ✅', t.nama); }
    catch (e) { gagal++; console.log('  ❌', t.nama, '\n     ', e.message); }
  }
  console.log(`\nzapo-fakemsg-shape: ${tes.length - gagal}/${tes.length} lulus`);
  process.exit(gagal ? 1 : 0);
})();
