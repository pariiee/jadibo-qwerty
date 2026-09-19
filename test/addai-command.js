'use strict';
/**
 * test/addai-command.js
 * `.addai` = tambahin bot AI ke grup. Yang gampang rusak: JID-nya di-strip jadi
 * angka (cara `.add`) — bot AI JID-nya `…@bot` / JID asing, bukan nomor WA
 * biasa, jadi nggak bakal pernah masuk. Tes ini jalanin handler-nya beneran
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
  // ── 2. Polos -> Meta AI (JID @bot, BUKAN @s.whatsapp.net) ────────────────
  const polos = await jalankan('addai', []);
  assert.strictEqual(polos.handled, true, '.addai harus ditangani plugin grup');
  assert.strictEqual(polos.target, '867051314767696@bot', `.addai polos -> Meta AI, dapat: ${polos.target}`);
  assert.ok(/Meta AI/.test(polos.balasan.join(' ')), 'balasan `.addai` harus nyebut Meta AI');
  console.log('✓ 2. .addai polos -> 867051314767696@bot');

  // ── 3. Tabel kode: tiap kode nerusin JID-nya UTUH (nggak di-strip) ───────
  const tabel = [
    ['pedulilindungi', '6281110500567@s.whatsapp.net'],
    ['wiz',            '4915151853491@s.whatsapp.net'],
    ['you',            '15854968266@s.whatsapp.net'],
    ['shmooz',         '12014166644@s.whatsapp.net'],
    ['jinni',          '447457403599@s.whatsapp.net'],
    ['guide',          '12058922070@s.whatsapp.net'],
    ['quitline',       '6282125900597@s.whatsapp.net'],
    ['copilot',        '18772241042@s.whatsapp.net'],
    ['sigap',          '628117544433@s.whatsapp.net'],
    ['chatgpt',        '18002428478@s.whatsapp.net'],
    ['robof',          '919099913506@s.whatsapp.net'],
    ['aso',            '6281112159159@s.whatsapp.net'],
    ['ocs',            '6282182288046@s.whatsapp.net'],
    ['mobile',         '27767346284@s.whatsapp.net'],
    ['chatchit',       '905376449086@s.whatsapp.net'],
    ['luz',            '34613288116@s.whatsapp.net'],
    ['genie',          '16204458887@s.whatsapp.net'],
    ['august',         '918738030604@s.whatsapp.net'],
    ['heypat',         '18442439728@s.whatsapp.net'],
    ['dola',           '16502234435@s.whatsapp.net'],
    ['yatter',         '919811046549@s.whatsapp.net'],
    ['remko',          '6281517084333@s.whatsapp.net'],
    ['microsoft',      '18772241042@s.whatsapp.net'],
  ];
  for (const [kode, jid] of tabel) {
    const r = await jalankan('addai', [kode]);
    assert.strictEqual(r.target, jid, `.addai ${kode} -> ${jid}, dapat: ${r.target}`);
  }
  console.log(`✓ 3. .addai <kode> nerusin JID utuh (${tabel.length} kode dicek)`);

  // kode asing nggak boleh lolos ke WA — harus dikasih daftarnya
  const salah = await jalankan('addai', ['so']);
  assert.strictEqual(salah.kirim.length, 0, 'kode nggak dikenal nggak boleh nembak WA');
  assert.ok(/nggak ada di daftar/.test(salah.balasan.join(' ')), 'kode nggak dikenal harus dikasih daftar');
  assert.ok(salah.balasan.join(' ').includes('pedulilindungi'), 'daftar harus nyebut kode yang ada');
  console.log('✓ 3b. kode asing ditolak + dikasih daftar kode');

  // ── 4. JID mentah tetap bisa ─────────────────────────────────────────────
  const mentah = await jalankan('addai', ['12345@bot']);
  assert.strictEqual(mentah.target, '12345@bot', '.addai <jid> harus nerusin JID mentah');
  console.log('✓ 4. .addai <jid@bot> nerusin JID mentah apa adanya');

  // ── 5. `.add` lama nggak berubah: nomor -> @s.whatsapp.net ───────────────
  const add = await jalankan('add', ['+62 811-222-333']);
  assert.strictEqual(add.target, '62811222333@s.whatsapp.net', `.add harus tetap normalisasi nomor, dapat: ${add.target}`);
  const kosong = await jalankan('add', []);
  assert.strictEqual(kosong.kirim.length, 0, '.add tanpa nomor nggak boleh nembak WA');
  assert.ok(/Penggunaan/.test(kosong.balasan.join(' ')), '.add tanpa nomor harus kasih contoh pakai');
  console.log('✓ 5. .add masih normalisasi nomor + nolak kalau kosong');
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
