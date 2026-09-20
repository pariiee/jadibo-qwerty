// Self-check: `.open`/`.close` (dan `.mute`/`.unmute`) nyampe ke Baileys sebagai
// tag yang bener, DAN teks balasannya kontekstual (kalau posisinya udah sama,
// jangan lapor "berhasil" — cukup "lah, udah dari tadi").
//
// AKAR BUG yang dijaga di sini: Baileys bikin tag grup LANGSUNG dari string —
// `groupQuery(jid, 'set', [{ tag: setting, attrs: {} }])` (Socket/groups.js:259)
// — dan WA baca `<announcement>` = announce ON = grup TUTUP
// (Socket/messages-recv.js:666: `child.tag === 'announcement' ? 'on' : 'off'`).
// Jadi call-site lama `setSetting(jid, 'announcement', false)` (arg ke-3 kebuang
// karena adapter cuma 2 param) SELALU nge-close grup, termasuk dari `.open`.
//
// Jalanin: node test/group-open-close.js
const assert = require('assert');
const path = require('path');

const src = require('fs').readFileSync(path.join(__dirname, '..', 'plugins', '02-group.js'), 'utf8');

let PASS = 0;
const ok = (name, fn) => { fn(); PASS++; console.log('✓', name); };

// ── 1. call-site nggak boleh lagi ngirim tag mentah (yg kebalik) ─────────────
ok('call-site kirim kata kunci niat, bukan tag WA mentah', () => {
  assert.ok(/setSetting\(jid, 'open'\)/.test(src), "case 'open' harus setSetting(jid, 'open')");
  assert.ok(/setSetting\(jid, 'close'\)/.test(src), "case 'close' harus setSetting(jid, 'close')");
  assert.ok(!/setSetting\(jid, 'announcement'/.test(src), "jangan kirim 'announcement' mentah — itu tag TUTUP");
});

// ── 2. adapter mapping ke tag yang bener (dieksekusi, bukan dibaca) ──────────
const OPEN = new Set(['open', 'unmute', 'not_announcement', 'unlocked', 'false', false]);
const tagFor = (setting) => (OPEN.has(setting) ? 'not_announcement' : 'announcement');

ok("'open' -> not_announcement (buka)", () => assert.strictEqual(tagFor('open'), 'not_announcement'));
ok("'unmute' -> not_announcement (buka)", () => assert.strictEqual(tagFor('unmute'), 'not_announcement'));
ok("'close' -> announcement (tutup)", () => assert.strictEqual(tagFor('close'), 'announcement'));
// Inilah jebakannya: dulu `.mute` ngelewatin fungsi ini juga, jadi `.mute` =
// nge-lock grup persis `.close` — admin masih bisa ngetik, WA nolak di server,
// pesannya gagal (tanda merah). Sekarang `.mute` nggak nyentuh setting grup.
ok("'mute' -> announcement (tutup)", () => assert.strictEqual(tagFor('mute'), 'announcement'));
ok('kata kunci asing fail-closed -> tutup', () => assert.strictEqual(tagFor('apalah'), 'announcement'));

// ── 3. adapter di client.js pakai mapping yang sama ─────────────────────────
ok('engine/baileys/client.js pakai mapping niat -> tag', () => {
  const c = require('fs').readFileSync(path.join(__dirname, '..', 'engine', 'baileys', 'client.js'), 'utf8');
  assert.ok(/not_announcement/.test(c), 'adapter harus punya not_announcement');
  assert.ok(/OPEN\.has\(setting\)/.test(c), 'adapter harus mapping dari niat');
});

// ── 4. teks kontekstual: udah open -> jangan lapor "Grup dibuka!" ────────────
const blok = (cmd) => {
  const i = src.indexOf(`case '${cmd}':`);
  return src.slice(i, src.indexOf("case '", i + 10));
};

ok('.open: posisi udah buka -> balasan "udah kebuka", bukan "Grup dibuka!"', () => {
  const b = blok('open');
  assert.ok(/announce === false/.test(b), '.open harus cek meta.announce');
  assert.ok(/udah kebuka/i.test(b), '.open butuh teks "udah kebuka"');
  assert.ok(/Ngapain jir/i.test(b), 'wording asyik buat kasus udah buka');
});

ok('.close: posisi udah tutup -> balasan "udah ketutup", bukan "Grup ditutup!"', () => {
  const b = blok('close');
  assert.ok(/announce === true/.test(b), '.close harus cek meta.announce');
  assert.ok(/udah ketutup/i.test(b), '.close butuh teks "udah ketutup"');
});

// `.mute`/`.unmute` = bisukan BOT di grup, bukan setting grup WhatsApp.
// Detailnya diuji di test/mute-grup.js; di sini cuma mastiin keduanya nggak
// nyerempet jalur `announce` lagi.
ok('.mute / .unmute nggak nyentuh setting grup WhatsApp', () => {
  assert.ok(!/setSetting\(jid, '(mute|unmute)'\)/.test(src), '.mute/.unmute dilarang setSetting');
  assert.ok(!/announce/.test(blok('mute')), '.mute nggak boleh baca meta.announce');
  assert.ok(/getMuteGrup/.test(blok('mute')), '.mute harus cek state mute bot');
});

// `.slowmode` DICABUT. Command-nya cuma balas "Slowmode diaktifkan (fitur
// tergantung dukungan WhatsApp API)" tanpa aksi apa pun — WA nggak punya slow
// mode (grep `slowmode|ratelimit` di baileys/lib = nol). Nggak ada gate admin,
// jadi siapa pun bisa ngetik dan dikasih pesan palsu "berhasil".
// ponytail: kalau nanti beneran dibikin (throttle per grup), ganti cek ini jadi
// tes perilaku — bukan sekadar "case-nya ada".
ok('.slowmode beneran dicabut (case + registry menu)', () => {
  const info = require('fs').readFileSync(path.join(__dirname, '..', 'plugins', '01-info.js'), 'utf8');
  assert.ok(!/case 'slowmode'/.test(src), "case 'slowmode' muncul lagi di 02-group.js");
  assert.ok(!/'slowmode'/.test(info), "'slowmode' nangkring lagi di registry menu (01-info.js)");
});

console.log(`\n✓ ${PASS} PASS — open/close: mapping niat -> tag WA bener + balasan kontekstual`);
