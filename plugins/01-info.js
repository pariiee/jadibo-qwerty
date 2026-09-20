'use strict';

/**
 * plugins/01-info.js
 * Commands: !ping, !menu, !info, !owner, !uptime, !profil, !carifitur, !totalfitur
 */

const { rapikanError } = require('../engine/pesanError');
const mess = require('../config/mess');
const os = require('os');
const { proto } = require('baileys');
const { genThumbnail } = require('../engine/thumbnail');

const START_TIME = Date.now();

// Umur BOT (bukan umur proses Node). Ini yang dibaca .uptime/.info:
// command .restart cuma mutus koneksi satu bot, jadi process.uptime() dan
// START_TIME (nempel di proses) nggak pernah kek-reset — semua bot dalam satu
// proses bakal nunjukin angka yang sama.
// `.runtime` SENGAJA nggak pakai ini — dia baca umur PROSES (process.uptime()).
// ponytail: fallback ke START_TIME kalau bot belum pernah connect (mis. lagi
// pairing) — angkanya memang umur proses, tapi itu yang paling dekat.
function botUptimeMs(ctx) {
  try {
    const at = require('../engine/whatsappEngine').getBotConnectedAt(ctx?.botData?.id);
    return at ? Date.now() - at : Date.now() - START_TIME;
  } catch { return Date.now() - START_TIME; }
}

// ── Helper: baca banner (dipakai kalau MENU_BANNER diaktifkan) ───────────────
// Percobaan 7dbcd27 (header.imageMessage + jpegThumbnail) upload-nya SUKSES di
// VPS tapi HP tetap tampil polos; kemungkinan besar sisi WA/akun yang tidak
// merender media di header interactiveMessage. Jalur banner dimatikan biar tiap
// .menu tidak buang upload + 56 KB buffer. Kalau mau coba lagi: MENU_BANNER=1.
// ponytail: cache in-memory 1 entri; banner jarang ganti.
let _bannerCache = null; // { src, buf } | null

