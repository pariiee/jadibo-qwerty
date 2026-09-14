'use strict';

/**
 * plugins/01-info.js
 * Commands: !ping, !menu, !info, !owner, !uptime, !profil, !carifitur, !totalfitur
 */

const os = require('os');
const { proto } = require('baileys');

const START_TIME = Date.now();

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
  'ping','menu','info','owner','uptime','profile','me','carifitur','totalfitur','limit','uptname','memory','runtime','react',
  // Grup
  'tagall','tagadmin','tagme','hidetag','ht','kick','kickall','promote','demote',
  'open','close','mute','unmute','slowmode','setname','setdesc','linkgroup','upswgc',
  'grupopen','grupclose','linkgc','setnamegc',
  'groupinfo','grouplist','leavegc','listadmin','getpp','getppgc','ppgc','ppgroup','ppgrup','totag',
  'delete','cekasalmember','absen','mulaiabsen','cekabsen','hapusabsen',
  'afk','listafk','antidelete','topchat',
  'setwelcome','setbye','delwelcome','delbye','setdetect','deldetect',
  // Proteksi & Toggle
  'on','off','fitur','proteksi',
  'antibot','antilink','antilinkv2','antitoxic','antidelete',
  'antispam','antitagsw','autosticker','antisticker','viewonce',
  'autolevelup','detect','autoacc','document','nyimak','autoread',
  // Fun & Game
  'profile','me','jodoh','suitpvp','rpg','claim','store','beli','inventory','pakai','topkoin',
  'unreg','kerja','transfer','tf','coinflip','cf','tictactoe','ttt',
  'leaderboard','lb','bank','atm','mancing',
  'berburu','hunt','bertarung','fight','dungeon',
  'lamarkerja','job','gajian','gacha','slot',
  'hourly','weekly','dailymisi','adventure','koboy','airdrop','maling',
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
  'spotify','spotifylyrics','slyrics','tiktokphoto','ttkphoto','searchcode','caricode',
  'rvo','readviewonce','readvo','liat',
  // Downloader
  'aio',
  'mediafire','mfdl',
  'likee','likeedl',
  'moddroid','moddroiddl',
  'facebook','fbdl','fb',
  'tgsticker','telesticker',
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
  'asahotak','toka','hint','nyerah',
  // Owner
  'ban','unban','block','unblock','broadcast','bcgc','bcgcht','on','off',
  'backup','restore','clearsession','cleartmp','listblacklist','listblock',
  'addprem','delprem','listprem',
  'addsewa','delsewa','setsewa','ceksewa','listsewa','tambahsewa',
  'addxp','addmoney','addlimit','addhp','resetlimit','listuser',
  'addlevel','dellevel','delmoney','delxp','dellimit',
  'cekprofil','resetprofil','listrank',
  'leaveall','listgroup','setlimitgc',
  'addpremgrup','delpremgrup',
  'add','promoteme',
  'addrespon','uprespon','delrespon','listrespon',
  'addlist','updatelist',
  'reset','setbio','setpp',
  // Warn
  'warn','unwarn','delwarn','resetwarn','setwarnlimit','listwarn',
  // Group admin
  'banmember','unbanmember','clearchat','setppgc','sider','listtotalpesan',
  'setopen','setclose',
])];

// ── Menu kategori — menu <kategori> / menu all ──────────────────────────────
const RM = String.fromCharCode(8206).repeat(4001); // readmore: konten bawah terlipat "Read more"

