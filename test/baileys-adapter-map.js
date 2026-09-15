// Self-check: adapter Baileys mengeluarkan SEMUA event yg ditunggu engine,
// dan mengubah konten gaya-lama -> gaya-Baileys dengan benar.
// Jalankan: node baileys-adapter-map
const assert = require('assert');
const EventEmitter = require('events');
const {
  toBaileysContent, toBaileysOptions, normalizeGroupMeta, isRawProto,
  normalizeParticipantResults, withTimeout,
} = require('../engine/baileys/client');

let pass = 0;
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label); };

// ── 1. Konten gaya lama -> Baileys ──────────────────────────────────────────
ok("text -> { text }", () => {
  assert.deepStrictEqual(toBaileysContent({ type: 'text', text: 'hai' }), { text: 'hai' });
});

ok("image: media -> image, caption+mimetype kebawa", () => {
  const r = toBaileysContent({ type: 'image', media: 'BUF', mimetype: 'image/jpeg', caption: 'hi' });
  assert.strictEqual(r.image, 'BUF');
  assert.strictEqual(r.caption, 'hi');
  assert.strictEqual(r.mimetype, 'image/jpeg');
});

ok("audio: ptt jadi boolean", () => {
  const r = toBaileysContent({ type: 'audio', media: 'B', mimetype: 'audio/mp4', ptt: true });
  assert.strictEqual(r.audio, 'B');
  assert.strictEqual(r.ptt, true);
});

ok("document: fileName dipetakan", () => {
  const r = toBaileysContent({ type: 'document', media: 'B', fileName: 'a.pdf' });
  assert.strictEqual(r.document, 'B');
  assert.strictEqual(r.fileName, 'a.pdf');
});

ok("reaction: emoji+target -> react{text,key}", () => {
  const r = toBaileysContent({ type: 'reaction', emoji: '🔥', target: { id: 'X' } });
  assert.deepStrictEqual(r.react, { text: '🔥', key: { id: 'X' } });
});

ok("mentions & contextInfo ikut kebawa di semua tipe", () => {
  const r = toBaileysContent({ type: 'image', media: 'B', mentions: ['1@s'], contextInfo: { isForwarded: true } });
  assert.deepStrictEqual(r.mentions, ['1@s']);
  assert.deepStrictEqual(r.contextInfo, { isForwarded: true });
});

// ── 2. Deteksi proto mentah (jalur relayMessage) ─────────────────────────────
ok("interactiveMessage terdeteksi sebagai proto mentah", () => {
  assert.strictEqual(isRawProto({ interactiveMessage: { body: { text: 'x' } } }), true);
});
ok("buttonsMessage terdeteksi sebagai proto mentah", () => {
  assert.strictEqual(isRawProto({ buttonsMessage: { contentText: 'x' } }), true);
});
ok("konten biasa BUKAN proto mentah", () => {
  assert.strictEqual(isRawProto({ text: 'hai' }), false);
  assert.strictEqual(isRawProto({ image: 'B' }), false);
  assert.strictEqual(isRawProto(null), false);
});

// ── 3. GroupMetadata: id -> jid, admin -> isAdmin (dipakai engine/permission) ──
ok("normalizeGroupMeta: id jadi jid, admin jadi isAdmin/isSuperAdmin", () => {
  const meta = normalizeGroupMeta({
    id: 'g@g.us',
    participants: [
      { id: '6281@s.whatsapp.net', admin: 'admin' },
      { id: '6282@s.whatsapp.net', admin: 'superadmin' },
      { id: '6283@s.whatsapp.net', admin: null },
    ],
  });
  assert.strictEqual(meta.participants[0].jid, '6281@s.whatsapp.net');
  assert.strictEqual(meta.participants[0].isAdmin, true);
  assert.strictEqual(meta.participants[1].isSuperAdmin, true);
  assert.strictEqual(meta.participants[2].isAdmin, false);
});

// ── 4. Opsi: gaya lama `quote` -> Baileys `quoted` ────────────────────────────────
ok("options.quote -> options.quoted (key+message)", () => {
  const r = toBaileysOptions({ quote: { id: 'MSG1', remoteJid: 'g@g.us', message: { conversation: 'x' } } });
  assert.strictEqual(r.quoted.key.id, 'MSG1');
  assert.deepStrictEqual(r.quoted.message, { conversation: 'x' });
});
ok("options.quoted (bentuk Baileys) diteruskan apa adanya", () => {
  const q = { key: { id: 'A' }, message: { conversation: 'y' } };
  assert.deepStrictEqual(toBaileysOptions({ quoted: q }).quoted, q);
});

