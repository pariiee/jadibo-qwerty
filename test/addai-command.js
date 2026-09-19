'use strict';
/**
 * test/addai-command.js
 * `.addai` = tambahin Meta AI ke grup. Yang gampang rusak: JID-nya di-strip jadi
 * angka (cara `.add`) — Meta AI JID-nya `867051314767696@bot`, bukan nomor WA,
 * jadi nggak bakal pernah masuk. Tes ini jalanin handler-nya beneran (ctx
 * palsu) dan liat argumen yang nyampe ke `group.addParticipants`.
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

// ── Harness ────────────────────────────────────────────────────────────────
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
  return { handled, kirim, balasan, target: kirim[0]?.[1]?.[0] };
}

(async () => {
  // ── 2. JID @bot apa adanya, BUKAN di-strip jadi @s.whatsapp.net ──────────
  for (const args of [[], ['meta'], ['copilot'], ['pedulilindungi']]) {
    const r = await jalankan('addai', args);
    assert.strictEqual(r.handled, true, `.addai ${args.join(' ')} harus ditangani plugin grup`);
    assert.strictEqual(r.target, '867051314767696@bot', `.addai ${JSON.stringify(args)} -> 867051314767696@bot, dapat: ${r.target}`);
    assert.ok(/Meta AI/.test(r.balasan.join(' ')), 'balasan `.addai` harus nyebut Meta AI');
  }
  console.log('✓ 2. .addai (polos & argumen apa pun) -> 867051314767696@bot');

  // ── 3. `.add` lama nggak berubah: nomor -> @s.whatsapp.net ───────────────
  const add = await jalankan('add', ['+62 811-222-333']);
  assert.strictEqual(add.target, '62811222333@s.whatsapp.net', `.add harus tetap normalisasi nomor, dapat: ${add.target}`);
  const kosong = await jalankan('add', []);
  assert.strictEqual(kosong.kirim.length, 0, '.add tanpa nomor nggak boleh nembak WA');
  assert.ok(/Penggunaan/.test(kosong.balasan.join(' ')), '.add tanpa nomor harus kasih contoh pakai');
  console.log('✓ 3. .add masih normalisasi nomor + nolak kalau kosong');
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
