// Anti-delete: uji perilaku sebenarnya, bukan baca kode.
// Kasus yang bikin fitur ini "kelihatan rusak" di lapangan:
//   1. yang dihapus = media (bukan teks)
//   2. yang dihapus = balasan BOT sendiri (fromMe:true -> engine skip -> store kosong)
//   3. media gagal diunduh -> user harus dikasih tahu, bukan diem
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const ROOT   = path.join(__dirname, '..');
const GROUP  = '120363418054099388@g.us';

// Plugin bikin path store dari __dirname + '..', jadi kita siapkan file aslinya
// dulu, tulis di tempat nyata, lalu bersihkan (data/*.json udah di-gitignore).
const PROTEKSI = path.join(ROOT, 'sessions', 'proteksi-settings.json');
const STORE    = path.join(ROOT, 'data', 'antidelete-store.json');
const bakProteksi = fs.existsSync(PROTEKSI) ? fs.readFileSync(PROTEKSI) : null;
const bakStore    = fs.existsSync(STORE) ? fs.readFileSync(STORE) : null;

function restore() {
  try { bakProteksi !== null ? fs.writeFileSync(PROTEKSI, bakProteksi) : fs.rmSync(PROTEKSI, { force: true }); } catch {}
  try { bakStore    !== null ? fs.writeFileSync(STORE, bakStore)       : fs.rmSync(STORE, { force: true }); } catch {}
}