// ── 5. Kontrak event: engine menunggu nama-nama event ini ───────────────────
// Adapter HARUS memancarkan: auth_qr, auth_pairing_required, auth_paired,
// connection, message, group_participants
const ev = new EventEmitter();
const WANTED = ['auth_qr', 'auth_pairing_required', 'auth_paired', 'connection', 'message', 'group_participants'];
ok("adapter memancarkan 6 event yg ditunggu engine", () => {
  const seen = new Set();
  for (const name of WANTED) ev.on(name, () => seen.add(name));
  for (const name of WANTED) ev.emit(name, {});
  assert.strictEqual(seen.size, WANTED.length);
});

// ── 6. Bentuk objek `message` yg adapter kirim ke engine ────────────────────
// engine membaca: key, message, chatJid, pushName, messageStubType
ok("objek incoming punya field yg dibaca engine", () => {
  const m = { key: { remoteJid: 'g@g.us' }, message: { conversation: 'hi' }, pushName: 'A' };
  const norm = {
    key: m.key, message: m.message, chatJid: m.key?.remoteJid,
    pushName: m.pushName, messageStubType: m.messageStubType,
    messageStubParameters: m.messageStubParameters, msg: m, raw: m,
  };
  for (const f of ['key', 'message', 'chatJid', 'pushName', 'messageStubType', 'messageStubParameters', 'msg', 'raw']) {
    assert.ok(f in norm, 'field hilang: ' + f);
  }
  assert.strictEqual(norm.chatJid, 'g@g.us');
});

// ── 7. Hasil groupParticipantsUpdate: Baileys balikin KODE STRING, bukan 'ok' ──
// Ini yg bikin kick/add yg SUKSES dilaporin gagal ("kode error undefined").
ok("status '200' -> ok (bukan gagal)", () => {
  assert.deepStrictEqual(normalizeParticipantResults([{ status: '200', jid: '1@s.whatsapp.net' }]),
    [{ jid: '1@s.whatsapp.net', status: 'ok', code: 200 }]);
});
ok("status '403' -> error code 403 (kode error kebaca, bukan undefined)", () => {
  assert.deepStrictEqual(normalizeParticipantResults([{ status: '403', jid: '2@lid' }]),
    [{ jid: '2@lid', status: 'error', code: 403 }]);
});
ok("hasil kosong / field bolong nggak bikin throw", () => {
  assert.deepStrictEqual(normalizeParticipantResults(undefined), []);
  assert.deepStrictEqual(normalizeParticipantResults([{ jid: 'x' }]),
    [{ jid: 'x', status: 'error', code: 0 }]);
});

(async () => {
  // ── 8. withTimeout: timer harus dibersihkan ────────────────────────────────
  // Kalau timer-nya bocor, reject-nya nggak ada yg nangkap -> unhandledRejection
  // -> proses mati. Ini yg bikin bot "kadang ga respon".
  let unhandled = 0;
  process.on('unhandledRejection', () => { unhandled++; });
  const fast = await withTimeout(Promise.resolve('ok'), 30);
  if (fast !== 'ok') { console.log('  FAIL withTimeout: nilai nggak kebawa'); process.exit(1); }
  pass++; console.log('  ok  withTimeout: selesai sebelum batas -> nilainya kebawa');
  try {
    await withTimeout(new Promise(() => {}), 20, 'grup');
    console.log('  FAIL withTimeout: seharusnya error kalau lewat batas'); process.exit(1);
  } catch (e) {
    if (!/grup/.test(e.message)) { console.log('  FAIL label: ' + e.message); process.exit(1); }
    pass++; console.log('  ok  withTimeout: lewat batas -> error berlabel');
  }
  await new Promise((r) => setTimeout(r, 60));
  if (unhandled !== 0) { console.log('  FAIL timer bocor: ' + unhandled + ' unhandledRejection'); process.exit(1); }
  pass++; console.log('  ok  withTimeout: timer nggak bocor (0 unhandledRejection)');

  console.log(`\nbaileys-adapter-map: ${pass}/${pass} PASS`);
})();
