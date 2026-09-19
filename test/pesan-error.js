'use strict';
/**
 * test/pesan-error.js — pesan error ke user harus kalimat manusia, bukan dump
 * `connect ETIMEDOUT 172.64.80.1:443; connect ENETUNREACH 2606:4700::443 - Local (:::0)`.
 */
const assert = require('assert');
const { rapikanError } = require('../engine/pesanError');

const KASUS = [
  // [error yang keluar dari Node/axios, kunci yang WAJIB ada di balasan]
  [new Error('connect ETIMEDOUT 172.64.80.1:443; connect ENETUNREACH 2606:4700:130:436c:6f75:6466:6c61:7265:443 - Local (:::0)'),
   'timeout'],
  [new Error('getaddrinfo ENOTFOUND cdn.tiktok.com'), 'nggak ketemu'],
  [new Error('connect ECONNREFUSED 127.0.0.1:3000'), 'nolak koneksi'],
  [new Error('ECONNRESET'), 'putus di tengah jalan'],
  [new Error('Request failed with status code 404'), 'link-nya nggak valid'],
  [new Error('Request failed with status code 502'), 'lagi error'],
  [new Error('timeout of 15000ms exceeded'), 'timeout'],
  [new Error('ffmpeg exited with code 1'), 'ffmpeg'],
  [new Error('ENOSPC: no space left on device'), 'penuh'],
  [new Error('413 Payload Too Large'), 'kebesaran'],
  [new Error("Cannot read properties of undefined (reading 'replace')"), 'gangguan teknis'],
  [new Error('EUNKNOWNCODE: ada yang aneh'), 'gangguan teknis'],   // teknis tanpa aturan: jangan bocorin mentah
  // Kasus yang dilaporkan user: BE balikin "Command failed: /usr/local/bin/yt-dlp …"
  [new Error('Command failed: /usr/local/bin/yt-dlp --dump-json --no-playlist https://www.1024tera.com/x\nERROR: Unsupported URL: https://www.1024tera.com/x'),
   'belum didukung'],
];

let pass = 0, fail = 0;
const OK = (nama, fn) => { try { fn(); console.log('  ok  ' + nama); pass++; } catch (e) { console.log('  FAIL ' + nama + ' → ' + e.message); fail++; } };

console.log('pesan-error:');

for (const [err, kunci] of KASUS) {
  OK(`"${err.message.slice(0, 42)}…" → nyebut "${kunci}"`, () => {
    const out = rapikanError(err);
    assert.ok(out.includes(kunci), `dapat: "${out}"`);
    // yang penting: user JANGAN dikasih IP/port/code mentah
    assert.ok(!/E[A-Z]{3,}\b/.test(out), `masih ada kode error mentah: "${out}"`);
    assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(out), `masih ada IP mentah: "${out}"`);
    assert.ok(!/:::|2606:/.test(out), `masih ada alamat IPv6 mentah: "${out}"`);
    // jejak isi server juga nggak boleh lolos
    assert.ok(!/\/usr\/local\/bin|\/var\/www|Command failed|\bat\s+\w+\s*\(/.test(out), `masih bocorin isi server: "${out}"`);
  });
}

OK('error axios dari API sendiri → pakai pesan yang sudah dirapikan server', () => {
  const err = new Error('Request failed with status code 500');
  err.response = { status: 500, data: { success: false, message: 'Link-nya belum didukung. Coba link lain ya.' } };
  assert.strictEqual(rapikanError(err), 'Link-nya belum didukung. Coba link lain ya.');
});

OK('error axios yang pesannya masih mentah → tetap diterjemahin lokal', () => {
  const err = new Error('Request failed with status code 500');
  err.response = { status: 500, data: { message: 'Command failed: /usr/local/bin/yt-dlp https://x' } };
  const out = rapikanError(err);
  assert.ok(!/Command failed|\/usr\/local\/bin/.test(out), out);
});

OK('err null/undefined → tetap kalimat manusia', () => {
  assert.ok(rapikanError(null).length > 5);
  assert.ok(rapikanError(undefined).length > 5);
});

OK('error yang SUDAH ramah nggak diutak-atik', () => {
  const ramah = 'Format data soal tidak valid dari API';
  assert.strictEqual(rapikanError(new Error(ramah)), ramah);
});

OK('teks user (bisa panjang & ada angka) juga dibiarin', () => {
  const t = 'Jawaban salah, coba lagi ya!';
  assert.strictEqual(rapikanError(new Error(t)), t);
});

console.log(`\npesan-error: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