const CATS = {
  info:   ['ping','menu','info','owner','uptime','profile','me','carifitur','totalfitur','limit','uptname','memory','runtime','react'],
  grup:   ['tagall','tagadmin','tagme','hidetag','ht','kick','kickall','promote','demote','open','close','mute','unmute','slowmode','setname','setdesc','linkgroup','upswgc','grupopen','grupclose','linkgc','setnamegc','groupinfo','grouplist','leavegc','listadmin','getpp','getppgc','ppgc','ppgroup','ppgrup','totag','delete','cekasalmember','absen','mulaiabsen','cekabsen','hapusabsen','afk','listafk','topchat','antidelete','setwelcome','setbye','delwelcome','delbye','setdetect','deldetect','mulaigiveaway','ikut','rollgiveaway','cekgiveaway','cekmenang','hapusgiveaway'],
  proteksi: ['on','off','fitur','proteksi','antibot','antilink','antilinkv2','antitoxic','antispam','antitagsw','autosticker','antisticker','viewonce','autolevelup','detect','autoacc','document','nyimak','autoread'],
  rpg:    ['unreg','profile','me','claim','hourly','weekly','dailymisi','kerja','mancing','berburu','hunt','bertarung','fight','dungeon','adventure','koboy','airdrop','maling','lamarkerja','job','gajian','transfer','tf','bank','atm','topkoin','lb','leaderboard','store','beli','inventory','pakai','gacha','slot','jodoh','suitpvp','coinflip','cf','tictactoe','ttt'],
  maker:  ['sticker','s','wm','brat','bratvid','attp','fakech','fakecall','fakecallip','fakedana','fakeovo','fakegcios','fakepptele','rvo','readviewonce','readvo','liat','swgc','upswgc'],
  tools:  ['poll','readmore','encode','decode','kalkulator','pick','tourl','tourl2','upload2','upload','pay','tomp4','topng','tovn','2vo','todoc','artinama','igqc','igstoryimg','iqc','ttqc','dafont','dafontdl','lirik','genius','gsmarena','spek','jarak','kbbi','kodepos','bandinghp','comparehp','wilayah','cariwilayah','imei','cekimei','gempa','cuaca','weather','accuweather','prakiraan','checkwa','cekwa','translate','terjemah','tr','qrcode','qr','decodeqr','readqr','ocr','upscale','hd','enhance','ssweb','ss','screenshot','fancytext','fancy','nik','nikinfo','iplookup','ipcek','reverseip','httpheaders','headers','nationalday','hariini','shalat','jadwalshalat','kalendershalat','kshalat','konversitanggal','tanggal','bypass','bypasssfl','bpsfl','drakor','duolingo','npm','resep','steam','play','lk21','lk21trending','lk21search','filmsearch','mcpedl','berita','pinterest','tokopedia','toped','stalktiktok','stalktt','tiktokstalk','roblox','stalkroblox','cekroblox','minecraft','mc','stalkmc','stalkgithub','ghstalk','genshin','stalkgenshin','freefire','ff','stalkff','discord','stalkdiscord','chess','stalkchess','nimegami','nimegamis','animesearch','shinigami','spotify','spotifylyrics','slyrics','tiktokphoto','ttkphoto','searchcode','caricode'],
  downloader: ['aio','mediafire','mfdl','likee','likeedl','moddroid','moddroiddl','facebook','fbdl','fb','tgsticker','telesticker','spotify','spotifydl','soundcloud','scdl','sfilemobi','sfile','sfileco','rednote','xiaohongshu','xhs','reddit','redditdl','twitter','twit','xdl','tiktok','tiktokdl','ttdl','tt','pinterest','pindl','pin','threads','threadsdl','youtube','ytdl','yt','gdrive','gdrivedl','instagram','igdl','ig','kuaishou','kwai','kuaishoudl'],
  random: ['aceh','kataaceh','batak','katabatak','bijak','china','katachina','dare','tantangan','fakta','faktaunik','fiersa','fiersabesari','jawa','pepatahjawa','katajawa','katabucin','bucin','katasore','sore','minangkabau','minang','kataminang','motivasi','katamotivasi','ngeles','alasan'],
  game:   ['asahotak','toka','hint','nyerah'],
  owner:  ['ban','unban','block','unblock','broadcast','bcgc','bcgcht','backup','restore','clearsession','cleartmp','listblacklist','listblock','addprem','delprem','listprem','addsewa','delsewa','setsewa','ceksewa','listsewa','tambahsewa','addxp','addmoney','addlimit','addhp','resetlimit','listuser','addlevel','dellevel','delmoney','delxp','dellimit','cekprofil','resetprofil','listrank','leaveall','listgroup','setlimitgc','addpremgrup','delpremgrup','addrespon','uprespon','delrespon','listrespon','addlist','updatelist','reset','setbio','setpp','warn','unwarn','delwarn','resetwarn','setwarnlimit','listwarn'],
  admin:  ['add','promoteme','banmember','unbanmember','clearchat','setppgc','sider','listtotalpesan','setopen','setclose'],
};