async function _readBanner(src) {
  if (_bannerCache?.src === src) return _bannerCache.buf;
  let buf;
  if (/^https?:\/\//i.test(src)) {
    // ponytail: tanpa proxy — kalau nanti ada bot di belakang proxy, pindah ke axios
    // (axios sudah terpasang). fetch bawaan dipakai supaya tidak tambah dependensi.
    const res = await fetch(src, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`banner HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } else {
    buf = require('fs').readFileSync(require('path').resolve(src));
  }
  _bannerCache = { src, buf };
  return buf;
}

// Bubble .menu = GAMBAR banner dengan caption = isi menu (`MENU_BANNER=1`).
// Header `interactiveMessage` tidak dirender WA di klien user (diuji 2026-09-13:
// upload sukses, header berisi imageMessage 56668 B + thumb 1254 B, bubble tetap
// polos) — jadi medianya dipindah ke caption.
async function _menuBannerHeader(botData) {
  const src = String(botData.banner_url || process.env.BANNER_DEFAULT || '');
  if (!src) return null;
  return { src, buf: await _readBanner(src) };
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${d}h ${h}j ${m}m ${sec}d`;
}

const ALL_COMMANDS = [...new Set([
  // Info
  'ping','menu','info','owner','uptime','profile','me','carifitur','totalfitur','limit','uptname','memory','runtime',
  // Grup
  'tagall','tagadmin','tagme','hidetag','h','kickall','promote','demote',
  'open','close','mute','unmute','listmute','setname','setdesc','link','swgc','upswgc',
  'grupopen','grupclose','linkgc','setnamegc',
  'groupinfo','infogc','leavegc','listadmin','getpp','pp','getppgc','ppgc','ppgroup','totag',
  'delete','cekasalmember','absen','mulaiabsen','cekabsen','hapusabsen',
  'afk','listafk','antidelete','topchat',
  // Sat-set — nama command aslinya tetap `.set*`, cuma kategorinya dikumpul
  'setwelcome','setleft','setbye','setopen','setclose','setname','setnamegc','setdesc',
  'setbio','setpp','setppgc','setqris','setsewa','setlimitgc','gcutama','setwarnlimit',
  'delwelcome','delbye',
  // Proteksi & Toggle
  'on','off','proteksi',
  'antibot','antilink','antilinkv2','antitoxic','antidelete',
  'antispam','antitagsw','autosticker','antisticker','viewonce',
  // autolevelup nggak didaftarin — fitur wajib, nggak bisa di-on/off-in, cuma
  // dikasih tau statusnya di `.on` (nggak ikut dihitung sebagai toggle).
  'detect','autoacc','document','nyimak','autoread',
  // Fun & Game
  'profile','me','jodoh','suitpvp','rpg','claim','store','beli','inventory','pakai','repair','topkoin',
  'unreg','kerja','transfer','tf','coinflip','cf','tictactoe','ttt',
  'leaderboard','lb','bank','atm','money','mancing',
  'berburu','hunt','bertarung','fight','dungeon',
  'lamarkerja','job','gajian','gacha','slot',
  'hourly','weekly','dailymisi','adventure','koboy','airdrop','maling',
  // Tambang & craft & kejahatan
  'tambang','kebon','tebang','bahan','craft',
  'skill','penjara','bebaskan','copet','rampok',
  // Giveaway
  'mulaigiveaway','ikut','rollgiveaway','cekgiveaway','cekmenang','hapusgiveaway',
  // Media & Tools
  'sticker','s','wm','poll','readmore','encode','decode','kalkulator','pick','tourl','tourl2','upload2','upload','pay','tomp4','topng','tovn','2vo','todoc','artinama','attp','brat','bratvid','fakech','fakecall','fakecallip','fakedana','fakeovo','fakegcios','fakepptele','igqc','igstoryimg','iqc','ttqc','dafont','dafontdl','lirik','genius','gsmarena','spek','jarak','kbbi','kodepos',
  'bandinghp','comparehp','wilayah','cariwilayah','imei','cekimei','gempa',
  'cuaca','weather','accuweather','prakiraan',
  'checkwa','cekwa',
  'translate','terjemah','tr',
  'qrcode','qr','decodeqr','readqr',
  'ocr','upscale','hd','enhance',
  'ssweb','ss','screenshot',
  'fancytext','fancy',
  'nik','nikinfo',
  'iplookup','ipcek','reverseip','httpheaders','headers',
  'nationalday','hariini',
  'shalat','jadwalshalat','kalendershalat','kshalat','konversitanggal','tanggal',
  'bypass','bypasssfl','bpsfl',
  'drakor','duolingo','npm','resep','steam','play',
  'lk21','lk21trending','lk21search','filmsearch',
  'mcpedl','berita','pinterest','tokopedia','toped',
  // Stalker
  'stalktiktok','stalktt','tiktokstalk',
  'roblox','stalkroblox','cekroblox',
  'minecraft','mc','stalkmc',
  'stalkgithub','ghstalk',
  'genshin','stalkgenshin',
  'freefire','ff','stalkff',
  'discord','stalkdiscord',
  'chess','stalkchess',
  'nimegami','nimegamis','animesearch','shinigami',
  'spotify','spotifylyrics','slyrics','tiktokphoto','ttkphoto','ttsearch','searchcode',
  'rvo','readviewonce','readvo','crm','crm2',
  // Downloader
  'aio',
  'mediafire','mfdl',
  'likee','likeedl',
  'moddroid','moddroiddl',
  'facebook','fbdl','fb',
  'tgsticker','telesticker','stele',
  'spotify','spotifydl',
  'soundcloud','scdl',
  'sfilemobi','sfile',
  'sfileco',
  'rednote','xiaohongshu','xhs',
  'reddit','redditdl',
  'twitter','twit','xdl',
  'tiktok','tiktokdl','ttdl','tt',
  'pinterest','pindl','pin',
  'threads','threadsdl',
  'youtube','ytdl','yt',
  'gdrive','gdrivedl',
  'instagram','igdl','ig',
  'kuaishou','kwai','kuaishoudl',
  // Random
  'aceh','kataaceh',
  'batak','katabatak',
  'bijak',
  'china','katachina',
  'dare','tantangan',
  'fakta','faktaunik',
  'fiersa','fiersabesari',
  'jawa','pepatahjawa','katajawa',
  'katabucin','bucin',
  'katasore','sore',
  'minangkabau','minang','kataminang',
  'motivasi','katamotivasi',
  'ngeles','alasan',
  // Game Asah Otak
  'asahotak','clue','nyerah',
  // ── tebakbendera / tebakanime / tebakchara / tebakgambar — nggak didaftarin ──
  // Semua game populer itu LAMA: handler-nya `case 'tebakbendera'` di 00-game.js
  // udah ada dari awal, tapi namanya nggak pernah masuk ALL_COMMANDS/CATS → jadi
  // INVISIBLE (nggak ketemu `.carifitur`, nggak keluar di `.menu game`), padahal
  // command-nya jalan. Angka ini ditulis APA ADANYA dari `case` yang ada biar
  // nggak ada lagi yang kelewat; nambah game baru = nambah `case` + tambah di sini.
  'tebakbendera','tebakchara','tebakgambar','tebakanime',
  // Owner
  'ban','unban','block','unblock','broadcast','bcgc','bcgcht','on','off',
  'backup','restore','clearsession','cleartmp','listblacklist','listblock',
  'addprem','delprem','listprem',
  'addsewa','delsewa','setsewa','ceksewa','listsewa','tambahsewa',
  'addxp','addmoney','addlimit','addhp','resetlimit','listuser',
  'addlevel','dellevel','delmoney','delxp','dellimit',
  'cekprofil','resetprofil','listrank',
  'leaveall','listgroup','listgc','setlimitgc','gcutama',
  'addpremgrup','delpremgrup',
  'add','addai','kick',
  'addrespon','uprespon','delrespon','listrespon',
  'addlist','updatelist',
  'reset','restart','setbio','setpp',
  // Warn
  'warn','unwarn','delwarn','resetwarn','setwarnlimit','listwarn',
  // Group admin
  'banmember','unbanmember','setppgc','sider','listtotalpesan',
  'setopen','setclose','catatan',
])];

// ── Menu kategori — menu <kategori> / menu all ──────────────────────────────
const RM = String.fromCharCode(8206).repeat(4001); // readmore: konten bawah terlipat "Read more"

const CATS = {
  info:   ['ping','menu','info','owner','uptime','profile','me','carifitur','totalfitur','limit','uptname','memory','runtime'],
  // Command admin grup (`.add`/`.kick`/`.banmember`/…) numpuk di sini biar cukup
  // satu menu buat urusan grup. MURNI TAMPILAN: gate `isAdmin()` di handler
  // 02-group.js nggak diubah — yang bukan admin tetap ditolak.
  // Kategori `admin` & `proteksi` DIHAPUS dari CATS; alias `.menu admin` /
  // `.menu proteksi` tetap diarahkan ke sini (lihat CAT_ALIAS).
  //
  // SEMUA saklar on/off (antibot, antilink, welcome, left, nyimak, …) NGGAK
  // didaftarin di sini — Pak: "di ringkas aja di `.on <option>`". Command-nya
  // tetap jalan (handler di 06-proteksi.js) dan tetap ketemu `.carifitur`,
  // cuma nggak dipajang di menu. Daftar lengkap + status: `.on` tanpa argumen.
  grup:   ['absen','add','addai','afk','banmember','catatan','cekabsen','cekasalmember','cekgiveaway','cekmenang','close','delbye','delete','delwelcome','demote','getpp','getppgc','groupinfo','infogc','grupclose','grupopen','hapusabsen','hapusgiveaway','hidetag','h','ikut','kick','kickall','leavegc','linkgc','link','listadmin','listafk','listmute','listtotalpesan','mulaiabsen','mulaigiveaway','mute','off <option>','on <option>','open','pp','ppgc','ppgroup','promote','proteksi','rollgiveaway','sider','swgc','tagadmin','tagall','tagme','topchat','totag','unbanmember','unmute','upswgc'],
  // Sat-set: SEMUA command `.set*` dikumpul di sini — satu tempat buat nyetel
  // teks welcome/left, nama & deskripsi grup, bio, pp, sewa, limit, warn limit, QRIS.
  // Murni pindah: `setwelcome`/`setleft`/`setbye` juga sudah TIDAK ada lagi di `grup`
  // — jangan diduplikat, nanti kelihatan dobel di `.menu all`.
  // (`.set*` nggak boleh ada di kategori lain; dites di test/menu-buttons.js.)
  satset: ['setbio','setbye','setclose','setdesc','setleft','setlimitgc','setname','setnamegc','setopen','setpp','setppgc','setqris','setsewa','setwarnlimit','setwelcome'],
  rpg:    ['unreg','profile','me','claim','hourly','weekly','dailymisi','kerja','mancing','berburu','hunt','bertarung','fight','dungeon','adventure','koboy','airdrop','maling','lamarkerja','job','gajian','transfer','tf','bank','atm','money','topkoin','lb','leaderboard','store','beli','inventory','pakai','repair','gacha','slot','jodoh','suitpvp','coinflip','cf','tictactoe','ttt','tambang','kebon','tebang','bahan','craft','skill','penjara','bebaskan','copet','rampok'],
  maker:  ['sticker','s','wm','brat','bratvid','attp','fakech','fakecall','fakecallip','fakedana','fakeovo','fakegcios','fakepptele','rvo','readviewonce','readvo'],
  tools:  ['poll','readmore','encode','decode','kalkulator','pick','tourl','tourl2','upload2','upload','pay','tomp4','topng','tovn','2vo','todoc','artinama','igqc','igstoryimg','iqc','ttqc','dafont','dafontdl','lirik','genius','gsmarena','spek','jarak','kbbi','kodepos','bandinghp','comparehp','wilayah','cariwilayah','imei','cekimei','gempa','cuaca','weather','accuweather','prakiraan','checkwa','cekwa','translate','terjemah','tr','qrcode','qr','decodeqr','readqr','ocr','upscale','hd','enhance','ssweb','ss','screenshot','fancytext','fancy','nik','nikinfo','iplookup','ipcek','reverseip','httpheaders','headers','nationalday','hariini','shalat','jadwalshalat','kalendershalat','kshalat','konversitanggal','tanggal','bypass','bypasssfl','bpsfl','drakor','duolingo','npm','resep','steam','play','lk21','lk21trending','lk21search','filmsearch','mcpedl','berita','pinterest','tokopedia','toped','stalktiktok','stalktt','tiktokstalk','roblox','stalkroblox','cekroblox','minecraft','mc','stalkmc','stalkgithub','ghstalk','genshin','stalkgenshin','freefire','ff','stalkff','discord','stalkdiscord','chess','stalkchess','nimegami','nimegamis','animesearch','shinigami','spotify','spotifylyrics','slyrics','tiktokphoto','ttkphoto','ttsearch','searchcode'],
  downloader: ['aio','mediafire','mfdl','likee','likeedl','moddroid','moddroiddl','facebook','fbdl','fb','tgsticker','telesticker','stele','spotify','spotifydl','soundcloud','scdl','sfilemobi','sfile','sfileco','rednote','xiaohongshu','xhs','reddit','redditdl','twitter','twit','xdl','tiktok','tiktokdl','ttdl','tt','pinterest','pindl','pin','threads','threadsdl','youtube','ytdl','yt','gdrive','gdrivedl','instagram','igdl','ig','kuaishou','kwai','kuaishoudl'],
  random: ['aceh','kataaceh','batak','katabatak','bijak','china','katachina','dare','tantangan','fakta','faktaunik','fiersa','fiersabesari','jawa','pepatahjawa','katajawa','katabucin','bucin','katasore','sore','minangkabau','minang','kataminang','motivasi','katamotivasi','ngeles','alasan'],
  game:   ['asahotak','clue','nyerah','tebakbendera','tebakchara','tebakgambar','tebakanime'],
  // Fitur global (per-bot, bukan per-grup): `nyimak`/`autoread`/`didyoumean`
  // saklarnya di config/globalSettings.js dan gate-nya OWNER BOT — jadi
  // nongkrongnya di sini, bukan di `grup`. `.on <nama>` tetap dijalanin dari
  // dalam grup, cuma izinnya owner.
  owner:  ['ban','unban','block','unblock','broadcast','bcgc','bcgcht','backup','restore','clearsession','cleartmp','listblacklist','listblock','addprem','delprem','listprem','addsewa','delsewa','ceksewa','listsewa','tambahsewa','addxp','addmoney','addlimit','addhp','resetlimit','listuser','addlevel','dellevel','delmoney','delxp','dellimit','cekprofil','resetprofil','listrank','leaveall','listgroup','listgc','crm','crm2','addpremgrup','delpremgrup','addrespon','uprespon','delrespon','listrespon','addlist','updatelist','reset','restart','warn','unwarn','delwarn','resetwarn','listwarn'],
};

// Label yang DITAMPILIN. Key kategori nggak boleh ada spasi (dipakai `.menu <key>`
// + id tombol), tapi Pak minta kategorinya bernama "sat set" → dipisah di sini.
const CAT_LABEL = { satset: 'SAT SET' };
const catLabel = (k) => CAT_LABEL[k] || String(k).toUpperCase();

// Urutan kategori a-z — dipakai teks `.menu`, sub-judul `.menu all`, dan dropdown.
// Pak: "category belum urut yah? dari a sampe z?"
const CAT_KEYS = Object.keys(CATS).sort();

const CAT_ALIAS = {
  all: 'all', semua: 'all',
  dl: 'downloader', download: 'downloader', downloader: 'downloader',
  maker: 'maker', membuat: 'maker',
  owner: 'owner', pemilik: 'owner',
  tools: 'tools', tool: 'tools', utilitas: 'tools',
  rpg: 'rpg', game: 'game', games: 'game', asahotak: 'game',
  random: 'random', kata: 'random',
  info: 'info', menu: 'info',
  // `admin` & `proteksi` nggak punya kategori sendiri lagi — dua-duanya
  // diarahkan ke `grup` biar `.menu admin` / `.menu proteksi` lama tetap jalan.
  grup: 'grup', group: 'grup', admin: 'grup', groupadmin: 'grup',
  proteksi: 'grup', protek: 'grup', toggle: 'grup',
  satset: 'satset', set: 'satset', 'sat-set': 'satset', setelan: 'satset', setting: 'satset',
};

// Balik: command → kategori. Dipakai `.carifitur` biar kelihatan "gitunya"
// (Pak: "output carifitur tuh lebih detail di category apa").
const CMD_CATS = (() => {
  const m = {};
  for (const cat of Object.keys(CATS)) for (const c of CATS[cat]) (m[c] = m[c] || []).push(cat);
  return m;
})();

module.exports = async function infoHandler(ctx) {
  if (!ctx.isCmd) return false;
  const { command, args, reply, react, botData, client, sock, jid, sender, isGroup, msg } = ctx;
  const p = botData.prefix;

  switch (command) {
    // ── memory — RAM usage bot ──────────────────────────────────────────────
    case 'memory': {
      const mem   = process.memoryUsage();
      const used  = Math.round(mem.heapUsed / 1024 / 1024);
      const total = Math.round(mem.heapTotal / 1024 / 1024);
      const rss   = Math.round(mem.rss / 1024 / 1024);
      await reply(
        `🧠 *Memory Bot*\n\n` +
        `Heap Used  : *${used} MB*\n` +
        `Heap Total : *${total} MB*\n` +
        `RSS        : *${rss} MB*`
      );
      return true;
    }

    // ── runtime — umur PROSES Node (semua bot + web) ────────────────────────
    // Beda dari .uptime (umur KONEKSI bot ini, iterest saat .restart).
    // ponytail: satu proses; kalau nanti ada worker terpisah, sumbernya harus
    // dipisah juga.
    case 'runtime': {
      await reply(`⏱️ *Runtime Aplikasi*\n${formatUptime(process.uptime() * 1000)}\n_semua proses Node — bot & web_`);
      return true;
    }

    case 'ping': {
      const start = Date.now();
      await react('⏱️');
      const latency = Date.now() - start;
      await reply(`🏓 *Pong!*\n⚡ Latensi: ${latency}ms\n✅ Bot aktif`);
      return true;
    }

    case 'menu': {
      const role = mess.roleLabel[ctx.role] || mess.roleLabel.user;

      const catKey = (args.join(' ') || '').toLowerCase().trim();
      const showCat = CAT_ALIAS[catKey] || (CATS[catKey] ? catKey : null);

      // ── Menu per-kategori: .menu <kategori> / .menu all ──────────────────
      // Bentuknya = bentuk menu utama (header lokasi + banner + tombol),
      // bedanya cuma isi `body` dan tombol kategori yang aktif (penanda ◈).
      // `.menu <kategori>` = satu command per baris, urut a-z.
      // `.menu all` = semua kategori, tiap kategori dikasih sub-judul.
      // (Kolom `contentText` nggak dipotong WA kayak caption gambar — dump 408
      //  command ~5.700 char terkirim utuh, sudah kelihatan di HP Pak.)
      let subBody = null;   // null = menu utama
      const subHeader = (t) => `╭── *[ ${t} ]* ──`;
      const subLines = (k) => [...CATS[k]].sort().map(c => `│ ◦ ${p}${c}`);
      if (showCat === 'all') {
        subBody = subHeader('MENU ALL') + '\n' +
          CAT_KEYS.map(k => [`│ 〔 ${catLabel(k)} 〕`, ...subLines(k)].join('\n')).join('\n│\n') +
          '\n╰────────────────────────';
      } else if (showCat) {
        subBody = subHeader(`MENU ${catLabel(showCat)}`) + '\n' +
          subLines(showCat).join('\n') +
          '\n╰────────────────────────';
      }

      // ── Menu utama: sapaan + info user + kategori ────────────────────────
      // Nilai bawaan dulu (pushName + limit default) — dipakai kalau DB mati
      let namaUser = ctx.pushName || 'User';
      let limUser  = null;
      const maxLim = botData.daily_limit || parseInt(process.env.DEFAULT_LIMIT || '20', 10);
      try {
        const { pool } = require('../config/database');
        const [rows] = await pool.execute(
          'SELECT name, lim FROM rpg_members WHERE bot_id = ? AND jid = ? LIMIT 1',
          [botData.id, sender]
        );
        if (rows[0]) { namaUser = rows[0].name || namaUser; limUser = rows[0].lim; }
      } catch { /* DB opsional — menu tetap terkirim */ }
      // Owner sudah otomatis terdaftar di engine, tapi user biasa juga dibuat
      // saat kirim pesan — jadi limit hampir selalu ada. Fallback: tampilkan max.
      const limitTxt = `${limUser ?? maxLim}/${maxLim}`;

      // Waktu WIB (Asia/Jakarta) — jangan andalkan TZ server
      const wib = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Jakarta', hour12: false, weekday: 'long',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(new Date());
      const wp = (t) => wib.find(x => x.type === t)?.value || '';
      const HARI = { Sunday: 'Minggu', Monday: 'Senin', Tuesday: 'Selasa', Wednesday: 'Rabu',
                     Thursday: 'Kamis', Friday: 'Jumat', Saturday: 'Sabtu' };
      const jamWib = parseInt(wp('hour'), 10);
      const sapaan = jamWib < 4 ? 'SELAMAT MALAM'
        : jamWib < 11 ? 'SELAMAT PAGI'
        : jamWib < 15 ? 'SELAMAT SIANG'
        : jamWib < 18 ? 'SELAMAT SORE' : 'SELAMAT MALAM';

      // Teks menu = gaya `.test3` (box `╭── *[ … ]* ──` + kategori per baris).
      // Satu builder di sini; `.test3` di 05-owner.js cuma alias ke case ini.
      const catList = CAT_KEYS
        .map(k => `│ ◦ ${catLabel(k)} (${CATS[k].length} Fitur)`)
        .join('\n');

      // Sapaan + info user/bot dipakai SEMUA teks menu (utama & sub-menu)
      // — Pak: "setiap teks menu tetep ada INFO USER DAN BOT".
      const headSapa =
        `╭── *[ 🧾 ${sapaan} ]* ──\n` +
        `│ 🗓️ Hari : ${HARI[wp('weekday')] || wp('weekday')}\n` +
        `│ 📅 Tanggal : ${wp('day')}/${wp('month')}/${wp('year')}\n` +
        `│ ⏰ Waktu : ${wp('hour')}:${wp('minute')}:${wp('second')} WIB\n` +
        `╰────────────────────────\n\n` +
        `Hi *${namaUser}*,\n` +
        `_"${botData.description || process.env.DESC_DEFAULT || `My name is ${botData.bot_name} and I'm here to help you. Feel free to choose a menu or type a command you need.`}"_\n\n`;

      const headInfo =
        `╭── *[ 📌 INFO USER & BOT ]* ──\n` +
        `│ 🤖 Nama Bot : ${botData.bot_name}\n` +
        `│ 👤 Nama User : ${namaUser}\n` +
        `│ 👑 Role : ${role}\n` +
        `│ ⚡ Limit : ${limitTxt}\n` +
        `│ 📦 Total Fitur : ${ALL_COMMANDS.length}\n` +
        `│ 🔓 Mode : Public\n` +
        `╰────────────────────────\n`;

      const head = headSapa + headInfo;

      const tail =
        `╭── *[ 📋 MENU CATEGORY ]* ──\n` +
        `${catList}\n` +
        `╰────────────────────────\n\n` +
        `📌 *Catatan:* \n` +
        `• Ketuk tombol *Menu* untuk daftar kategori.\n` +
        `• Ketik *${p}menu <kategori>* untuk melihat isinya.\n` +
        `• Semua command: *${p}menu all*`;

      // Pesan TEKS: filler readmore 4001 char (`RM`) — lipatan "Baca selengkapnya"
      // jatuh persis di bawah baris `Limit`; sisa menu ke bawah cuma kesembunyi.
      // ponytail: cuma dipakai jalur gagal (`reply(caption)`) + audio caption.
      const caption = head + `${RM}\n` + tail;

      // Caption gambar dibatasi WA 1024 char → filler 4001 nggak muat. Sisa jatah
      // (1024 − head − tail) dipakai buat filler, jadi lipatannya jatuh di titik
      // yang sama: tepat di bawah baris `Limit`, bukan di baris kategori.
      const captionImg = head +
        '\u200e'.repeat(Math.max(0, 1024 - head.length - tail.length - 1)) +
        '\n' + tail;

      // ── Kirim menu dalam SATU bubble `buttonsMessage` (pola `.test3`) ────
      // Header lokasi (0,0) = wadah thumbnail banner, jadi gambar + teks +
      // tombol nempel di satu bubble tanpa upload media (thumbnail ikut inline
      // di proto). MENU = `nativeFlowInfo.single_select` 11 kategori, owner =
      // tombol biasa — WA render dua-duanya sebaris. Terbukti di HP Pak.
      // Tombol panah-lama (`07-button.js` id `menu_cat:<kategori>`) tetap ada
      // sebagai fallback kalau WA balikin id tombol, bukan row id.
      let thumb = null;
      try {
        const bannerPesan = await _menuBannerHeader(botData);
        if (bannerPesan) thumb = await genThumbnail(bannerPesan.buf, 'image/jpeg', 300);
      } catch (e) {
        // Jangan diam — tanpa banner menu tetap terkirim, cuma tanpa thumbnail.
        console.error('[menu] banner gagal:', e.message);
      }
      console.log(`[menu] banner_url=${botData.banner_url || '(kosong)'} → thumbnail=${thumb ? `${thumb.length}B` : '(tidak ada)'}`);

      // Dropdown kategori dipakai DUA-DUANYA (menu utama & sub-menu) — sub-menu
      // cuma nggak bawa tombol Owner (Pak: "buttom owner hanya di .menu aja").
      const btnMenu = {
        buttonId: 'btn_cat',
        buttonText: { displayText: 'Menu' },
        type: 1,
        nativeFlowInfo: {
          name: 'single_select',
          paramsJson: JSON.stringify({
            title: 'Menu Category',
            sections: [{
              title: 'INI SEMUA MENU CATEGORY BOT GWEH',
              highlight_label: 'recommended',
              rows: [
                { header: '', title: 'ALL', description: `Semua Menu (${ALL_COMMANDS.length} fitur)`, id: '.menu all' },
                ...CAT_KEYS.map(k => ({
                  header: '',
                  title: catLabel(k),
                  description: `Menu ${k}`,
                  id: `.menu ${k}`,
                })),
              ],
            }],
          }),
        },
      };
      const btnOwner = { buttonId: 'btn_owner', buttonText: { displayText: 'Owner' }, type: 1 };

      try {
        await client.message.send(jid, {
          buttonsMessage: {
            headerType: 6,
            locationMessage: {
              degreesLatitude: 0,
              degreesLongitude: 0,
              name: botData.bot_name || 'YaaParBot',
              // Alamat di header lokasi = link API + jadibot (samain pola .env).
              // ponytail: literal, nggak ada config per-bot buat ini — angkat ke env kalau Pak mau tiap bot beda.
              address: 'Jadibot? labs.yapari.web.id',
              ...(thumb ? { jpegThumbnail: thumb } : {}),
            },
            // Semua teks menu = sapaan+deskripsi (sub-menu aja) + INFO USER & BOT + isi.
            contentText: subBody ? headInfo + subBody : captionImg,
            // Footer SELALU ikut — Pak: "tetep ada footer yah setiap menunya atau pesan".
            footerText: botData.footer_text || 'Powered by YaaParBot',   // footer SELALU ikut (Pak)
            buttons: subBody ? [btnMenu] : [btnMenu, btnOwner],
          },
        });
      } catch (e) {
        console.error('[menu] gagal kirim:', e.message);
        await reply(caption); // jangan hilang menunya
      }

      // ── Audio default (opsional) — voice note bareng menu ────────────────
      // Terima apa saja: .mp3/.m4a/.wav/.ogg atau URL. Yang bukan ogg/opus
      // dikonversi otomatis ke ogg opus (format voice note WA), lalu di-cache.
      const audioSrc = process.env.AUDIO_DEFAULT;
      if (audioSrc) {
        try {
          const fs   = require('fs');
          const path = require('path');
          const tmp  = require('os').tmpdir();
          const audioBuf = /^https?:\/\//i.test(audioSrc)
            ? Buffer.from((await require('axios').get(audioSrc, { responseType: 'arraybuffer', timeout: 30000 })).data)
            : fs.readFileSync(path.resolve(audioSrc));

          let voiceBuf = audioBuf;
          if (!/\.(ogg|opus)$/i.test(audioSrc)) {
            const crypto = require('crypto');
            const hash   = crypto.createHash('md5').update(audioSrc + ':' + audioBuf.length).digest('hex').slice(0, 12);
            const cached = path.join(__dirname, '..', 'data', `audio-cache-${hash}.ogg`);
            if (fs.existsSync(cached)) {
              voiceBuf = fs.readFileSync(cached);
            } else {
              const inPath  = path.join(tmp, `menu-src-${Date.now()}`);
              const outPath = path.join(tmp, `menu-vn-${Date.now()}.ogg`);
              fs.writeFileSync(inPath, audioBuf);
              await new Promise((resolve, reject) => {
                const ff = require('child_process').spawn('ffmpeg', [
                  '-y', '-i', inPath,
                  '-vn', '-c:a', 'libopus', '-b:a', '64k',
                  '-ar', '48000', '-ac', '1', '-application', 'voip',
                  outPath,
                ]);
                ff.on('error', reject); // ffmpeg tidak ada → pakai aslinya, jangan crash
                ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
              });
              voiceBuf = fs.readFileSync(outPath);
              try { fs.mkdirSync(path.dirname(cached), { recursive: true }); fs.writeFileSync(cached, voiceBuf); } catch { /* cache opsional */ }
              fs.unlinkSync(inPath); fs.unlinkSync(outPath);
            }
          }

          await client.message.send(jid, {
            type:     'audio',
            media:    voiceBuf,
            mimetype: 'audio/ogg; codecs=opus',
            ptt:      true, // ponytail: selalu ogg opus di sini — input non-ogg sudah dikonversi di atas
          });
        } catch { /* audio opsional — gagal pun menu tetap terkirim */ }
      }
      return true;
    }

    case 'info': {
      const mem  = process.memoryUsage();
      const used = Math.round(mem.heapUsed / 1024 / 1024);
      const total= Math.round(mem.heapTotal / 1024 / 1024);
      await reply(
        `╭━━━ *INFO BOT* ━━━╮\n` +
        `│ Nama    : ${botData.bot_name}\n` +
        `│ Prefix  : ${p}\n` +
        `│ Uptime  : ${formatUptime(botUptimeMs(ctx))} *_(umur bot ini)_*\n` +
        `│ Runtime : ${formatUptime(process.uptime() * 1000)} *_(umur aplikasi)_*\n` +
        `│ RAM     : ${used}/${total} MB\n` +
        `│ Node    : ${process.version}\n` +
        `│ OS      : ${os.type()} ${os.release()}\n` +
        `╰━━━━━━━━━━━━━━━━━╯`
      );
      return true;
    }

    case 'owner': {
      const num = (botData.owner_number || '').replace(/\D/g, '');
      if (!num) {
        await reply('👑 *Owner Bot*\n\nNomor owner belum diset di konfigurasi.');
        return true;
      }
      const name = botData.owner_name?.trim() || `Owner ${botData.bot_name}`;
      const vcard = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `FN:${name}`,
        `TEL;type=CELL;type=VOICE;waid=${num}:+${num}`,
        'END:VCARD'
      ].join('\n');
      await client.message.send(jid, {
        contactMessage: {
          displayName: name,
          vcard
        }
      });
      return true;
    }

    case 'uptime': {
      await reply(`⏰ *Uptime Bot*\n${formatUptime(botUptimeMs(ctx))}\n_sejak bot ini terhubung ke WA_`);
      return true;
    }

    case 'carifitur': {
      const q = args.join(' ').toLowerCase().replace(/^[.\/#!$]/, '').trim();
      if (!q) { await reply(`Penggunaan: ${p}carifitur <kata kunci>\nContoh: ${p}carifitur play`); return true; }
      const pool = [...new Set([...ALL_COMMANDS, ...Object.keys(CMD_CATS)])];
      const found = [...new Set(pool.filter(c => c.includes(q)))].sort();
      if (found.length === 0) {
        await reply(`❌ Tidak ada fitur yang cocok dengan *${q}*`);
        return true;
      }
      // Dikelompokkan per kategori (urut a-z) biar kelihatan fiturnya masuk "gitunya" mana.
      const byCat = {};
      for (const c of found) for (const cat of (CMD_CATS[c] || ['lainnya'])) (byCat[cat] = byCat[cat] || []).push(c);
      let text = `🔍 *Cari Fitur: "${q}"*\n` +
        `📊 Ditemukan *${found.length}* command di *${Object.keys(byCat).length}* kategori\n`;
      for (const cat of Object.keys(byCat).sort()) {
        text += `\n📂 *${cat.toUpperCase()}* (${byCat[cat].length})\n`;
        text += byCat[cat].sort().map(c => `▢ ${p}${c}`).join('\n') + '\n';
      }
      await reply(text.trimEnd());
      return true;
    }

    case 'totalfitur': {
      await reply(`📊 *Total Fitur Bot*\n\nJumlah command tersedia: *${ALL_COMMANDS.length}*`);
      return true;
    }

    case 'limit': {
        const { pool } = require('../config/database');
        try {
        const [rows] = await pool.execute(
          'SELECT name, lim, premium FROM rpg_members WHERE bot_id = ? AND jid = ? AND registered = 1 LIMIT 1',
          [botData.id, sender]
        );
        if (!rows[0]) { await reply(`❌ Kamu belum punya profil RPG.\nKetik *${p}uptname <nama>* untuk mulai (profil dibuat otomatis).`); return true; }
        const { name, lim } = rows[0];
        const defLimit = parseInt(process.env.DEFAULT_LIMIT || '20', 10);

        // Status ikut urutan role engine (dev > owner > premium > user),
        // BUKAN cuma kolom `premium` di DB — dulu makanya owner+dev pun
        // kelihatan 'User biasa'.
        const label    = mess.roleLabel[ctx.role] || mess.roleLabel.user;
        const skipLim  = ctx.role !== 'user';   // dev/owner/premium/admin: limit nggak kepotong
        const txt =
          `💎 *CEK LIMIT*\n\n` +
          `👤 Nama   : ${name || sender.split('@')[0]}\n` +
          `💎 Limit  : ${skipLim ? '♾️' : `*${lim}* tersisa`}\n` +
          `⭐ Status : ${skipLim ? `*${label}*` : label}\n` +
          `🔄 Reset  : Setiap hari jam *00:00 WIB* → ${defLimit} limit`;

        await reply(txt);
      } catch (e) {
        await reply(`Gagal cek limit: ${rapikanError(e)}`);
      }
      return true;
    }

    default:
      return false;
  }
};

// Command yang kena limit untuk user biasa.
// CATATAN: 'limit' SENGAJA nggak ada di sini — cek limit itu perintah info,
// kalau ikut kepotong user bisa kehabisan limit cuma gara-gara ngecek sisa.
module.exports.limitedCmds = new Set([
  // KOSONG atas permintaan Pak: `.react` dicabut, dan perintah info
  // (`limit`, `uptime`, ...) emang nggak boleh kena potong. Isi lagi
  // kalau ada fitur berat yang mau dibatasi harian.
]);

// Dipakai self-check (tanpa ini helper-nya cuma bisa dites lewat handler penuh).
module.exports._menuBannerHeader = _menuBannerHeader;
module.exports.ALL_COMMANDS      = ALL_COMMANDS;
module.exports.CATS              = CATS;
module.exports.CMD_CATS          = CMD_CATS;
module.exports.catLabel          = catLabel;
module.exports.CAT_LABEL         = CAT_LABEL;
module.exports.CAT_KEYS          = CAT_KEYS;
module.exports.CAT_ALIAS         = CAT_ALIAS;
