'use strict';
/**
 * test/backup-bot.js
 *
 * Command `.backup` mengirim data SATU bot ke WhatsApp owner sebagai file.
 * Yang diuji di sini bukan "apakah filenya jadi", tapi dua hal yang kalau salah
 * tidak bisa ditarik balik:
 *
 *   1. ANTI-KEBOCORAN — tidak boleh ada SATU query pun ke tabel milik bot yang
 *      lupa `WHERE bot_id = ?`. Semua tabel itu menyimpan baris SEMUA bot dalam
 *      satu tabel, jadi satu query yang lupa filter = pelanggan A menerima data
 *      member pelanggan B. Mock di bawah MELEMPAR kalau itu terjadi.
 *   2. ANTI-KREDENSIAL — `telegram_token` dan tabel `users` (hash password)
 *      tidak boleh ikut ke file yang dikirim keluar.
 *
 * Plus: gerbang owner, dan file sementara WAJIB terhapus walau kirimnya gagal.
 */
const path = require('path');
const fs   = require('fs');
const os   = require('os');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

const TABEL_BOT = [
  'group_settings', 'auto_respon', 'blacklist', 'warn_records',
  'group_ban', 'gudang_list', 'bot_sewa', 'rpg_members',
];

const queries = [];        // semua SQL yang lewat
const dikirim = [];        // { jid, content }
const balasan = [];
let kirimMelempar = false;

function palsukan(modul, ekspor) {
  const j = require.resolve(path.join(__dirname, '..', modul));
  require.cache[j] = { id: j, filename: j, loaded: true, exports: ekspor };
}

const poolPalsu = {
  execute: async (sql, params = []) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    queries.push({ q, params });

    // ── TABEL BOT: WAJIB ada `bot_id = ?` ──────────────────────────────────
    // Cek ini SEBELUM pola lain, dan lempar — bukan cuma catat. Query yang lupa
    // filter harus meledak di tes, bukan diam-diam mengembalikan data bot lain.
    for (const t of TABEL_BOT) {
      if (new RegExp('FROM\\s+`?' + t + '`?\\b', 'i').test(q)) {
        if (!/bot_id\s*=\s*\?/i.test(q)) {
          throw new Error(`KEBOCORAN: query ke ${t} tanpa WHERE bot_id — ${q}`);
        }
        return [[{ id: 1, bot_id: params[0], contoh: t }]];
      }
    }

    // ── tabel terlarang: `users` (hash password) ───────────────────────────
    if (/FROM\s+`?users`?\b/i.test(q)) {
      throw new Error(`KEBOCORAN: tabel users (hash password) ikut dibaca — ${q}`);
    }

    if (/FROM\s+bots\b/i.test(q)) {
      return [[{
        id: 4, bot_name: 'zapo BOT', owner_number: '6287778032605',
        prefix: '.', daily_limit: 20, telegram_token: 'RAHASIA-HARUS-HILANG',
      }]];
    }
    return [[]];
  },
};

palsukan('config/database.js', { pool: poolPalsu, incrementStat: async () => {}, decrementStat: async () => {} });
// Gerbang owner sekarang baca `ctx.isOwner` (dihitung engine, satu sumber
// dengan 10-crm.js dan role `.menu`) — bukan lagi trik panggil 05-owner.

const backup = require('../plugins/11-backup.js');

const ctxBuat = (isOwner = true) => ({
  isCmd: true,
  command: 'backup',
  args: [],
  isOwner,                      // <- sinyal izin positif, satu-satunya gerbang
  jid: '6287778032605@s.whatsapp.net',
  sender: '6287778032605@s.whatsapp.net',
  botData: { id: 4, bot_name: 'zapo BOT', owner_number: '6287778032605' },
  reply: async (t) => { balasan.push(String(t)); },
  react: async () => {},
  client: { message: { send: async (jid, content) => {
    if (kirimMelempar) throw new Error('socket mati');
    dikirim.push({ jid, content });
  } } },
});

