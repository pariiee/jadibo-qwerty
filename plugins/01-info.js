'use strict';

/**
 * plugins/01-info.js
 * Commands: !ping, !menu, !info, !owner, !uptime, !profil, !carifitur, !totalfitur
 */

const os = require('os');
const { genThumbnail } = require('../engine/thumbnail');

const START_TIME = Date.now();

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
  'ping','menu','info','owner','uptime','profile','me','carifitur','totalfitur','limit','uptname',
  // Grup
  'tagall','tagadmin','tagme','hidetag','ht','kick','kickall','promote','demote',
  'open','close','mute','unmute','slowmode','setname','setdesc','linkgroup','upswgc',
  'groupinfo','grouplist','leavegc','listadmin','getpp','totag',
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
  'sticker','s','wm','poll','readmore','encode','decode','kalkulator','pick','tourl','tourl2','upload2','upload','pay','tomp4','topng','artinama','attp','brat','bratvid','fakech','fakecall','fakecallip','fakedana','fakeovo','fakegcios','fakepptele','igqc','igstoryimg','iqc','ttqc','dafont','dafontdl','lirik','genius','gsmarena','spek','jarak','kbbi','kodepos',
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
  info:   ['ping','menu','info','owner','uptime','profile','me','carifitur','totalfitur','limit','uptname'],
  grup:   ['tagall','tagadmin','tagme','hidetag','ht','kick','kickall','promote','demote','open','close','mute','unmute','slowmode','setname','setdesc','linkgroup','upswgc','groupinfo','grouplist','leavegc','listadmin','getpp','totag','delete','cekasalmember','absen','mulaiabsen','cekabsen','hapusabsen','afk','listafk','topchat','antidelete','setwelcome','setbye','delwelcome','delbye','setdetect','deldetect','mulaigiveaway','ikut','rollgiveaway','cekgiveaway','cekmenang','hapusgiveaway'],
  proteksi: ['on','off','fitur','proteksi','antibot','antilink','antilinkv2','antitoxic','antispam','antitagsw','autosticker','antisticker','viewonce','autolevelup','detect','autoacc','document','nyimak','autoread'],
  rpg:    ['unreg','profile','me','claim','hourly','weekly','dailymisi','kerja','mancing','berburu','hunt','bertarung','fight','dungeon','adventure','koboy','airdrop','maling','lamarkerja','job','gajian','transfer','tf','bank','atm','topkoin','lb','leaderboard','store','beli','inventory','pakai','gacha','slot','jodoh','suitpvp','coinflip','cf','tictactoe','ttt'],
  maker:  ['sticker','s','wm','brat','bratvid','attp','fakech','fakecall','fakecallip','fakedana','fakeovo','fakegcios','fakepptele','rvo','readviewonce','readvo','liat','swgc','upswgc'],
  tools:  ['poll','readmore','encode','decode','kalkulator','pick','tourl','tourl2','upload2','upload','pay','tomp4','topng','artinama','igqc','igstoryimg','iqc','ttqc','dafont','dafontdl','lirik','genius','gsmarena','spek','jarak','kbbi','kodepos','bandinghp','comparehp','wilayah','cariwilayah','imei','cekimei','gempa','cuaca','weather','accuweather','prakiraan','checkwa','cekwa','translate','terjemah','tr','qrcode','qr','decodeqr','readqr','ocr','upscale','hd','enhance','ssweb','ss','screenshot','fancytext','fancy','nik','nikinfo','iplookup','ipcek','reverseip','httpheaders','headers','nationalday','hariini','shalat','jadwalshalat','kalendershalat','kshalat','konversitanggal','tanggal','bypass','bypasssfl','bpsfl','drakor','duolingo','npm','resep','steam','play','lk21','lk21trending','lk21search','filmsearch','mcpedl','berita','pinterest','tokopedia','toped','stalktiktok','stalktt','tiktokstalk','roblox','stalkroblox','cekroblox','minecraft','mc','stalkmc','stalkgithub','ghstalk','genshin','stalkgenshin','freefire','ff','stalkff','discord','stalkdiscord','chess','stalkchess','nimegami','nimegamis','animesearch','shinigami','spotify','spotifylyrics','slyrics','tiktokphoto','ttkphoto','searchcode','caricode'],
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
  const { command, args, reply, react, botData, client, sock, jid, sender, isGroup } = ctx;
  const p = botData.prefix;

  switch (command) {
    case 'ping': {
      const start = Date.now();
      await react('⏱️');
      const latency = Date.now() - start;
      await reply(`🏓 *Pong!*\n⚡ Latensi: ${latency}ms\n✅ Bot aktif`);
      return true;
    }

    case 'menu': {
      const role = ctx.isOwner ? 'Owner' : (ctx.isAdmin ? 'Admin' : 'User');
      const botNum = (botData.bot_number || botData.owner_number || '-').replace(/\D/g, '') || '-';

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

      // ── Menu utama: header + deskripsi + kategori ────────────────────────
      const header =
        `╭┈〔 𝘽𝙊𝙏 〕\n` +
        `┊ ◈ *Name*   › ${botData.bot_name}\n` +
        `┊ ◈ *Number* › ${botNum}\n` +
        `┊ ◈ *Access* › ${role}\n` +
        `╰┈┈┈┈┈┈┈┈`;

      const desc = `📝 *${botData.description || process.env.DESC_DEFAULT || 'Bot WhatsApp serbaguna'}*`;

      const catList =
        `┌─────────────────────────────────\n` +
        `│  \u{1D648}\u{1D640}\u{1D649}\u{1D650} \u{1D63E}\u{1D63C}\u{1D64F}\u{1D640}\u{1D642}\u{1D64A}\u{1D64D}\u{1D644}\n` +
        `├─────────────────────────────────\n` +
        Object.keys(CATS).map(k =>
          `│  ${k}`).join('\n') +
        `\n╰─────────────────────────────────\n\n` +
        `📌 *Note:* ketik *${p}menu <kategori>* untuk lihat isinya.\n` +
        `Contoh: *${p}menu downloader* — semua command: *${p}menu all*\n\n` +
        `> _${botData.footer_text || 'Powered by YaaParBot'}_`;
      const caption = `${header}\n\n${desc}\n\n${RM}\n${catList}`;

      if (botData.banner_url || process.env.BANNER_DEFAULT) {
        const bannerSrc = botData.banner_url || null;
        const bannerPath = !bannerSrc && process.env.BANNER_DEFAULT
          ? require('path').resolve(process.env.BANNER_DEFAULT)
          : null;

        try {
          let buffer;
          if (bannerSrc) {
            // Download dari URL
            const https  = require('https');
            const http   = require('http');
            const urlMod = require('url');
            const parsed = urlMod.parse(bannerSrc);
            const proto  = parsed.protocol === 'https:' ? https : http;
            buffer = await new Promise((resolve, reject) => {
              proto.get(bannerSrc, (res) => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end',  () => resolve(Buffer.concat(chunks)));
                res.on('error', reject);
              }).on('error', reject);
            });
          } else {
            // Baca dari file lokal
            buffer = require('fs').readFileSync(bannerPath);
          }

          await client.message.send(jid, {
            type:    'image',
            media:   buffer,
            mimetype: 'image/jpeg',
            caption,
            ...(await genThumbnail(buffer, 'image/jpeg').then(t => t ? { jpegThumbnail: t } : {}).catch(() => ({}))),
            contextInfo: {
              stanzaId:    'VELZ-B0QX95X5',
              participant: '0@s.whatsapp.net',
              quotedMessage: {
                groupInviteMessage: {
                  groupJid:  '0@g.us',
                  groupName: botData.bot_name || 'YaaParBot',
                  caption:   'www.yapari.web.id',
                },
              },
              remoteJid: jid,
            },
          });
        } catch {
          await reply(caption);
        }
      } else {
        await reply(caption);
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
        if (!rows[0]) { await reply(`❌ Kamu belum terdaftar. Ketik *${p}daftar* untuk daftar.`); return true; }
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
  'limit',
]);
