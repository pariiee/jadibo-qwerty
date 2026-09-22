'use strict';
// Restart per bot harus SATU jalur dan cuma boleh punya SATU soket WA.
//
// Dua-duanya pernah bikin bug nyata:
//  1. stopWhatsAppBot() selesai sebelum close koneksi lama dipegang, jadi loop
//     auto-reconnect (5 detik) ikut nyalain bot-nya, terus restartWhatsAppBot()
//     nyalain lagi -> dua soket WA ke nomor yang sama -> WA mutus salah satunya
//     -> bot kelihatan online tapi nggak jawab / drop-terus.
//  2. restartingBots kebuang di stopWhatsAppBot() sebelum guard baca -> restart
//     kebaca sebagai "di-stop manual", dan guard-nya nggak pernah kejalan
//     (0x di log VPS walau .restart udah dipakai).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(dir, 'engine', 'whatsappEngine.js'), 'utf8');

// Ambil badan sebuah fungsi biar urutan pernyataannya bisa diuji, bukan cuma
// "string-nya ada di file".
function body(name) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i > -1, `${name} harus ada`);
  // CRLF-safe: checkout Windows nulis `\r\n}\r\n`, jadi indexOf('\n}\n')
  // nggak pernah kena -> body() balikin sampai EOF dan assert malah baca
  // kode fungsi lain (pernah bikin tes ini merah cuma di Windows).
  const m = /\r?\n\}\r?\n/.exec(src.slice(i));
  return src.slice(i, m ? i + m.index : src.length);
}

const stop = body('stopWhatsAppBot');
const guardStart = src.indexOf("if (status === 'close')");
const guard = src.slice(guardStart, src.indexOf("if (isLogout)", guardStart));
const start = body('startWhatsAppBot');
const inBg = body('restartWhatsAppBotInBackground');

// 1. startWhatsAppBot nolak soket kedua buat bot yang sama
assert.ok(/if \(activeBots\.has\(botId\)\) \{ throw/.test(start),
  'startWhatsAppBot harus nolak start kalau bot-nya masih aktif (anti dua soket)');

// 2. stopWhatsAppBot nunggu close beneran dipegang, bukan nebak pakai timer
assert.ok(/const wasRestarting = restartingBots\.has\(botId\)/.test(stop),
  'stopWhatsAppBot harus tahu ini restart atau stop');
assert.ok(/stopCloseWaiters\.set\(botId/.test(stop), 'stop harus daftar penunggu close');
assert.ok(/await Promise\.race\(\[closeWait,/.test(stop),
  'stop harus nunggu close (dengan batas waktu biar nggak nyangkut)');
assert.ok(/if \(!closeWaited\)/.test(stop),
  'jangan nunggu kalau close-nya udah lewat duluan');

// 3. URUTAN di guard: release penunggu DULU, baru baca stoppingBots.
//    Kalau kebalik, stoppingBots bisa udah kebuang pas guard baca.
const iRelease = guard.indexOf('releaseStop()');
const iGuard = guard.indexOf('stoppingBots.has(botId)');
assert.ok(iRelease > -1 && iGuard > -1, 'guard harus release penunggu + cek stoppingBots');
assert.ok(iRelease < iGuard, 'release penunggu harus SEBELUM cek stoppingBots');

// 4. Pas restart: guard nggak boleh nerusin ke auto-reconnect, dan restartingBots
//    jangan kebuang di stopWhatsAppBot
assert.ok(/const isRestart = restartingBots\.delete\(botId\)/.test(guard),
  'guard harus baca restartingBots buat milih log');
assert.ok(/if \(!isRestart\)[\s\S]{0,300}?is_running = 0[\s\S]{0,100}?return;/.test(guard),
  'yang nol-in is_running cuma aksi stop eksplisit');
assert.ok(/if \(!wasRestarting\) restartingBots\.delete\(botId\)/.test(stop),
  'restartingBots cuma boleh dibuang kalau bukan restart');

// 5. Satu jalur: command WA == tombol web
assert.ok(/return restartWhatsAppBot\(botId\)/.test(inBg),
  'restartWhatsAppBotInBackground harus delegasi ke restartWhatsAppBot');
assert.ok(!/stopWhatsAppBot/.test(inBg),
  'restartWhatsAppBotInBackground jangan punya logika stop/start sendiri');
const owner = fs.readFileSync(path.join(dir, 'plugins', '05-owner.js'), 'utf8');
assert.ok(/restartWhatsAppBotInBackground|restartWhatsAppBot\(/.test(owner),
  'command .restart harus lewat mesin restart');
const ctrl = fs.readFileSync(path.join(dir, 'controllers', 'botController.js'), 'utf8');
const ctrlRestart = ctrl.slice(ctrl.indexOf('async function restartBot'));
assert.ok(/engineBus\.restart\(/.test(ctrlRestart),
  'route web harus nitip restart ke worker');
assert.ok(!/restartWhatsAppBot|stopWhatsAppBot/.test(ctrl),
  'web jangan megang engine bot langsung — itu kerjaan worker');
// Worker-nya sendiri yang manggil mesin restart yang sama kayak command .restart
const worker = fs.readFileSync(path.join(dir, 'workers', 'botWorker.js'), 'utf8');
assert.ok(/wa\.restartWhatsAppBot\(botId\)/.test(worker),
  'worker harus lewat restartWhatsAppBot — satu jalur sama command .restart');

console.log('✓ restart: satu jalur, satu soket, stop ditunggu, log jujur');
