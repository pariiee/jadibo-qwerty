'use strict';
// Balasan tanpa prefix — user ngetik "bot" (tanpa titik) harus dibalas, dan
// balasannya WAJIB lewat jalur ber-label AI (messageContextInfo + node
// <bot biz_bot="1"/>). Ini yang gampang rusak tanpa ketahuan: kalau jalurnya
// balik lewat sendMessage biasa, pesannya tetap terkirim tapi tanpa label —
// nggak ada error, cuma labelnya hilang.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { proto } = require('baileys');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const cl = require('../engine/baileys/client');
const engSrc = read('engine/whatsappEngine.js');
const clSrc  = read('engine/baileys/client.js');

// 1. Isi pesan selamat sebagai proto mentah (WA yang baca, bukan kita)
const c = cl.aiContent('oh iyaa banggg');
const round = proto.Message.decode(proto.Message.encode(proto.Message.create(c)).finish());
assert.strictEqual(round.conversation, 'oh iyaa banggg', 'teksnya harus utuh');
assert.strictEqual(round.messageContextInfo.messageSecret.length, 32,
  'messageSecret wajib 32 byte — tanpa ini supportPayload diabaikan WA');
const payload = JSON.parse(round.messageContextInfo.supportPayload);
assert.strictEqual(payload.is_ai_message, true, 'penanda AI harus ada di supportPayload');
assert.strictEqual(payload.version, 1);

// 2. Node penanda bot — cuma ini yang bikin labelnya nongol
assert.deepStrictEqual(
  cl.AI_NODES.map(n => n.tag),
  ['bot', 'biz'],
  'node WAJIB <bot biz_bot="1"/> lalu <biz/>'
);
assert.strictEqual(cl.AI_NODES[0].attrs.biz_bot, '1');

// 2b. Di grup node `<bot>` jangan dipaksa — aturan client resmi di grup cuma
// `<biz/>` (sama kayak jalur tombol di sendRaw). Kalau dipaksa, labelnya
// kemungkinan malah di-drop.
assert.deepStrictEqual(cl.aiNodesFor('628123@s.whatsapp.net'), cl.AI_NODES,
  'chat pribadi: bot + biz');
assert.deepStrictEqual(cl.aiNodesFor('120363418054099388@g.us'), cl.BIZ_NODE,
  'grup: cuma biz');
assert.deepStrictEqual(cl.BIZ_NODE, [{ attrs: {}, tag: 'biz' }]);
assert.ok(/additionalNodes: opts\.nodes \?\? aiNodesFor\(jid\)/.test(clSrc),
  'sendAi harus milih node sesuai jenis chat (dan masih bisa dioverride buat tes)');

// 3. Jalur kirimnya relayMessage + node AI, bukan sendMessage biasa
assert.ok(/async function sendAi/.test(clSrc), 'sendAi harus ada');
assert.ok(/const AI_NODES = \[/.test(clSrc), 'AI_NODES harus tetap ada');
assert.ok(/if \(opts\.ai\) return sendAi/.test(clSrc), 'send(..., { ai: true }) harus ke sendAi');
assert.ok(/sendAi,/.test(clSrc), 'sendAi harus diekspos lewat client.message');
assert.ok(/randomBytes\(32\)/.test(clSrc), 'messageSecret wajib dari randomBytes(32)');

// 4. Pemicunya: "bot" tanpa prefix, dan dicek SEBELUM gerbang registrasi
// (kalau ditaruh sesudah, user yang belum terdaftar nggak dibalas sama sekali).
assert.ok(/replyAI: \(text\)/.test(engSrc), 'engine harus nyediain ctx.replyAI');
assert.ok(/ctx\.replyAI\('oh iyaa banggg'\)/.test(engSrc), 'balasannya "oh iyaa banggg"');
assert.ok(/!ctx\.isCmd && ctx\.jid && ctx\.body\.trim\(\)\.toLowerCase\(\) === 'bot'/.test(engSrc),
  'pemicunya: pesan non-command yang isinya persis "bot"');
const iReply = engSrc.indexOf('ctx.replyAI(\'oh iyaa banggg\')');
const iReg   = engSrc.indexOf('Gerbang registrasi');
assert.ok(iReply > 0 && iReg > iReply, 'balasan "bot" harus SEBELUM gerbang registrasi');

console.log('✓ non-prefix: "bot" dibalas, dan balasannya beneran ber-label AI');
