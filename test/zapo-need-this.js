'use strict';
/**
 * test/zapo-need-this.js
 *
 * Kenapa tes ini ada: 2026-09-28 semua command WA di engine zapo mati dengan
 * `Cannot read properties of undefined (reading 'messageDispatch')` walaupun
 * `zapo-adapter-coverage.js` hijau. Sebabnya BUKAN method yang nggak ada,
 * tapi `this` yang lepas: adapter lama nulis `client.message?.send` (ambil
 * fungsi lepas dari objeknya) lalu memanggilnya. Di zapo-js 1.8.2 method itu
 * prototype method yang baca field milik instance-nya (`this.messageDispatch`,
 * `this.download`) -> `this` jadi `client` -> undefined -> SEMUA command mati.
 *
 * Tes ini meniru zapo 1.8.2 dengan benar dan memastikan:
 *   1. adapter tetap mengikat `this` ke objek zapo-nya (bukan `client`);
 *   2. kalau seseorang melepas ikatannya lagi, tes GAGAL (jadi bug ini nggak
 *      bisa balik diam-diam).
 *
 * Jalankan: node test/zapo-need-this.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'engine', 'zapo', 'client.js'), 'utf8');

let lolos = 0;
/** Nunggu promise-nya — kalau nggak, rejection async lolos diam-diam jadi unhandled. */
const tes = async (nama, fn) => {
  try { await fn(); console.log(`  ✓ ${nama}`); lolos++; }
  catch (e) { console.error(`  ✗ ${nama}\n     ${e.message}`); process.exitCode = 1; }
};
const daftar = [];
const it = (nama, fn) => { daftar.push([nama, fn]); };

console.log('── need(): this jangan lepas ──');

// Ambil ulang bentuk tiruan zapo-js 1.8.2 (BUKAN arrow function).
class WaMessageCoordinator {
  constructor(dispatch) { this.messageDispatch = dispatch; }
  async send(to, content) { return this.messageDispatch.sendMessage(to, content); }
  async downloadBytes(src) { return `bytes:${src}`; }
}
class WaGroupCoordinator {
  constructor(groups) { this._groups = groups; }
  async queryAllGroups() { return this._groups; }
}
class WaClient {
  constructor() {
    this.message = new WaMessageCoordinator({ sendMessage: (to, c) => ({ to, c, id: 'MSG1' }) });
    this.group = new WaGroupCoordinator(['g1', 'g2']);
  }
}

/**
 * Adapter memang pakai `need(...)` di dalam modulnya, bukan diekspor. Jadi kita
 * bikin instance-nya lewat pola yang SAMA: potong implementasi `need` dari
 * sumber dan jalankan di atas tiruan WaClient -- persis seperti adapter asli.
 */
const potong = SRC.match(/const need = \(path, fn\) => \{[\s\S]*?\n  \};/);
assert.ok(potong, 'pola `const need = (path, fn) => {` nggak ketemu di adapter — refactor? perbarui tes ini');
// `need` aslinya nempel ke `client` lewat closure, jadi `client` WAJIB ada di scope yang sama.
const bikinNeed = eval(`(client => { ${potong[0]}; return need; })`);

it('call-site pakai pola `client.x?.y` (objeknya tetap kebaca)', () => {
  const n = SRC.match(/need\('client\.[a-zA-Z.]+', client\.[a-zA-Z.]+(\?\.)?[a-zA-Z]+\)/g) || [];
  assert.ok(n.length >= 25, `cuma ${n.length} call-site need() kebaca — pola berubah?`);
});

it('kirim pesan ikut mengikat `this` ke client.message (bukan client)', async () => {
  const client = new WaClient();
  const need = bikinNeed(client);
  const send = need('client.message.send', client.message?.send);
  const hasil = await send('628@s.whatsapp.net', { text: 'halo' });
  assert.strictEqual(hasil.id, 'MSG1');
  assert.strictEqual(hasil.c.text, 'halo');
});

it('method lain (downloadBytes/queryAllGroups) ikut kebawa this-nya', async () => {
  const client = new WaClient();
  const need = bikinNeed(client);
  assert.strictEqual(await need('client.message.downloadBytes', client.message?.downloadBytes)('x'), 'bytes:x');
  assert.deepStrictEqual(await need('client.group.queryAllGroups', client.group?.queryAllGroups)(), ['g1', 'g2']);
});

it('BUKTI BUG LAMA: fungsi lepas -> this salah -> "messageDispatch" undefined', async () => {
  const client = new WaClient();
  const lepas = client.message.send; // gaya adapter SEBELUM diperbaiki (tanpa apply)
  await assert.rejects(() => lepas('x', { text: 'y' }), /messageDispatch/);
});

it('method hilang tetap error jelas (bukan "undefined is not a function")', () => {
  const client = new WaClient();
  const need = bikinNeed(client);
  assert.throws(() => need('client.group.ngawur', client.group?.ngawur), /tidak punya/);
});

// Urutan penting: tes async harus ditunggu, kalau nggak rejection-nya lolos diam-diam.
(async () => {
  for (const [nama, fn] of daftar) await tes(nama, fn);
  console.log(`\n${process.exitCode ? '❌' : '✅'} need() mengikat this dengan benar (${lolos}/${daftar.length} tes)`);
})();