(async () => {
  const sent = [];
  const fakeClient = {
    message: {
      send: async (jid, content) => { sent.push({ jid, content }); return { key: { id: 'x' } }; },
      // Simulasi server WA: kebanyakan media lama udah nggak bisa diunduh.
      downloadBytes: async (src) => {
        const t = Object.keys(src)[0];
        if (process.env.AD_DL_FAIL) throw new Error('media expired');
        return Buffer.from(`BUF:${t}`);
      },
    },
  };
  const ctx = (extra) => ({ isCmd: false, isGroup: true, jid: GROUP, client: fakeClient, ...extra });

  // grup uji: antidelete nyala
  fs.mkdirSync(path.dirname(PROTEKSI), { recursive: true });
  fs.writeFileSync(PROTEKSI, JSON.stringify({ [GROUP]: { antidelete: true } }));
  try { fs.rmSync(STORE, { force: true }); } catch {}

  delete require.cache[require.resolve(path.join(ROOT, 'plugins', '02-group.js'))];
  const handler = require(path.join(ROOT, 'plugins', '02-group.js'));

  // 1) pesan MASUK (gambar) -> harus tersimpan, lalu kehapus -> dikirim ulang
  await handler(ctx({
    msg: { key: { remoteJid: GROUP, id: 'IMG1', fromMe: false }, message: {
      imageMessage: { mediaKey: Buffer.from([1, 2, 3]), mimetype: 'image/jpeg', caption: 'foto asli' } } },
  }));
  assert.ok(fs.existsSync(STORE), '1. store harus ditulis ke disk (persisten)');
  const onDisk = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  assert.strictEqual(onDisk.length, 1, '1. satu pesan tersimpan di disk');
  assert.strictEqual(onDisk[0].id, 'IMG1');
  assert.strictEqual(onDisk[0].message.imageMessage.mediaKey.type, 'Buffer', 'Buffer ke-serialize sebagai JSON (nanti di-revive)');

  await handler(ctx({
    msg: { key: { remoteJid: GROUP, id: 'DEL1', fromMe: false, participant: '628111@s.whatsapp.net' },
           message: { protocolMessage: { type: 0, key: { remoteJid: GROUP, id: 'IMG1' } } } },
  }));
  assert.strictEqual(sent.length, 1, '1. media harus dikirim ulang setelah dihapus');
  assert.strictEqual(sent[0].content.type, 'image');
  assert.ok(String(sent[0].content.caption).includes('Anti-Delete'), '1. caption ada header anti-delete');
  assert.ok(String(sent[0].content.caption).includes('foto asli'), '1. caption asli ikut diselamatkan');
  assert.deepStrictEqual(sent[0].content.media, Buffer.from('BUF:imageMessage'));

  // 2) pesan KELUAR dari bot (fromMe) -> HARUS disimpan (biar bisa dikirim ulang
  //    saat dihapus), tapi delete yang datang dengan fromMe=true = perintah hapus
  //    dari bot/owner -> jangan dibalas.
  sent.length = 0;
  await handler(ctx({
    msg: { key: { remoteJid: GROUP, id: 'BOT1', fromMe: true }, message: {
      imageMessage: { mediaKey: Buffer.from([9]), mimetype: 'image/png', caption: 'balasan bot' } } },
  }));
  const disk2 = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  assert.strictEqual(disk2.length, 2, '2. pesan keluar bot ikut tersimpan');
  await handler(ctx({
    msg: { key: { remoteJid: GROUP, id: 'DEL2', fromMe: true, participant: '628111@s.whatsapp.net' },
           message: { protocolMessage: { type: 0, key: { remoteJid: GROUP, id: 'BOT1' } } } },
  }));
  assert.strictEqual(sent.length, 0, '2. hapus dari bot/owner (fromMe) di-skip, nggak balas');

  // 2b) member lain hapus pesan bot -> baru dibalas, dan teks aslinya dikutip
  await handler(ctx({
    msg: { key: { remoteJid: GROUP, id: 'DEL2b', fromMe: false, participant: '628999@s.whatsapp.net' },
           message: { protocolMessage: { type: 0, key: { remoteJid: GROUP, id: 'BOT1' } } } },
  }));
  assert.strictEqual(sent.length, 1, '2b. hapus oleh member biasa tetap dibalas');
  assert.ok(String(sent[0].content.caption).includes('> balasan bot'), '2b. isi asli tampil sebagai kutipan (>)');

  // 3) media gagal diunduh -> user dikasih tahu, bukan diem
  sent.length = 0;
  process.env.AD_DL_FAIL = '1';
  await handler(ctx({
    msg: { key: { remoteJid: GROUP, id: 'DEL3', fromMe: false, participant: '628111@s.whatsapp.net' },
           message: { protocolMessage: { type: 0, key: { remoteJid: GROUP, id: 'IMG1' } } } },
  }));
  delete process.env.AD_DL_FAIL;
  assert.strictEqual(sent.length, 1, '3. gagal unduh tetap ada balasan (bukan senyap)');
  assert.ok(/nggak bisa diunduh/.test(sent[0].content.text), '3. balasannya menjelaskan medianya nggak bisa diunduh');

  // 4) grup yang antidelete-nya MATI -> jangan ganggu
  sent.length = 0;
  await handler(ctx({
    jid: '999@g.us',
    msg: { key: { remoteJid: '999@g.us', id: 'DEL9', fromMe: true },
           message: { protocolMessage: { type: 0, key: { remoteJid: GROUP, id: 'IMG1' } } } },
  }));
  assert.strictEqual(sent.length, 0, '4. grup tanpa antidelete nggak dibalas');

  // 5) RESTART BOT: store harus selamat -> pesan lama masih bisa dikirim ulang.
  //    Ini kasus lapangan yang paling sering: bot restart (deploy/crash), user
  //    hapus pesan lama, dan store RAM udah kosong.
  sent.length = 0;
  delete require.cache[require.resolve(path.join(ROOT, 'plugins', '02-group.js'))];
  const handlerSetelahRestart = require(path.join(ROOT, 'plugins', '02-group.js'));
  await handlerSetelahRestart(ctx({
    msg: { key: { remoteJid: GROUP, id: 'DEL4', fromMe: false, participant: '628111@s.whatsapp.net' },
           message: { protocolMessage: { type: 0, key: { remoteJid: GROUP, id: 'BOT1' } } } },
  }));
  assert.strictEqual(sent.length, 1, '5. setelah restart, pesan lama masih bisa dikirim ulang');
  assert.ok(String(sent[0].content.caption).includes('balasan bot'), '5. isinya utuh setelah restart');

  restore();
  console.log('✓ antidelete: persisten + pesan keluar bot + media gagal terlihat + grup mati aman');
})().catch((e) => { restore(); console.error('✗', e.message); process.exit(1); });
