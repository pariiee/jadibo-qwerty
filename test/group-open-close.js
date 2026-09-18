// Self-check: `.open`/`.close` (dan `.mute`/`.unmute`) nyampe ke Baileys sebagai
// tag yang bener.
//
// AKAR BUG yang dijaga di sini: Baileys bikin tag grup LANGSUNG dari string —
// `groupQuery(jid, 'set', [{ tag: setting, attrs: {} }])`. Jadi 'announcement'
// = TUTUP grup. Dulu semua call-site ngirim `setSetting(jid, 'announcement', bool)`
// dan adapter cuma punya 2 parameter → arg ke-3 kebuang → `.open` malah nge-close.
// Jalankan: node test/group-open-close.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const adapter = fs.readFileSync(path.join(root, 'engine', 'baileys', 'client.js'), 'utf8');
const group   = fs.readFileSync(path.join(root, 'plugins', '02-group.js'), 'utf8');

// 1. Call-site: JANGAN ada lagi `'announcement'` mentah — itu tag tutup.
assert.ok(!/'announcement'/.test(group),
  "02-group.js masih ngirim tag 'announcement' mentah — `.open` bakal nge-close grup");

// 2. Keempat command harus lewat kata kunci niatnya, bukan nama tag.
const NIAT = { open: 'open', close: 'close', mute: 'mute', unmute: 'unmute' };
for (const [cmd, kw] of Object.entries(NIAT)) {
  const blk = group.split(`case '${cmd}': {`)[1]?.slice(0, 400) || '';
  assert.ok(blk, `case '${cmd}' hilang dari 02-group.js`);
  assert.ok(blk.includes(`setSetting(jid, '${kw}')`),
    `case '${cmd}' nggak manggil setSetting(jid, '${kw}')`);
}

// 3. Adapter: mapping niat -> tag WA. Dieksekusi beneran (bukan cuma di-grep),
//    dengan socket palsu yang nyatet tag yang dikirim.
const OPEN_TAGS = ['not_announcement'];
const { createClient } = require('../engine/baileys/client');
assert.ok(typeof createClient === 'function', 'createClient nggak diekspor');

// Ambil blok setSetting dari adapter, jalankan di sandbox kecil: cukup butuh
// `sock` + `dropMeta` — persis bentuk aslinya.
const blok = adapter.slice(adapter.indexOf('setSetting:'), adapter.indexOf('joinGroupViaInvite:'));
const setSetting = new Function('sock', 'dropMeta', `return ({ ${blok} }).setSetting;`);

const sent = [];
const sock = { groupSettingUpdate: async (jid, tag) => { sent.push(tag); } };
const call = setSetting(sock, () => {});

(async () => {
  const HRS = 2000;
  const kirim = async (kw) => { sent.length = 0; await call('123@g.us', kw); return sent[0]; };

  assert.strictEqual(await kirim('open'),    'not_announcement', '`.open` harus kirim not_announcement (buka)');
  assert.strictEqual(await kirim('unmute'),  'not_announcement', '`.unmute` harus kirim not_announcement (buka)');
  assert.strictEqual(await kirim('close'),   'announcement',     '`.close` harus kirim announcement (tutup)');
  assert.strictEqual(await kirim('mute'),    'announcement',     '`.mute` harus kirim announcement (tutup)');

  // Tag mentah dari Baileys tetap boleh lewat (kompat).
  assert.strictEqual(await kirim('not_announcement'), 'not_announcement', 'tag mentah buka ke-mangle');
  assert.strictEqual(await kirim('announcement'),     'announcement',     'tag mentah tutup ke-mangle');
  // Apa pun selain daftar buka = tutup (fail-closed, bukan fail-silent).
  assert.strictEqual(await kirim('ngawur'), 'announcement', 'kata kunci nggak dikenal harus fail-closed (tutup)');

  // 4. Bukti bug lama: bentuk 3-arg yang dulu dipakai nggak ngaruh sama sekali.
  assert.strictEqual(await kirim(true), 'announcement', 'true harus = tutup');
  console.log(`  info  tag yang dikirim per kata kunci: open/unmute -> ${OPEN_TAGS[0]}, close/mute -> announcement`);
  console.log(`  info  jaga-jaga: ${HRS} ms timeout grupQuery, nggak dites di sini`);
  console.log('✓ open/close: mapping niat -> tag WA bener; `.open` nggak lagi nge-close grup');
})();
