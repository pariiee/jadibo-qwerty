'use strict';

/**
 * test/menu-buttons.js
 * `.menu` harus kirim SATU bubble `buttonsMessage` berisi: header lokasi
 * (thumbnail banner + teks menu) dan dua tombol sebaris — `Menu` (`single_select`,
 * ALL + 10 kategori) + `Owner`. Sub-menu (`.menu <kat>` / `.menu all`) WAJIB pakai
 * bubble yang sama, bukan balik jadi teks polos.
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.resolve(__dirname, '..');
const info = require(path.join(ROOT, 'plugins/01-info.js'));

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

// ctx minimal: cukup buat case 'menu' (DB gagal → jatuh ke nilai bawaan).
// `send` nyimpen SEMUA argumen — jadi kelihatan kalau `.menu` ngirim >1 bubble.
const sent = [];
const push = (...a) => sent.push(a);
const baseCtx = {
  isCmd: true, command: 'menu', args: [],
  botData: { id: 1, prefix: '.', bot_name: 'Qwerty', banner_url: 'assets/banner.jpg',
             footer_text: '© yaparibotz', description: 'tes' },
  client: { message: { send: push } },
  sock:   { message: { send: push } },
  reply:  async () => {}, react: async () => {}, isGroup: false,
  jid: '6281234567890@s.whatsapp.net', sender: '6281234567890@s.whatsapp.net',
  pushName: 'Al', isOwner: true, isPremium: false, isAdmin: false, msg: { message: {} },
};
const ctx = baseCtx;

(async () => {
  await info(ctx);

  await ok('menu = 1 bubble `buttonsMessage`; sisa bubble cuma audio (AUDIO_DEFAULT)', () => {
    const btns = sent.filter(a => a[1] && a[1].buttonsMessage);
    assert.strictEqual(btns.length, 1, `dapat ${btns.length} bubble tombol`);
    const teksGambar = sent.filter(a => a[1] && (a[1].type === 'text' || a[1].type === 'image'));
    assert.strictEqual(teksGambar.length, 0, 'menu masih dikirim sebagai bubble teks/gambar terpisah');
    assert.ok(sent.length <= 2, `bubble kebanyakan: ${sent.length}`);
  });

  await ok('header lokasi bawa thumbnail (pola .test3)', () => {
    const b = sent[0][1].buttonsMessage;
    assert.strictEqual(b.headerType, 6);
    assert.strictEqual(b.locationMessage.degreesLatitude, 0);
    assert.strictEqual(b.locationMessage.degreesLongitude, 0);
    const thumb = b.locationMessage.jpegThumbnail;
    assert.ok(thumb && thumb.length > 1000, `thumbnail kosong/terlalu kecil: ${thumb && thumb.length}`);
    assert.ok(thumb[0] === 0xff && thumb[1] === 0xd8, 'bukan JPEG');
  });

  await ok('teks menu ikut + dipotong di batas 1024 char WA', () => {
    const body = sent[0][1].buttonsMessage.contentText;
    assert.ok(body.includes('INFO USER & BOT'), 'box INFO hilang');
    assert.ok(body.includes('MENU CATEGORY'), 'box kategori hilang');
    assert.ok(/│ ◦ [A-Z ]+ \(\d+ Fitur\)/.test(body), 'kategori nggak per baris lagi');
    const catsTxt = [...body.matchAll(/│ ◦ ([A-Z ]+?) \(\d+ Fitur\)/g)].map(m => m[1]);
    assert.deepStrictEqual(catsTxt, [...catsTxt].sort(), `kategori teks nggak urut a-z: ${catsTxt}`);
    assert.ok(body.includes('╰────'), 'box penutup hilang');
    assert.ok(body.length <= 1024, `kepanjangan: ${body.length} char`);
  });

  await ok('tombol sebaris: Menu single_select (ALL + 10 kategori) + Owner', () => {
    const btns = sent[0][1].buttonsMessage.buttons;
    assert.strictEqual(btns.length, 2);
    assert.strictEqual(btns[0].buttonText.displayText, 'Menu');
    assert.strictEqual(btns[0].nativeFlowInfo.name, 'single_select');
    const d = JSON.parse(btns[0].nativeFlowInfo.paramsJson);
    assert.strictEqual(d.title, 'Menu Category');
    assert.strictEqual(d.sections[0].title, 'INI SEMUA MENU CATEGORY BOT GWEH');
    assert.strictEqual(d.sections[0].highlight_label, 'recommended');
    assert.strictEqual(d.sections[0].rows[0].id, '.menu all', 'ALL nggak di baris paling atas');
    assert.strictEqual(d.sections[0].rows[0].title, 'ALL');
    const rows = JSON.parse(btns[0].nativeFlowInfo.paramsJson).sections[0].rows;
    assert.strictEqual(rows.length, 11, `dapat ${rows.length} rows (ALL + 10 kategori)`);
    assert.match(rows[0].id, /^\.menu \w+$/, `row id salah: ${rows[0].id}`);
    const catRows = rows.slice(1).map(r => r.id.slice(6));
    assert.deepStrictEqual(catRows, [...catRows].sort(), `kategori dropdown nggak urut a-z: ${catRows}`);
    assert.strictEqual(btns[1].buttonId, 'btn_owner');
    assert.strictEqual(btns[1].buttonText.displayText, 'Owner');
    assert.strictEqual(btns[1].type, 1);
    assert.ok(!btns[1].nativeFlowInfo, 'Owner nggak boleh single_select');
    const loc = sent[0][1].buttonsMessage.locationMessage;
    assert.strictEqual(loc.address, 'Jadibot? labs.yapari.web.id');
    assert.ok(loc.degreesLatitude === 0 && loc.degreesLongitude === 0, 'koordinat bukan 0,0');
  });

  // Thumbnail harus lolos jalur kirim utuh (upload-nya lewat proto, bukan media).
  await ok('payload selamat lewat normalizeMessageContent (Baileys)', () => {
    const { generateWAMessageFromContent, normalizeMessageContent } = require('baileys');
    const wam = generateWAMessageFromContent('g@g.us', sent[0][1], { userJid: 'me@s.whatsapp.net' });
    const b = normalizeMessageContent(wam.message).buttonsMessage;
    assert.strictEqual(b.buttons[0].nativeFlowInfo.name, 'single_select');
    assert.ok(b.locationMessage.jpegThumbnail.length > 1000, 'thumbnail dibuang di jalur kirim');
    assert.strictEqual(b.locationMessage.address, 'Jadibot? labs.yapari.web.id');
  });

  await ok('sub-menu (.menu info / .menu all) pakai bubble yang sama — banner + tombol Menu SAJA', async () => {
    for (const arg of ['info', 'all']) {
      sent.length = 0;
      await info(Object.assign({}, baseCtx, { args: [arg] }));
      const m = sent.find(a => a[1] && a[1].buttonsMessage);
      assert.ok(m, `'.menu ${arg}' nggak ngirim buttonsMessage — balik ke teks polos?`);
      const bm = m[1].buttonsMessage;
      assert.ok(bm.locationMessage.jpegThumbnail, `'.menu ${arg}' kehilangan banner`);
      assert.deepStrictEqual(bm.buttons.map(b => b.buttonText.displayText), ['Menu'],
        `'.menu ${arg}' harusnya cuma tombol Menu (Owner cuma di .menu)`);
      assert.ok(!bm.buttons.some(b => b.buttonId === 'btn_owner'), `'.menu ${arg}' masih bawa tombol Owner`);
      assert.ok(bm.footerText, `'.menu ${arg}' kehilangan footer`);
      assert.strictEqual(bm.footerText, baseCtx.botData.footer_text, `'.menu ${arg}' footer masih bawaan default`);
      assert.ok(bm.contentText.includes('*[ 📌 INFO USER & BOT ]*'),
        `'.menu ${arg}' kehilangan blok INFO USER & BOT`);
      assert.ok(bm.contentText.includes('│ 🤖 Nama Bot :'), `'.menu ${arg}' kehilangan baris Nama Bot`);
      assert.ok(bm.contentText.includes('*[ 📌 INFO USER & BOT ]*'),
        `'.menu ${arg}' kehilangan blok INFO USER & BOT`);
      assert.ok(bm.contentText.includes('│ 🤖 Nama Bot :'), `'.menu ${arg}' kehilangan baris Nama Bot`);
      assert.ok(!sent.some(a => a[1] && (a[1].type === 'text' || a[1].type === 'image')), `'.menu ${arg}' masih kirim pesan teks terpisah`);
    }
  });

  await ok('.menu all = sub-judul per kategori + command urut a-z', async () => {
    sent.length = 0;
    await info(Object.assign({}, baseCtx, { args: ['all'] }));
    const body = sent.find(a => a[1] && a[1].buttonsMessage)[1].buttonsMessage.contentText;
    assert.ok(body.includes('*[ MENU ALL ]*'), 'header MENU ALL hilang');
    assert.match(body, /│ 〔 INFO 〕/, 'sub-judul kategori hilang');
    assert.ok(body.includes('│ ◦ .ping'), 'command kategori nggak ikut');
    // tiap blok kategori harus urut a-z
    const blocks = body.split('│ 〔 ').slice(1);
    assert.ok(blocks.length === 10, `blok kategori cuma ${blocks.length}`);   // 10 kategori di CATS
    const heads = blocks.map(b => b.split(' 〕')[0]);
    assert.deepStrictEqual(heads, [...heads].sort(), `sub-judul kategori nggak urut a-z: ${heads}`);
    for (const b of blocks) {
      const cmds = b.split('\n').filter(l => l.startsWith('│ ◦ ')).map(l => l.slice(4));
      assert.deepStrictEqual(cmds, [...cmds].sort(), `kategori ${b.split(' 〕')[0]} nggak urut a-z`);
    }
  });

  await ok('.kick/.add masuk kategori GRUP; kategori admin & proteksi udah nggak ada', () => {
    assert.ok(info.CATS.grup.includes('kick'), '.kick nggak ada di kategori grup');
    assert.ok(info.CATS.grup.includes('add'), '.add nggak ada di kategori grup');
    assert.ok(!info.CATS.admin, 'kategori `admin` masih ada');
    assert.ok(!info.CATS.proteksi, 'kategori `proteksi` masih ada');
    // Toggle proteksi ikut pindah ke grup juga
    for (const c of ['antilink', 'welcome', 'on', 'off', 'proteksi']) {
      assert.ok(info.CATS.grup.includes(c), `.${c} nggak ikut pindah ke grup`);
    }
    // Fitur global (nyimak/autoread/didyoumean) gate-nya OWNER BOT, bukan admin
    // grup — jangan dipajang di menu GRUP, taruh di OWNER.
    for (const c of ['nyimak', 'autoread', 'didyoumean']) {
      assert.ok(!info.CATS.grup.includes(c), `.${c} fitur global, jangan di menu grup`);
      assert.ok(info.CATS.owner.includes(c), `.${c} harus ada di menu owner`);
    }
    // Alias lama tetap diarahkan ke grup biar `.menu admin` nggak jadi menu kosong
    assert.strictEqual(info.CAT_ALIAS.admin, 'grup', 'alias `.menu admin` nggak ke grup');
    assert.strictEqual(info.CAT_ALIAS.proteksi, 'grup', 'alias `.menu proteksi` nggak ke grup');
    // Pindah kategori = murni tampilan. Gate izin tetap di handler, JANGAN diubah.
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', '02-group.js'), 'utf8');
    for (const c of ['add', 'kick', 'promote', 'banmember']) {
      const blk = src.split(`case '${c}':`)[1];
      assert.ok(blk, `case '${c}' hilang dari 02-group.js`);
      assert.ok(/isAdmin\(|isBotAdmin\(/.test(blk.slice(0, 700)),
        `.${c} kehilangan gate admin — pindah kategori nggak boleh ngubah izin`);
    }
  });

  await ok('semua `.set*` kumpul di SAT SET — nggak nyempil di kategori lain', () => {
    const setCmds = Object.values(info.CATS).flat().filter(c => c.startsWith('set'));
    assert.deepStrictEqual([...setCmds].sort(), [...info.CATS.satset].sort(),
      `ada .set* di luar satset / dobel: ${setCmds.sort().join(', ')}`);
    assert.strictEqual(info.CAT_LABEL.satset, 'SAT SET', 'label satset bukan "SAT SET"');
    assert.ok(info.CAT_ALIAS.set === 'satset' && info.CAT_ALIAS['sat-set'] === 'satset',
      '.menu set / .menu sat-set nggak nunjuk ke satset');
  });

  await ok('`.menu satset` kebaca — sub-judulnya "MENU SAT SET"', async () => {
    sent.length = 0;
    await info({ ...baseCtx, args: ['satset'] });
    const body = sent[0][1].buttonsMessage.contentText;
    assert.ok(body.includes('MENU SAT SET'), `sub-judul salah: ${body.split('\n')[1]}`);
    const cmds = body.split('\n').filter(l => l.startsWith('│ ◦ ')).map(l => l.slice(4));
    assert.deepStrictEqual(cmds, [...cmds].sort(), 'isi satset nggak urut a-z');
    assert.ok(cmds.includes('.setwelcome') && cmds.includes('.setqris'), `isi satset kurang: ${cmds.join(' ')}`);
  });

  console.log(`\nmenu-buttons: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
