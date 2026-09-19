'use strict';
/**
 * test/addai-command.js
 * `.addai` = tambahin Meta AI ke grup. Yang gampang rusak: JID-nya di-strip
 * jadi angka (cara `.add`) — Meta AI nggak bakal masuk karena JID-nya
 * `867051314767696@bot`, bukan nomor. Tes ini jalanin handler-nya beneran
 * (ctx palsu) dan liat argumen yang nyampe ke `group.addParticipants`.
 */
const assert = require('assert');
const handler = require('../plugins/02-group');
const { ALL_COMMANDS, CATS } = require('../plugins/01-info');
const { limitedCmds } = require('../plugins/02-group');

// ── 1. Kecatat di menu + kena limit ─────────────────────────────────────────
assert.ok(ALL_COMMANDS.includes('addai'), '`addai` harus ada di ALL_COMMANDS');
assert.ok(CATS.grup.includes('addai'), '`addai` harus ada di kategori grup');
assert.ok(limitedCmds.has('addai'), '`addai` harus kena limit');
console.log('✓ 1. .addai kecatat di .menu grup + kena limit');

// ── 2. Handler beneran: JID diteruskan apa adanya ───────────────────────────
const BOT = '628123456789';
const SENDER = '6287778032605@s.whatsapp.net';
const META = {
  participants: [
    { jid: `${BOT}@s.whatsapp.net`, isAdmin: true },
    { jid: SENDER, isAdmin: true },
  ],
};

async function jalankan(command, args) {
  const kirim = [];
  const balasan = [];
  const handled = await handler({
    isCmd: true, isGroup: true,
    command, args,
    jid: '120363418054099388@g.us',
    sender: SENDER,
    botData: { prefix: '.', bot_number: BOT, owner_number: '6287778032605' },
    reply: async (t) => balasan.push(String(t)),
    react: async () => {},
    sock: {},
    client: {
      group: {
        queryGroupMetadata: async () => META,
        addParticipants: async (jid, jids) => { kirim.push([jid, jids]); return [{ jid: jids[0], status: 'ok', code: 200 }]; },
      },
    },
  });
  return { handled, kirim, balasan };
}

(async () => {
  const ai = await jalankan('addai', []);
  assert.strictEqual(ai.handled, true, '.addai harus ditangani plugin grup');
  assert.deepStrictEqual(ai.kirim[0][1], ['867051314767696@bot'],
    `.addai harus kirim JID @bot apa adanya, dapat: ${JSON.stringify(ai.kirim[0]?.[1])}`);
  assert.ok(/Meta AI/.test(ai.balasan.join(' ')), 'balasan `.addai` harus nyebut Meta AI');
  console.log('✓ 2. .addai kirim 867051314767696@bot (nggak di-strip jadi angka)');

  // argumen manual tetap diteruskan utuh
  const custom = await jalankan('addai', ['12345@bot']);
  assert.deepStrictEqual(custom.kirim[0][1], ['12345@bot'], '.addai <jid> harus nerusin argumennya');
  console.log('✓ 3. .addai <jid> nerusin argumen apa adanya');

  // ── 4. `.add` lama nggak berubah: nomor -> @s.whatsapp.net ────────────────
  const add = await jalankan('add', ['+62 811-222-333']);
  assert.deepStrictEqual(add.kirim[0][1], ['62811222333@s.whatsapp.net'],
    `.add harus tetap normalisasi nomor, dapat: ${JSON.stringify(add.kirim[0]?.[1])}`);
  console.log('✓ 4. .add masih normalisasi nomor seperti sebelumnya');

  // `.add` tanpa argumen tetap nolak (nggak ikut jalur addai)
  const kosong = await jalankan('add', []);
  assert.strictEqual(kosong.kirim.length, 0, '.add tanpa nomor nggak boleh nembak WA');
  assert.ok(/Penggunaan/.test(kosong.balasan.join(' ')), '.add tanpa nomor harus kasih contoh pakai');
  console.log('✓ 5. .add tanpa nomor tetap ditolak dengan contoh pakai');
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
