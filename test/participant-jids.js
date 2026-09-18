'use strict';

/**
 * test/participant-jids.js
 * Baileys v7 kirim peserta grup sebagai OBJEK. Kalau diteruskan apa adanya,
 * `@user` di welcome tampil '@[object Object]'. Tes ini ngunci normalisasi itu.
 */
const assert = require('assert');
const { participantJids, pnToLid, lidToPn } = require('../engine/jid');
const { renderTemplate } = require('../engine/template');

// 1. Objek Baileys v7 -> JID string
assert.deepStrictEqual(
  participantJids([
    { id: '628111222333@s.whatsapp.net', phoneNumber: '628111222333' },
    { id: '999888777@lid', lid: '999888777@lid', phoneNumber: '628444555666' },
  ]),
  ['628111222333@s.whatsapp.net', '999888777@lid'],
  'objek peserta harus jadi string JID'
);

// 2. String lama tetap lolos (biar nggak ada regresi)
assert.deepStrictEqual(
  participantJids(['628111@s.whatsapp.net', '', null]),
  ['628111@s.whatsapp.net'],
  'string harus diteruskan, yang kosong dibuang'
);

// 3. Peta LID<->PN ikut keisi dari objeknya
assert.strictEqual(lidToPn('999888777@lid'), '628444555666@s.whatsapp.net');
assert.strictEqual(pnToLid('628444555666'), '999888777@lid');

// 4. Ujungnya: template welcome nggak lagi jadi '@[object Object]'
const jid = participantJids([{ id: '628111222333@s.whatsapp.net' }])[0];
const { text, mentions } = renderTemplate('halo @user di grup @namegc', {
  groupName: 'Grup Tester',
  target: jid,
});
assert.ok(!text.includes('[object'), `masih ada [object Object]: ${text}`);
assert.strictEqual(text, 'halo @628111222333 di grup Grup Tester');
assert.deepStrictEqual(mentions, ['628111222333@s.whatsapp.net']);

console.log('✅ participant-jids: objek peserta ternormalisasi jadi JID');