(async () => {
  // ── 0. bukan command ini ───────────────────────────────────────────────────
  cek('command lain -> tidak ditangani', (await backup({ isCmd: true, command: 'lain' })) === false);

  // ── 1. BUKAN owner -> ditolak, dan NOL query data ─────────────────────────
  queries.length = 0; dikirim.length = 0; balasan.length = 0;
  cek('bukan owner -> ditangani (return true)', (await backup(ctxBuat(false))) === true);
  cek('bukan owner -> ada pesan penolakan', /khusus owner/i.test(balasan.join(' ')), balasan.join(' | '));
  cek('bukan owner -> NOL file terkirim', dikirim.length === 0);
  cek('bukan owner -> NOL query ke tabel data', queries.filter(x => /rpg_members|group_settings/.test(x.q)).length === 0);

  // ── 2. owner -> file terkirim ─────────────────────────────────────────────
  queries.length = 0; dikirim.length = 0; balasan.length = 0;
  const hasil = await backup(ctxBuat());
  cek('owner -> ditangani', hasil === true);
  cek('owner -> tepat 1 file terkirim', dikirim.length === 1, `${dikirim.length}`);
  cek('dikirim sebagai DOCUMENT', dikirim[0]?.content?.type === 'document', String(dikirim[0]?.content?.type));
  cek('mimetype JSON', dikirim[0]?.content?.mimetype === 'application/json');
  cek('media berupa Buffer', Buffer.isBuffer(dikirim[0]?.content?.media));
  cek('nama file berakhiran .json', /\.json$/.test(dikirim[0]?.content?.fileName || ''), dikirim[0]?.content?.fileName);
  cek('balasan menyebut ukuran', /Ukuran:/i.test(balasan.join(' ')));

  // ── 3. ANTI-KEBOCORAN: semua tabel difilter bot_id ────────────────────────
  // Mock melempar kalau ada yang lupa; jadi sampai di sini = semua benar.
  const qTabel = queries.filter(x => TABEL_BOT.some(t => new RegExp('FROM\\s+`?' + t + '`?\\b', 'i').test(x.q)));
  cek('semua 8 tabel bot dibaca', qTabel.length === TABEL_BOT.length, `${qTabel.length}`);
  cek('TIDAK ADA query tabel bot tanpa bot_id', qTabel.every(x => /bot_id\s*=\s*\?/i.test(x.q)));
  cek('parameternya = id bot ini (4)', qTabel.every(x => Number(x.params[0]) === 4), JSON.stringify(qTabel[0]?.params));

  // ── 4. ANTI-KREDENSIAL ────────────────────────────────────────────────────
  const teks = dikirim[0].content.media.toString('utf8');
  cek('telegram_token TIDAK ikut ke file', !/RAHASIA-HARUS-HILANG/.test(teks));
  cek('tidak ada field telegram_token', !/"telegram_token"/.test(teks));
  cek('tidak ada tabel users di file', !/"users"/.test(teks));
  const isi = JSON.parse(teks);
  cek('format & keterangan ada', isi.berkas?.format === 1 && !!isi.berkas?.dibuat);
  cek('bot-nya ikut (buat restore)', isi.bot?.id === 4 && isi.bot?.bot_name === 'zapo BOT');
  cek('jumlah_baris dilaporkan', isi.jumlah_baris?.rpg_members === 1, JSON.stringify(isi.jumlah_baris));

  // ── 5. file sementara DIHAPUS ─────────────────────────────────────────────
  const namaFile = dikirim[0].content.fileName;
  cek('file sementara sudah dihapus dari server', !fs.existsSync(path.join(os.tmpdir(), namaFile)));

  // ── 6. kirim GAGAL -> file tetap dihapus + owner dikabari ─────────────────
  kirimMelempar = true;
  balasan.length = 0;
  await backup(ctxBuat());
  cek('kirim gagal -> owner dikabari gagal', /gagal/i.test(balasan.join(' ')), balasan.join(' | '));
  cek('kirim gagal -> TIDAK ada sisa file di /tmp',
    fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('backup_zapo_BOT_4_')).length === 0);

  console.log(gagal ? `\n=== GAGAL: ${gagal} masalah ===` : '\n=== SEMUA CEK LULUS ===');
  process.exit(gagal ? 1 : 0);
})();
