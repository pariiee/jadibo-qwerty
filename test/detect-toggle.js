'use strict';
// `.on detect` / `.off detect` — saklar notifikasi perubahan grup.
//
// Yang dijaga: satu fitur cuma boleh punya SATU jalan buat nyalain/matiin, dan
// jalan itu nulis kolom yang bener (`group_settings.detect`). Dulu ada
// `.setdetect` / `.deldetect` di 02-group.js yang nulis kolom yang sama lewat
// INSERT sendiri — dua jalan, dua pesan beda. Sekarang cuma lewat `.on`/`.off`.
//
// Tesnya jalanin handler aslinya, bukan cocokin regex doang.
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const root = path.join(__dirname, '..');

// ── Stub pool + globalSettings SEBELUM plugin di-require ─────────────────────
const db      = { detect: 0, autoacc: 0, document: 0, welcome_on: 1, bye_on: 1 };
const sqlLog  = [];
const dbPath  = require.resolve(path.join(root, 'config/database.js'));
const gsPath  = require.resolve(path.join(root, 'config/globalSettings.js'));

require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    pool: {
      async execute(sql, params) {
        sqlLog.push(sql.replace(/\s+/g, ' ').trim());
        if (/^\s*SELECT/i.test(sql)) return [[{ ...db }], []];
        return [{ affectedRows: 1 }, []];
      },
    },
  },
};
require.cache[gsPath] = {
  id: gsPath, filename: gsPath, loaded: true,
  exports: { getBotGlobalSetting: () => false, setBotGlobalSetting: () => {} },
};

const handler = require(path.join(root, 'plugins/06-proteksi.js'));

function ctx(command, args) {
  const balasan = [];
  return {
    balasan,
    ctx: {
      isGroup: true, jid: '123@g.us', sender: '628111@lid', body: '', isCmd: true,
      command, args, pushName: 'Tester', msg: { key: { id: 'x' } },
      isAdmin: true, isOwner: false,
      botData: { id: 1, prefix: '.', owner_number: '6287778032605' },
      reply: async (t) => balasan.push(typeof t === 'string' ? t : t?.text || ''),
      client: { message: { send: async () => {} } },
    },
  };
}

(async () => {
  // 1. `.on detect` → INSERT ke kolom `detect` dengan nilai 1.
  db.detect = 0; sqlLog.length = 0;
  let t = ctx('on', ['detect']);
  assert.strictEqual(await handler(t.ctx), true, '.on detect harus dihandle plugin');
  const ins = sqlLog.find(s => /^INSERT INTO group_settings/i.test(s));
  assert.ok(ins, '.on detect harus nulis ke group_settings');
  assert.ok(/\(bot_id, group_jid, detect\)/i.test(ins), `kolomnya harus detect, dapat: ${ins}`);
  assert.ok(/detect = VALUES\(detect\)/i.test(ins), 'harus update kolom detect, bukan yang lain');
  assert.ok(/Diaktifkan/.test(t.balasan.join(' ')), 'harus bilang aktif');

  // 2. `.off detect` → nilai 0, kolom yang sama.
  db.detect = 1; sqlLog.length = 0;
  t = ctx('off', ['detect']);
  await handler(t.ctx);
  const off = sqlLog.find(s => /^INSERT INTO group_settings/i.test(s));
  assert.ok(/detect = VALUES\(detect\)/i.test(off), 'off harus nulis kolom detect juga');
  assert.ok(/Dinonaktifkan/.test(t.balasan.join(' ')), 'harus bilang nonaktif');

  // 3. Saklarnya cuma satu jalan — nggak ada command toggle sendiri.
  const proteksi = fs.readFileSync(path.join(root, 'plugins/06-proteksi.js'), 'utf8');
  assert.ok(!/setdetect|deldetect/.test(proteksi), 'detect nggak boleh punya command toggle sendiri');
  assert.ok(/detect:.*scope: 'db'/.test(proteksi), 'detect harus kecatat scope db di FITUR_INFO');
  assert.ok(/baris\('detect',\s*dbCfg\.detect\)/.test(proteksi), '.on polos harus nampilin status detect');

  // 4. Command jadul dicabut dari case + registry (hapus, bukan disembunyiin).
  const grup = fs.readFileSync(path.join(root, 'plugins/02-group.js'), 'utf8');
  const info = fs.readFileSync(path.join(root, 'plugins/01-info.js'), 'utf8');
  assert.ok(!/case 'setdetect'/.test(grup), '.setdetect harus dihapus dari case');
  assert.ok(!/case 'deldetect'/.test(grup), '.deldetect harus dihapus dari case');
  assert.ok(!/'setdetect'|'deldetect'/.test(info), 'setdetect/deldetect masih nyangkut di daftar command');

  // 5. Engine beneran gerbangin notifikasi pakai kolom `detect`.
  const engine = fs.readFileSync(path.join(root, 'engine/whatsappEngine.js'), 'utf8');
  assert.ok(/SELECT detect FROM group_settings/.test(engine), 'engine harus SELECT detect');
  assert.ok(/if \(gsRows\[0\]\?\.detect\)/.test(engine), 'engine harus gerbangin pakai kolom detect');

  console.log('✓ detect: cuma lewat .on/.off, nulis kolom detect, command jadul udah dicabut');
})();
