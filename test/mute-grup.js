'use strict';

/**
 * test/mute-grup.js
 * Ngunci arti `.mute` = bisukan BOT di grup (bukan setting grup WhatsApp).
 *
 * Dua hal yang diuji:
 *   1. State per (bot, grup) — keisi, kebaca, kehapus, kepisah antar bot/grup,
 *      dan TAHAN RESTART (baca file dari disk, bukan cuma RAM).
 *   2. Guard di engine beneran nge-skip pesan SEBELUM dispatch plugin, dan
 *      `.unmute`/`.listmute` tetap lolos (kalau nggak, nggak ada jalan keluar).
 */

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const AKAR = path.join(__dirname, '..');
const DIR  = fs.mkdtempSync(path.join(os.tmpdir(), 'mute-'));
const FILE = path.join(DIR, 'bot-global-settings.json');

// Modul nyata, tapi file-nya diarahkan ke tmp biar nggak nyentuh data bot.
const SUMBER = fs.readFileSync(path.join(AKAR, 'config', 'globalSettings.js'), 'utf8')
  .replace(/path\.join\(__dirname, '\.\.', 'data', 'bot-global-settings\.json'\)/, JSON.stringify(FILE));
const gs = { exports: {} };
new Function('module', 'exports', 'require', '__dirname', SUMBER)(
  gs, gs.exports, require, path.join(AKAR, 'config')
);
const { getMuteGrup, setMuteGrup, daftarMuteGrup } = gs.exports;

// ── 1. State ──────────────────────────────────────────────────────────────────
const G1 = '120363418054099388@g.us';
const G2 = '120363999999999999@g.us';

assert.strictEqual(getMuteGrup(1, G1), false, 'fresh start harus belum dibisukan');
setMuteGrup(1, G1, true);
assert.strictEqual(getMuteGrup(1, G1), true, 'setelah .mute harus kebaca true');
assert.strictEqual(getMuteGrup(1, G2), false, 'grup lain nggak boleh ikut kebisukan');
assert.strictEqual(getMuteGrup(2, G1), false, 'bot lain nggak boleh ikut kebisukan');
assert.deepStrictEqual(daftarMuteGrup(1), [G1], '.listmute harus nampilin grup itu');
assert.deepStrictEqual(daftarMuteGrup(2), [], '.listmute bot lain harus kosong');

setMuteGrup(1, G2, true);
assert.strictEqual(daftarMuteGrup(1).length, 2, 'dua grup ke-mute kebaca dua');

setMuteGrup(1, G1, false);
assert.strictEqual(getMuteGrup(1, G1), false, '.unmute harus beneran mencabut');
assert.deepStrictEqual(daftarMuteGrup(1), [G2], 'grup yang di-unmute harus hilang dari daftar');
assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(FILE, 'utf8'))).includes(`${1}:mute:${G1}`),
  '.unmute harus buang kuncinya dari file, bukan cuma di-set false');

// ── 2. Tahan restart ─────────────────────────────────────────────────────────
// Baca ulang dari disk = simulasi restart. Dulu state `mute` ikut hilang.
const isi = fs.readFileSync(FILE, 'utf8');
const gs2 = { exports: {} };
new Function('module', 'exports', 'require', '__dirname', SUMBER)(
  gs2, gs2.exports, require, path.join(AKAR, 'config')
);
assert.deepStrictEqual(gs2.exports.daftarMuteGrup(1), [G2],
  'mute harus masih ada setelah restart (harus ke-disk, bukan RAM doang)');

// ── 3. Guard engine ──────────────────────────────────────────────────────────
// Guard-nya sengaja diambil dari file asli, bukan ditulis ulang di tes — kalau
// ada yang nyabut guard-nya, tes ini merah.
const engineBabak = fs.readFileSync(path.join(AKAR, 'engine', 'whatsappEngine.js'), 'utf8');
const barisGuard = engineBabak.split('\n').filter((l) => l.includes('BEBAS_SAAT_MUTE.has(ctx.command)'));
assert.strictEqual(barisGuard.length, 1, 'harus ada tepat 1 guard mute di engine');
assert.ok(barisGuard[0].includes('getMuteGrup(botId, ctx.jid)'),
  'guard harus cek state mute pakai getMuteGrup(botId, jid)');

const barisBebas = engineBabak.split('\n').find((l) => l.includes('const BEBAS_SAAT_MUTE'));
assert.ok(barisBebas && barisBebas.includes("'unmute'") && barisBebas.includes("'listmute'"),
  'unmute + listmute harus bebas dari mute, kalau nggak nggak ada jalan keluar');

// Guard harus di atas gerbang balasan "bot" dan di atas dispatch plugin
const idxGuard  = engineBabak.indexOf('BEBAS_SAAT_MUTE.has(ctx.command)');
const idxBalas  = engineBabak.indexOf("ctx.body.trim().toLowerCase() === 'bot'");
const idxPlugin = engineBabak.indexOf('Plugin error [');
assert.ok(idxGuard > 0 && idxBalas > idxGuard, 'guard mute harus jalan sebelum balasan "bot"');
assert.ok(idxPlugin > idxGuard, 'guard mute harus jalan sebelum dispatch plugin');

// ── 4. `.mute` nggak boleh nyentuh setting grup WhatsApp lagi ────────────────
const plugin = fs.readFileSync(path.join(AKAR, 'plugins', '02-group.js'), 'utf8');
const blokMute = plugin.slice(plugin.indexOf("case 'mute':"), plugin.indexOf("case 'slowmode':"));
assert.ok(!/setSetting\s*\(\s*jid\s*,\s*'mute'/.test(blokMute),
  '.mute dilarang manggil setSetting(jid, "mute") — di adapter itu jatuh ke `announcement` = nge-lock grup, persis `.close`');
assert.ok(blokMute.includes('setMuteGrup(botData.id, jid, true)'), '.mute harus nyetel state mute bot');
assert.ok(plugin.includes('setMuteGrup(botData.id, jid, false)'), '.unmute harus nyabut state mute');

console.log('OK mute-grup: state per grup, tahan restart, guard engine, .mute nggak nyentuh announce');