const CAT_ALIAS = {
  all: 'all', semua: 'all',
  dl: 'downloader', download: 'downloader', downloader: 'downloader',
  maker: 'maker', membuat: 'maker',
  owner: 'owner', pemilik: 'owner',
  tools: 'tools', tool: 'tools', utilitas: 'tools',
  rpg: 'rpg', game: 'game', games: 'game', asahotak: 'game',
  random: 'random', kata: 'random',
  info: 'info', menu: 'info',
  grup: 'grup', group: 'grup', admin: 'admin', groupadmin: 'admin',
  proteksi: 'proteksi', protek: 'proteksi', toggle: 'proteksi',
};

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

    // ── runtime — uptime proses bot ─────────────────────────────────────────
    case 'runtime': {
      await reply(`⏱️ *Runtime Bot*\n\n${formatUptime(Date.now() - START_TIME)}`);
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
      const role = ctx.isOwner ? 'Owner'
        : ctx.isPremium ? 'Premium'
        : ctx.isAdmin ? 'Admin' : 'Free';

      const catKey = (args[0] || '').toLowerCase();
      const showCat = CAT_ALIAS[catKey] || (CATS[catKey] ? catKey : null);

      const title = (s) => s.charAt(0).toUpperCase() + s.slice(1);

      // ── Menu per-kategori: .menu <kategori> / .menu all ──────────────────
      if (showCat) {
        // "all" → gabung semua kategori, satu command per baris (rata kiri, no kolom — 
        // biar gampang dibaca & ga kepotong)
        if (showCat === 'all') {
          const blocks = Object.entries(CATS).map(([k, cmds]) => {
            return `╭┈〔 ${title(k)} Menu 〕\n` +
              cmds.map(c => `┊ ◈ ${p}${c}`).join('\n') +
              `\n╰┈┈┈┈┈┈┈┈`;
          });
          await reply(`╭┈〔 𝙈𝙀𝙉𝙐 𝘼𝙇𝙇 〕\n┊ ◈ Semua command (${ALL_COMMANDS.length} fitur)\n╰┈┈┈┈┈┈┈┈\n\n${blocks.join('\n\n')}\n\n> _${botData.footer_text || 'Powered by YaaParBot'}_`);
          return true;
        }

        // Kategori tunggal → dua kolom
        const cmds = CATS[showCat];
        const cols = [];
        for (let i = 0; i < cmds.length; i += 2) cols.push(cmds.slice(i, i + 2));
        const txt =
          `╭┈〔 ${title(showCat)} Menu 〕\n` +
          cols.map(col => `┊ ${col.map((c, j) => `${j === 0 ? '◈' : '·'} ${p}${c}`.padEnd(20)).join('│ ')}`).join('\n') +
          `\n╰┈┈┈┈┈┈┈┈\n\n` +
          `📝 *${botData.description || process.env.DESC_DEFAULT || ''}*\n\n` +
          `> _${botData.footer_text || 'Powered by YaaParBot'}_`;
        await reply(txt);
        return true;
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

      const catList = `│  ${Object.keys(CATS).join(' / ')}`;

      const head =
        `╭ • *🧾  ${sapaan}* • ─\n` +
        `│  🗓️ Hari : ${HARI[wp('weekday')] || wp('weekday')}\n` +
        `│  📅 Tanggal : ${wp('day')}/${wp('month')}/${wp('year')}\n` +
        `│  ⏰ Waktu : ${wp('hour')}:${wp('minute')}:${wp('second')} WIB\n\n` +
        `Hi ${namaUser}\n` +
        `"my name is ${botData.bot_name} and I'm here to help you. Feel free to choose a menu or type a command you need."\n\n` +
        `⪻───≪〔 INFO  〕≫───⪼\n` +
        `Nama Bot : ${botData.bot_name}\n` +
        `* Nama user    : ${namaUser}\n` +
        `* role    : ${role}\n` +
        `* Limit    : ${limitTxt}\n\n`;

      const tail =
        `${catList}\n\n` +
        `📌 *Note:* ketik *${p}menu <kategori>* untuk lihat isinya.\n` +
        `Contoh: *${p}menu downloader* — semua command: *${p}menu all*\n\n` +
        `*_${botData.footer_text || 'Powered by YaaParBot'}_*`;

      // Pesan TEKS: filler readmore 4001 char (`RM`) — lipatan "Baca selengkapnya"
      // jatuh persis di bawah baris `Limit`; sisa menu ke bawah cuma kesembunyi.
      const caption = head + `${RM}\n` + tail;

      // Caption gambar dibatasi WA 1024 char → filler 4001 nggak muat. Sisa jatah
      // (1024 − head − tail) dipakai buat filler, jadi lipatannya jatuh di titik
      // yang sama: tepat di bawah baris `Limit`, bukan di baris kategori.
      const captionImg = head +
        '\u200e'.repeat(Math.max(0, 1024 - head.length - tail.length - 1)) +
        '\n' + tail;

      // ── Kirim menu dalam SATU bubble ─────────────────────────────────────
      // Bubble = gambar banner (kalau ada) dengan caption = isi menu.
      // Tombol dropdown `nativeFlowMessage.single_select` DIBUANG atas
      // permintaan Pak; kategori tetap bisa dibuka lewat `.menu <kategori>`.
      // ponytail: kalau tombol mau balik lagi, `07-button.js` masih punya
      // handleRowId untuk id `menu_cat:<kategori>`.
      let bannerPesan = null;
      if (process.env.MENU_BANNER === '1') {
        try {
          bannerPesan = await _menuBannerHeader(botData);
        } catch (e) {
          // Jangan diam — kalau banner gagal, menu tetap terkirim sebagai teks.
          console.error('[menu] banner gagal:', e.message);
        }
      }
      // DEBUG sementara: bikin kelihatan di `pm2 logs` apakah jalur banner jalan.
      console.log(`[menu] MENU_BANNER=${process.env.MENU_BANNER || '(off)'} banner_url=${botData.banner_url || '(kosong)'} ` +
                  `BANNER_DEFAULT=${process.env.BANNER_DEFAULT || '(kosong)'} → gambar=${bannerPesan ? `${bannerPesan.buf.length}B (caption = menu)` : '(tidak ada)'}`);

      try {
        if (bannerPesan) {
          // Caption WA dibatasi 1024 char — filler readmore di atas sudah
          // dipangkas otomatis di `captionImg` supaya totalnya pas.
          await client.message.send(jid, {
            type: 'image', media: bannerPesan.buf, mimetype: 'image/jpeg',
            caption: captionImg,
          });
        } else {
          await client.message.send(jid, { type: 'text', text: caption });
        }
      } catch (e) {
        console.error('[menu] gagal kirim:', e.message);
        await reply(caption); // jangan hilang menunya
      }

      // ── Tombol [menu] [owner] — bubble terpisah ──────────────────────────
      // Tombol WA tidak bisa menempel di gambar: media bersarang di dalam buttonsMessage nggak
      // ikut ke-upload oleh engine (bukan soal proto-nya) — payload-nya
      // round-trip aman, tapi WA nggak render. Jadi tombol dikirim bubble sendiri.
      try {
        await client.message.send(jid, {
          buttonsMessage: {
            contentText: 'Pilih menu di bawah ini 👇',
            footerText:  botData.footer_text || 'Powered by YaaParBot',
            headerType:  proto.Message.ButtonsMessage.HeaderType.TEXT,
            text:        `📋 *Menu ${botData.bot_name}*`,
            buttons: [
              { buttonId: 'btn_all',   buttonText: { displayText: '📋 All Menu' }, type: proto.Message.ButtonsMessage.Button.Type.RESPONSE },
              { buttonId: 'btn_owner', buttonText: { displayText: '👑 Owner'    }, type: proto.Message.ButtonsMessage.Button.Type.RESPONSE },
            ],
          },
        });
      } catch { /* tombol opsional — menu tetap terkirim */ }

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
        `│ Nama   : ${botData.bot_name}\n` +
        `│ Prefix : ${p}\n` +
        `│ Uptime : ${formatUptime(Date.now() - START_TIME)}\n` +
        `│ RAM    : ${used}/${total} MB\n` +
        `│ Node   : ${process.version}\n` +
        `│ OS     : ${os.type()} ${os.release()}\n` +
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
      await reply(`⏰ *Uptime Bot*\n${formatUptime(Date.now() - START_TIME)}`);
      return true;
    }

    // ── react — kasih emoji reaction ke pesan yang di-reply ─────────────────
    case 'react': {
      const emoji = args[0]?.trim();
      if (!emoji) { await reply(`Penggunaan: ${p}react <emoji>\nContoh: ${p}react 🔥`); return true; }
      const quotedKey = msg.message?.extendedTextMessage?.contextInfo;
      if (!quotedKey?.stanzaId) { await reply(`Reply pesan yang ingin di-react, lalu ketik ${p}react <emoji>`); return true; }
      try {
        await client.message.send(jid, {
          type: 'reaction',
          target: {
            id:          quotedKey.stanzaId,
            remoteJid:   jid,
            fromMe:      false,
            participant: quotedKey.participant,
          },
          emoji,
        });
      } catch (e) {
        await reply(`❌ Gagal react: ${e.message}`);
      }
      return true;
    }

    case 'carifitur': {
      const q = args.join(' ').toLowerCase();
      if (!q) { await reply(`Penggunaan: ${p}carifitur <nama command>`); return true; }
      const found = [...new Set(ALL_COMMANDS.filter(c => c.includes(q)))];
      if (found.length === 0) {
        await reply(`❌ Tidak ada fitur yang cocok dengan *${q}*`);
      } else {
        await reply(`🔍 *Hasil Pencarian: "${q}"*\n\n` + found.map(c => `${p}${c}`).join('\n'));
      }
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
        const { name, lim, premium } = rows[0];
        const isPrem = premium === 1;
        const defLimit = parseInt(process.env.DEFAULT_LIMIT || '20', 10);

        const txt =
          `💎 *CEK LIMIT*\n\n` +
          `👤 Nama   : ${name || sender.split('@')[0]}\n` +
          `💎 Limit  : *${lim}* tersisa\n` +
          `⭐ Status : ${isPrem ? '*Premium* (skip limit)' : 'User biasa'}\n` +
          `🔄 Reset  : Setiap hari jam *00:00 WIB* → ${defLimit} limit`;

        await reply(txt);
      } catch (e) {
        await reply(`Gagal cek limit: ${e.message}`);
      }
      return true;
    }

    default:
      return false;
  }
};

// Command yang kena limit untuk user biasa
module.exports.limitedCmds = new Set([
  'limit','react',
]);

// Dipakai self-check (tanpa ini helper-nya cuma bisa dites lewat handler penuh).
module.exports._menuBannerHeader = _menuBannerHeader;
module.exports.ALL_COMMANDS      = ALL_COMMANDS;
module.exports.CATS              = CATS;
