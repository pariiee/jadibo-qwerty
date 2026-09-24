'use strict';

/**
 * plugins/04-tools.js
 * Commands: sticker, poll, readmore, base64, kalkulator, pick, removebg
 */

const { rapikanError } = require('../engine/pesanError');
const mess           = require('../config/mess');
const { genThumbnail, jpegkan } = require('../engine/thumbnail');
const { addStickerExif, videoKeStickerWebp } = require('../engine/sticker');
const { uploadInfo, upload, apiGet, url: apiUrl, auth: apiAuth } = require('../engine/api');
const { normalVideo } = require('../engine/normalVideo');

// ─── Helper: mime type → ekstensi file ───────────────────────────────────────
function mimeToExt(mime) {
  const map = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp',
    'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/mpeg': 'mpeg',
    'audio/mpeg': 'mp3', 'audio/mp4': 'mp4', 'audio/ogg': 'ogg',
    'audio/wav': 'wav', 'audio/aac': 'aac', 'audio/opus': 'opus',
    'application/pdf': 'pdf', 'application/zip': 'zip',
    'image/vnd.mozilla.apng': 'apng',
  };
  return map[mime] || 'bin';
}

// ─── Helper: nama file aman buat diupload ────────────────────────────────────
// `content.fileName` dari proto WA bisa ter-encode URL (mis.
// "soal_0020_nasib%20buruk.png") atau ada karakter aneh. Dinormalisasi biar
// nama yang dikirim ke host upload bersih (huruf/angka/titik/dash/underscore),
// dan ekstensinya selalu disamain sama mime asli.
function namaFileAman(nama, mime, fallbackExt) {
  const ext  = fallbackExt || mimeToExt(mime);
  let bersih = '';
  try { bersih = decodeURIComponent(String(nama || '')); } catch { bersih = String(nama || ''); }
  bersih = bersih.split(/[\\/]/).pop()                 // buang path
                 .replace(/[^A-Za-z0-9._-]/g, '_')     // sisain karakter aman
                 .replace(/^_+|_+$/g, '');
  const base = bersih.replace(/\.[A-Za-z0-9]{1,5}$/, '').slice(0, 60);
  return `${base || `file_${Date.now()}`}.${ext}`;
}

// In-memory session store: `${botId}:${sender}` -> conversationId
const gptSessions     = new Map();
const geminiSessions  = new Map();
const deepaiSessions  = new Map();

// ─── Helper: ambil media (direct/caption ATAU reply) → { msgType, buffer, mime } ──
// Kirim gambar/video dengan caption ".cmd" → msg.message = media (direct).
// Reply media → media ada di extendedTextMessage.contextInfo.quotedMessage.
async function extractMedia(ctx, allowed = ['imageMessage', 'videoMessage', 'stickerMessage', 'audioMessage', 'documentMessage']) {
  const { client, msg } = ctx;
  const rawMsg  = msg.message || {};
  const msgType = Object.keys(rawMsg)[0] || '';
  const quoted  = rawMsg?.extendedTextMessage?.contextInfo?.quotedMessage;
  const quotedType = quoted ? Object.keys(quoted)[0] : null;

  const isDirect = allowed.includes(msgType);
  const isQuoted = allowed.includes(quotedType);
  if (!isDirect && !isQuoted) return null;

  const content = isDirect ? rawMsg[msgType] : quoted[quotedType];
  const fixed   = Object.assign({}, content);
  for (const f of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
    if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
  }
  const sourceType = isDirect ? msgType : quotedType;
  const buffer     = Buffer.from(await client.message.downloadBytes({ [sourceType]: fixed }));
  const mime       = content.mimetype || 'application/octet-stream';
  return { msgType: sourceType, buffer, mime, isDirect, isQuoted };
}

// ─── Helper: pilih N video terbaik dari hasil pencarian TikTok ───────────────
// Skor = berapa banyak kata kunci (>2 huruf) yang muncul di judul; seri →
// durasi terpendek; masih seri → peringkat API yang lebih atas.
// ponytail: heuristik kata-per-kata; upgrade ke fuzzy/embedding kalau hasil
// teratas sering melenceng. Endpoint tidak mengirim playCount, jadi popularitas
// belum bisa dipakai sebagai patokan.
const keyWords = (q) => String(q || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
const keyMatch = (title, q) => {
  const w = keyWords(q);
  return w.length > 0 && String(title || '').toLowerCase().includes(w[0]);
};

function pickTopVideos(list, q, n = 3) {
  const words = keyWords(q);
  const scored = list.map((v, i) => {
    const title = String(v.title || '').toLowerCase();
    const hit   = words.filter(w => title.includes(w)).length;
    return { v, matcher: words.length ? hit / words.length : 0.5, dur: parseInt(v.duration, 10) || 999, i };
  });
  scored.sort((a, b) => b.matcher - a.matcher || a.dur - b.dur || a.i - b.i);
  return scored.slice(0, n).map(s => s.v);
}

// Jalanin yt-dlp. missing=true kalau binary nggak ada (mis. di Windows lokal).
// Dipakai bareng oleh `.play` dan `.ttsearch`.
function runYtDlp(argv, timeoutMs = 180000) {
  const { spawn } = require('child_process');
  return new Promise(resolve => {
    let out = '', err = '', done = false, ch;
    try { ch = spawn('yt-dlp', argv); } catch (e) { return resolve({ ok: false, out: '', err: String(e.message), missing: true }); }
    const timer = setTimeout(() => { try { ch.kill('SIGKILL'); } catch {} finish({ ok: false, out, err: err + ' [timeout]' }); }, timeoutMs);
    const finish = r => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    ch.stdout.on('data', d => { out += d; });
    ch.stderr.on('data', d => { err += d; });
    ch.on('error', e => finish({ ok: false, out, err: String(e.message), missing: e.code === 'ENOENT' }));
    ch.on('close', code => finish({ ok: code === 0, out, err }));
  });
}

module.exports = async function toolsHandler(ctx) {
  if (!ctx.isCmd) return false;

  // ─── Helper: cari + unduh audio lagu (yt-dlp local → ffmpeg mp3) ───────────
  // Dipakai bareng `.play`, `.spotify` (tombol), dan `.spotifydl` (fallback
  // waktu spotidown.app mati). Balikin { ok, buf, mime, title, artist, dur }
  // atau { ok:false, alasan } — pemanggil yang ngurus pesan ke user.
  async function ambilAudioLagu(kueri) {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { spawn } = require('child_process');

    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

    // 1) Cari kandidat + saring kompilasi/full album/live loop
    let pick = null;
    const srch = await runYtDlp(['--flat-playlist', '--no-warnings', '-J', `ytsearch10:${kueri}`], 90000);
    if (srch.ok) {
      let list = [];
      try { list = JSON.parse(srch.out)?.entries || []; } catch {}
      const tokens = norm(kueri).split(' ').filter(t => t.length > 1);
      const scored = list
        .filter(e => e && e.id && !e.is_live && Number.isFinite(e.duration))
        .filter(e => e.duration >= 30 && e.duration <= 600)
        .map(e => {
          const t = norm(e.title);
          const hit = tokens.filter(tk => t.includes(tk)).length;
          return { ...e, _ratio: tokens.length ? hit / tokens.length : 0 };
        })
        .sort((a, b) => (b._ratio - a._ratio) || (a.duration - b.duration));
      pick = scored[0]
          || list.find(e => e && e.id && Number.isFinite(e.duration) && e.duration <= 3600)
          || null;
    }
    if (!pick) {
      // yt-dlp nggak ada (mis. lokal Windows) → jalur API lama (yt-search + ytmp3)
      const axios = require('axios');
      const search = require('yt-search');
      const look = await search(kueri);
      const conv = (look.videos || []).filter(v => v.seconds >= 30 && v.seconds <= 600)[0] || look.videos?.[0];
      if (!conv) return { ok: false, alasan: 'Lagu tidak ditemukan' };
      const mp3 = await axios.get(`${process.env.BASE_API}api/download/ytmp3`, {
        params: { url: conv.url }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 60000,
      });
      const d = mp3.data?.results;
      if (!d?.audio?.url) return { ok: false, alasan: 'Tidak ada audio dari konverter' };
      const chosen = (Array.isArray(d.audios) ? d.audios.find(a => a.format === 'm4a') : null) || d.audio;
      const res = await axios.get(chosen.url, { responseType: 'arraybuffer', timeout: 120000 });
      return {
        ok: true, buf: Buffer.from(res.data), mime: chosen.format === 'm4a' ? 'audio/mp4' : 'audio/mpeg',
        title: d.title || conv.title, artist: d.channel || conv.author?.name, dur: d.duration_str || conv.timestamp,
      };
    }

    try {
      // 2) Unduh audio lokal (URL-nya terikat IP server ini)
      const tmpl = path.join(os.tmpdir(), `play_${Date.now()}.%(ext)s`);
      const dl = await runYtDlp(['-f', 'bestaudio[ext=m4a]/bestaudio', '--no-playlist', '--no-warnings',
                                 '--no-simulate', '--print', 'after_move:filepath',
                                 '-o', tmpl, pick.id], 240000);
      const filePath = (dl.out || '').trim().split('\n').pop().trim();
      if (!dl.ok || !filePath || !fs.existsSync(filePath)) throw new Error('Gagal mengunduh audio');
      const rawBuf = fs.readFileSync(filePath);
      try { fs.unlinkSync(filePath); } catch {}

      // 3) Convert ke MP3 biar pasti playable di WA
      const tmpIn  = path.join(os.tmpdir(), `play_in_${Date.now()}`);
      const tmpOut = path.join(os.tmpdir(), `play_out_${Date.now()}.mp3`);
      fs.writeFileSync(tmpIn, rawBuf);
      let finalBuf = rawBuf, ffOk = false;
      try {
        await new Promise((resolve, reject) => {
          const ff = spawn('ffmpeg', ['-y', '-i', tmpIn, '-vn', '-codec:a', 'libmp3lame', '-b:a', '128k', tmpOut]);
          ff.on('error', reject);
          ff.on('close', code => code !== 0 ? reject(new Error(`ffmpeg exit ${code}`)) : resolve());
        });
        finalBuf = fs.readFileSync(tmpOut);
        ffOk = true;
      } catch { /* kirim apa adanya */ }
      try { fs.unlinkSync(tmpIn); } catch {}
      try { fs.unlinkSync(tmpOut); } catch {}

      const fmtDur = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
      return {
        ok: true, buf: finalBuf, mime: ffOk ? 'audio/mpeg' : 'audio/mp4',
        title: pick.title, artist: pick.uploader, dur: pick.duration_string || (pick.duration ? fmtDur(pick.duration) : ''),
      };
    } catch (eYt) {
      // yt-dlp lokal gagal (diblokir/rate-limit/format berubah) → jalur API lama,
      // jangan langsung nyerah: yt-search cari, /api/download/ytmp3 konversi.
      const axios  = require('axios');
      const search = require('yt-search');
      const look   = await search(kueri);
      const conv   = (look.videos || []).filter(v => v.seconds >= 30 && v.seconds <= 600)[0] || look.videos?.[0];
      if (!conv) return { ok: false, alasan: 'Lagu tidak ditemukan' };
      const mp3 = await axios.get(`${process.env.BASE_API}api/download/ytmp3`, {
        params: { url: conv.url }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 90000,
      });
      const d = mp3.data?.results;
      const audios = Array.isArray(d?.audios) ? d.audios : [];
      const chosen = audios.find(a => (a.bitrate || '').includes('128')) || d?.audio;
      if (!chosen?.url) return { ok: false, alasan: 'Tidak ada audio dari konverter' };
      const res = await axios.get(chosen.url, { responseType: 'arraybuffer', timeout: 120000 });
      return {
        ok: true, buf: Buffer.from(res.data),
        mime: chosen.ext === 'm4a' || chosen.ext === 'mp4' ? 'audio/mp4' : 'audio/mpeg',
        title: conv.title, artist: conv.author?.name || conv.channel, dur: conv.timestamp,
      };
    }
  }


  const { command, args, reply, react, sock, client, jid, sender, msg, botData, isGroup } = ctx;
  const p = botData.prefix;

  switch (command) {

    // ── sticker ────────────────────────────────────────────────────────────
    case 'sticker':
    case 's': {
      const rawMsg     = msg.message || {};
      const msgType    = Object.keys(rawMsg)[0] || '';
      const quoted     = rawMsg?.extendedTextMessage?.contextInfo?.quotedMessage;
      const quotedType = quoted ? Object.keys(quoted)[0] : null;

      const mediaTypes    = ['imageMessage', 'videoMessage', 'stickerMessage'];
      const isDirectMedia = mediaTypes.includes(msgType);
      const isQuotedMedia = quotedType && mediaTypes.includes(quotedType);

      if (!isDirectMedia && !isQuotedMedia) {
        await reply(`Reply atau kirim gambar/video dengan ${p}s untuk membuat sticker`);
        return true;
      }

      try {
        const sharp     = require('sharp');
        const fs        = require('fs');
        const path      = require('path');
        const os        = require('os');

        let buffer, mime;

        if (isDirectMedia) {
          const content = rawMsg[msgType];
          const fixed   = Object.assign({}, content);
          for (const f of ['mediaKey','fileSha256','fileEncSha256']) {
            if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
          }
          buffer = await client.message.downloadBytes({ [msgType]: fixed });
          mime   = content.mimetype || 'image/jpeg';
        } else {
          const content = quoted[quotedType];
          const fixed   = Object.assign({}, content);
          for (const f of ['mediaKey','fileSha256','fileEncSha256']) {
            if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
          }
          buffer = await client.message.downloadBytes({ [quotedType]: fixed });
          mime   = content.mimetype || 'image/jpeg';
        }

        const isVideo = /video/.test(mime) || mime === 'image/gif';

        if (isVideo) {
          const tmpDir = os.tmpdir();
          const inExt  = mime === 'image/gif' ? 'gif' : 'mp4';
          const tmpIn  = path.join(tmpDir, `sticker_in_${Date.now()}.${inExt}`);
          const tmpOut = path.join(tmpDir, `sticker_out_${Date.now()}.webp`);
          fs.writeFileSync(tmpIn, buffer);

          // Durasi 10 detik; resolusi/fps/quality turun otomatis kalau kegedean.
          const { buf: webpBuffer } = await videoKeStickerWebp(tmpIn, tmpOut);

          try { fs.unlinkSync(tmpIn); } catch {}
          try { fs.unlinkSync(tmpOut); } catch {}

          if (!webpBuffer || webpBuffer.length > 500 * 1024) {
            await reply(`❌ Sticker terlalu besar (${Math.round(webpBuffer.length/1024)}KB, batas WA 500KB). Coba videonya lebih pendek.`);
            return true;
          }

          const finalBuf = await addStickerExif(webpBuffer, mess.packname, mess.author);
          await client.message.send(jid, { type: 'sticker', media: finalBuf, mimetype: 'image/webp' });
        } else {
          const webpBuffer = await sharp(Buffer.from(buffer))
            .resize(512, 512, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
            .webp({ quality: 90, lossless: false })
            .toBuffer();
          const finalBuf = await addStickerExif(webpBuffer, mess.packname, mess.author);
          await client.message.send(jid, { type: 'sticker', media: finalBuf, mimetype: 'image/webp' });
        }
      } catch (e) {
        await reply(`Gagal membuat sticker: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── wm ────────────────────────────────────────────────────────────────
    case 'wm': {
      const rawMsg     = msg.message || {};
      const msgType    = Object.keys(rawMsg)[0] || '';
      const quoted     = rawMsg?.extendedTextMessage?.contextInfo?.quotedMessage;
      const quotedType = quoted ? Object.keys(quoted)[0] : null;

      const stickerTypes = ['imageMessage', 'videoMessage', 'stickerMessage'];
      const isDirectMedia = stickerTypes.includes(msgType);
      const isQuotedMedia = quotedType && stickerTypes.includes(quotedType);

      if (!isDirectMedia && !isQuotedMedia) {
        await reply(`Penggunaan: ${p}wm Packname | Author\n(Reply atau kirim gambar/video/stiker)`);
        return true;
      }

      // Parse packname & author dari args
      const wmInput   = args.join(' ').trim();
      const [wmPack, wmAuthor] = wmInput.split('|').map(s => s.trim());
      const packname  = wmPack   || process.env.STICKER_PACK_NAME || 'YaaParBot';
      const author    = wmAuthor || process.env.STICKER_AUTHOR    || 'yapari.web.id';

      try {
        const sharp  = require('sharp');
        const fs     = require('fs');
        const path   = require('path');
        const { spawn } = require('child_process');
        const os     = require('os');

        let buffer, mime;

        if (isDirectMedia) {
          const content = rawMsg[msgType];
          const fixed   = Object.assign({}, content);
          for (const f of ['mediaKey','fileSha256','fileEncSha256']) {
            if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
          }
          buffer = Buffer.from(await client.message.downloadBytes({ [msgType]: fixed }));
          mime   = content.mimetype || 'image/webp';
        } else {
          const content = quoted[quotedType];
          const fixed   = Object.assign({}, content);
          for (const f of ['mediaKey','fileSha256','fileEncSha256']) {
            if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
          }
          buffer = Buffer.from(await client.message.downloadBytes({ [quotedType]: fixed }));
          mime   = content.mimetype || 'image/webp';
        }

        const activeType = isDirectMedia ? msgType : quotedType;
        const isAnimated = activeType === 'videoMessage' || mime === 'image/gif';
        let webpBuffer;

        if (isAnimated) {
          // Video/GIF → animated WebP
          const tmpDir = os.tmpdir();
          const inExt  = mime === 'image/gif' ? 'gif' : 'mp4';
          const tmpIn  = path.join(tmpDir, `wm_in_${Date.now()}.${inExt}`);
          const tmpOut = path.join(tmpDir, `wm_out_${Date.now()}.webp`);
          fs.writeFileSync(tmpIn, buffer);
          await new Promise((resolve, reject) => {
            const ff = spawn('ffmpeg', [
              '-y', '-i', tmpIn,
              '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,fps=15',
              '-vcodec', 'libwebp', '-lossless', '0', '-compression_level', '6',
              '-quality', '70', '-loop', '0', '-preset', 'default', '-an',
              '-vsync', '0', tmpOut
            ]);
            ff.on('error', reject); // ffmpeg tidak ada → reject, jangan crash proses
            ff.on('close', code => {
              try { fs.unlinkSync(tmpIn); } catch {}
              if (code === 0) resolve(); else reject(new Error(`ffmpeg exit ${code}`));
            });
          });
          webpBuffer = fs.readFileSync(tmpOut);
          try { fs.unlinkSync(tmpOut); } catch {}
        } else {
          // Gambar/stiker → WebP via sharp
          webpBuffer = await sharp(buffer)
            .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .webp({ quality: 80 })
            .toBuffer();
        }

        // Inject EXIF metadata baru
        const withExif = await addStickerExif(webpBuffer, packname, author);

        await client.message.send(jid, {
          type: 'sticker',
          media: withExif,
          mimetype: 'image/webp',
        });
      } catch (e) {
        console.error('[WM] Error:', e.message);
        await reply(`Gagal mengubah watermark: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── poll ──────────────────────────────────────────────────────────────
    case 'poll': {
      // Format: .poll Pertanyaan? | Opsi1 | Opsi2 | Opsi3
      const full  = args.join(' ');
      const parts = full.split('|').map(s => s.trim()).filter(Boolean);
      if (parts.length < 3) {
        await reply(`Format: ${p}poll Pertanyaan? | Opsi 1 | Opsi 2 | Opsi 3`);
        return true;
      }
      const question = parts[0];
      const options  = parts.slice(1);
      try {
        await client.message.send(jid, {
          type: 'poll',
          name: question,
          options: options,
          selectableCount: 1,
        });
      } catch (e) {
        console.error('[Poll] Error:', e.message);
        // Fallback text poll
        const optList = options.map((o, i) => `${i + 1}. ${o}`).join('\n');
        await reply(`📊 *POLL*\n\n*${question}*\n\n${optList}`);
      }
      return true;
    }

    // ── tovn / 2vo — convert audio/video ke voice note PTT ───────────────
    case 'tovn':
    case '2vo': {
      const rawMsg     = msg.message || {};
      const msgType    = Object.keys(rawMsg)[0] || '';
      const quoted     = rawMsg?.extendedTextMessage?.contextInfo?.quotedMessage;
      const quotedType = quoted ? Object.keys(quoted)[0] : null;

      const allowed    = ['audioMessage', 'videoMessage', 'documentMessage'];
      const isDirect   = allowed.includes(msgType);
      const isQuoted   = allowed.includes(quotedType);

      if (!isDirect && !isQuoted) {
        await reply(`Reply atau kirim audio/video dengan ${p}${command} untuk convert ke voice note`);
        return true;
      }

      try {
        await react(mess.reactLoading);
        const fs     = require('fs');
        const path   = require('path');
        const os     = require('os');
        const { spawn } = require('child_process');

        const srcType   = isDirect ? msgType : quotedType;
        const srcContent = isDirect ? rawMsg[srcType] : quoted[srcType];
        const fixed     = Object.assign({}, srcContent);
        for (const f of ['mediaKey','fileSha256','fileEncSha256']) {
          if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
        }
        const inBuf  = Buffer.from(await client.message.downloadBytes({ [srcType]: fixed }));
        const inExt  = srcType === 'audioMessage' ? (srcContent.mimetype?.includes('ogg') ? 'ogg' : 'mp3') : 'mp4';
        const tmpIn  = path.join(os.tmpdir(), `tovn_in_${Date.now()}.${inExt}`);
        const tmpOut = path.join(os.tmpdir(), `tovn_out_${Date.now()}.ogg`);
        fs.writeFileSync(tmpIn, inBuf);

        await new Promise((resolve, reject) => {
          const ff = spawn('ffmpeg', [
            '-y', '-i', tmpIn,
            '-c:a', 'libopus', '-b:a', '64k', '-vn',
            tmpOut,
          ]);
          ff.on('error', reject);
          ff.on('close', code => code !== 0 ? reject(new Error(`ffmpeg exit ${code}`)) : resolve());
        });

        const outBuf = fs.readFileSync(tmpOut);
        try { fs.unlinkSync(tmpIn); } catch {}
        try { fs.unlinkSync(tmpOut); } catch {}

        await client.message.send(jid, {
          type: 'audio',
          media: outBuf,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true,
        });
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal convert ke voice note: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── todoc — kirim ulang media/file sebagai dokumen ────────────────────
    case 'todoc': {
      const rawMsg     = msg.message || {};
      const msgType    = Object.keys(rawMsg)[0] || '';
      const quoted     = rawMsg?.extendedTextMessage?.contextInfo?.quotedMessage;
      const quotedType = quoted ? Object.keys(quoted)[0] : null;

      const allowed    = ['imageMessage','videoMessage','audioMessage','documentMessage','stickerMessage'];
      const isDirect   = allowed.includes(msgType);
      const isQuoted   = allowed.includes(quotedType);

      if (!isDirect && !isQuoted) {
        await reply(`Reply atau kirim file dengan ${p}todoc untuk kirim ulang sebagai dokumen`);
        return true;
      }

      try {
        await react(mess.reactLoading);
        const srcType    = isDirect ? msgType : quotedType;
        const srcContent = isDirect ? rawMsg[srcType] : quoted[srcType];
        const fixed      = Object.assign({}, srcContent);
        for (const f of ['mediaKey','fileSha256','fileEncSha256']) {
          if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
        }
        const buf  = Buffer.from(await client.message.downloadBytes({ [srcType]: fixed }));
        const mime = srcContent.mimetype || 'application/octet-stream';
        const ext  = mimeToExt(mime);
        const fileName = srcContent.fileName || `file_${Date.now()}.${ext}`;

        await client.message.send(jid, {
          type: 'document',
          media: buf,
          mimetype: mime,
          fileName,
        });
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal kirim sebagai dokumen: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── readmore ──────────────────────────────────────────────────────────
    case 'readmore': {
      const text = args.join(' ');
      if (!text) { await reply(`Penggunaan: ${p}readmore <teks sebelum>|<teks sesudah>`); return true; }
      const readMore = String.fromCharCode(8206).repeat(4001);
      const [left = '', right = ''] = text.split('|');
      await client.message.send(jid, { type: 'text', text: left + readMore + right });
      return true;
    }

    // ── base64 / encode ───────────────────────────────────────────────────
    // `.base64` ada di limitedCmds + ALL_COMMANDS, tapi handler-nya cuma
    // `case 'encode'`. Akibatnya `.base64` MOTONG limit lalu bot DIAM —
    // limit kebuang tanpa balasan. Dua-duanya diarahkan ke blok yang sama.
    case 'base64':
    case 'encode': {
      const text = args.join(' ');
      if (!text) { await reply(`Penggunaan: ${p}encode <teks>`); return true; }
      await reply(`🔒 *Base64 Encode*\n\n${Buffer.from(text).toString('base64')}`);
      return true;
    }

    case 'decode': {
      const text = args.join(' ');
      if (!text) { await reply(`Penggunaan: ${p}decode <teks>`); return true; }
      try {
        await reply(`🔓 *Base64 Decode*\n\n${Buffer.from(text, 'base64').toString('utf-8')}`);
      } catch {
        await reply('❌ Format base64 tidak valid');
      }
      return true;
    }

    // ── brat — Brat text image maker ─────────────────────────────────────
    case 'brat': {
      const text = args.join(' ').trim();
      if (!text) { await reply(`Penggunaan: ${p}brat <teks>\nContoh: ${p}brat hello world`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/maker/brat`, {
          params: { text },
          headers: { 'X-API-Key': process.env.KEY_API },
          responseType: 'arraybuffer',
          timeout: 30000,
        });
        const buffer = Buffer.from(res.data);
        const ct = res.headers['content-type'] || 'image/jpeg';
        const sharp = require('sharp');
        const webpBuffer = await sharp(buffer)
          .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .webp({ quality: 90 })
          .toBuffer();
        const stickerBuffer = await addStickerExif(webpBuffer, process.env.STICKER_PACK_NAME, process.env.STICKER_AUTHOR);
        await client.message.send(jid, {
          type: 'sticker',
          media: stickerBuffer,
          mimetype: 'image/webp',
        });
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`${mess.error}\n${e.message}`);
      }
      return true;
    }

    // ── bratvid — Brat animated sticker video ────────────────────────────
    case 'bratvid': {
      const text = args.join(' ').trim();
      if (!text) { await reply(`Penggunaan: ${p}bratvid <teks>\nContoh: ${p}bratvid hello world`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/maker/bratvid`, {
          params: { text, color: '#ffffff' },
          headers: { 'X-API-Key': process.env.KEY_API },
          responseType: 'arraybuffer',
          timeout: 30000,
        });
        const buffer = Buffer.from(res.data);
        // Sumbernya MP4 4,5 detik → di-loop biar genap 10 detik.
        const os   = require('os');
        const path = require('path');
        const fs   = require('fs');
        const tmpIn  = path.join(os.tmpdir(), `bratvid_in_${Date.now()}.mp4`);
        const tmpOut = path.join(os.tmpdir(), `bratvid_out_${Date.now()}.webp`);
        fs.writeFileSync(tmpIn, buffer);
        const { buf: webpBuffer } = await videoKeStickerWebp(tmpIn, tmpOut, { loop: true });
        try { fs.unlinkSync(tmpIn); } catch {}
        try { fs.unlinkSync(tmpOut); } catch {}
        const stickerBuffer = await addStickerExif(webpBuffer, process.env.STICKER_PACK_NAME, process.env.STICKER_AUTHOR);
        await client.message.send(jid, {
          type: 'sticker',
          media: stickerBuffer,
          mimetype: 'image/webp',
        });
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`${mess.error}\n${e.message}`);
      }
      return true;
    }

    // ── attp — Animated Text To Picture (sticker) ────────────────────────
    case 'attp': {
      const text = args.join(' ').trim();
      if (!text) { await reply(`Penggunaan: ${p}attp <teks>\nContoh: ${p}attp yapar labs`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/maker/attp`, {
          params: { text },
          headers: { 'X-API-Key': process.env.KEY_API },
          responseType: 'arraybuffer',
          timeout: 30000,
        });
        const buffer = Buffer.from(res.data);
        // Sumbernya GIF 0,8 detik isi 20 warna (BE: FRAME_COUNT 20 × 40ms).
        // Diregang 12,5× + diinterpolasi jadi 60 frame/10 detik: warnanya jalan
        // sekali dari merah → kuning → hijau → biru → ungu (nggak ngulang kayak
        // loop) TAPI tetep ganti ~6×/detik (tanpa interpolasi cuma 2×/detik,
        // keliatan diam).
        const os   = require('os');
        const path = require('path');
        const fs   = require('fs');
        const tmpIn  = path.join(os.tmpdir(), `attp_in_${Date.now()}.gif`);
        const tmpOut = path.join(os.tmpdir(), `attp_out_${Date.now()}.webp`);
        fs.writeFileSync(tmpIn, buffer);
        const { buf: webpBuffer } = await videoKeStickerWebp(tmpIn, tmpOut, { regang: 12.5, fps: 6, halus: true });
        try { fs.unlinkSync(tmpIn); } catch {}
        try { fs.unlinkSync(tmpOut); } catch {}
        const stickerBuffer = await addStickerExif(webpBuffer, process.env.STICKER_PACK_NAME, process.env.STICKER_AUTHOR);
        await client.message.send(jid, {
          type: 'sticker',
          media: stickerBuffer,
          mimetype: 'image/webp',
        });
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`${mess.error}\n${e.message}`);
      }
      return true;
    }

    // ── fakech — Fake Channel iOS ─────────────────────────────────────────
    case 'fakech': {
      const rawArgs = args.join(' ').trim();
      if (!rawArgs) {
        await reply(`Penggunaan: ${p}fakech <nama>,<followers>\nContoh: ${p}fakech YAPARI LABS,3.621\n\n_Reply foto untuk dijadikan foto profil channel_`);
        return true;
      }

      const rawMsg     = msg.message || {};
      const msgType    = Object.keys(rawMsg)[0] || '';
      const quoted     = rawMsg?.extendedTextMessage?.contextInfo?.quotedMessage;
      const quotedType = quoted ? Object.keys(quoted)[0] : null;

      const isDirectImg = msgType === 'imageMessage';
      const isQuotedImg = quotedType === 'imageMessage';

      if (!isDirectImg && !isQuotedImg) {
        await reply(`Reply foto dengan ${p}fakech <nama>,<followers>`);
        return true;
      }

      // parse nama dan followers — split koma pertama
      const commaIdx = rawArgs.indexOf(',');
      const nama      = commaIdx !== -1 ? rawArgs.slice(0, commaIdx).trim() : rawArgs.trim();
      const followers = commaIdx !== -1 ? rawArgs.slice(commaIdx + 1).trim() : '0';

      // format waktu otomatis HH.MM
      const now  = new Date();
      const time = `${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')}`;

      try {
        await react(mess.reactLoading);
        const axios   = require('axios');
        const FormData = require('form-data');

        // download buffer foto
        let imgBuffer;
        if (isDirectImg) {
          const content = rawMsg.imageMessage;
          const fixed   = Object.assign({}, content);
          for (const f of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
            if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
          }
          imgBuffer = Buffer.from(await client.message.downloadBytes({ imageMessage: fixed }));
        } else {
          const content = quoted.imageMessage;
          const fixed   = Object.assign({}, content);
          for (const f of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
            if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
          }
          imgBuffer = Buffer.from(await client.message.downloadBytes({ imageMessage: fixed }));
        }

        // upload foto → dapat URL publik
        const form = new FormData();
        form.append('file', imgBuffer, { filename: `fakech_${Date.now()}.jpg`, contentType: 'image/jpeg' });
        const uploadRes = await axios.post(`${process.env.BASE_API}api/tools/upload`, form, {
          headers: { ...form.getHeaders(), 'X-API-Key': process.env.KEY_API },
          timeout: 20000,
        });
        const imageUrl = uploadRes.data?.results?.file_url;
        if (!imageUrl) throw new Error('Upload foto gagal');

        // GET fake-channel-ios
        const res = await axios.get(`${process.env.BASE_API}api/maker/fake-channel-ios`, {
          params: { name: nama, followers, time, image: imageUrl },
          headers: { 'X-API-Key': process.env.KEY_API },
          responseType: 'arraybuffer',
          timeout: 30000,
        });
        const resultBuffer  = Buffer.from(res.data);
        const jpegThumbnail = await genThumbnail(resultBuffer, 'image/png');
        await client.message.send(jid, {
          type: 'image',
          media: resultBuffer,
          mimetype: 'image/png',
          caption: '',
          ...(jpegThumbnail ? { jpegThumbnail } : {}),
        });
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`${mess.error}\n${e.message}`);
      }
      return true;
    }

    // ── fakecall — Fake Call Android ─────────────────────────────────────
    case 'fakecall': {
      const rawArgs = args.join(' ').trim();
      if (!rawArgs) {
        await reply(`Penggunaan: ${p}fakecall <nama>,<durasi>\nContoh: ${p}fakecall Sayangku,01:32:04\n\n_Reply foto untuk dijadikan foto profil_`);
        return true;
      }

      const rawMsg2     = msg.message || {};
      const msgType2    = Object.keys(rawMsg2)[0] || '';
      const quoted2     = rawMsg2?.extendedTextMessage?.contextInfo?.quotedMessage;
      const quotedType2 = quoted2 ? Object.keys(quoted2)[0] : null;

      const isDirectImg2 = msgType2 === 'imageMessage';
      const isQuotedImg2 = quotedType2 === 'imageMessage';

      if (!isDirectImg2 && !isQuotedImg2) {
        await reply(`Reply foto dengan ${p}fakecall <nama>,<durasi>`);
        return true;
      }

      const commaIdx2  = rawArgs.indexOf(',');
      const nama2      = commaIdx2 !== -1 ? rawArgs.slice(0, commaIdx2).trim() : rawArgs.trim();
      const duration   = commaIdx2 !== -1 ? rawArgs.slice(commaIdx2 + 1).trim() : '00:00:00';

      try {
        await react(mess.reactLoading);
        const axios    = require('axios');
        const FormData = require('form-data');

        // download buffer foto
        let imgBuffer;
        if (isDirectImg2) {
          const content = rawMsg2.imageMessage;
          const fixed   = Object.assign({}, content);
          for (const f of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
            if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
          }
          imgBuffer = Buffer.from(await client.message.downloadBytes({ imageMessage: fixed }));
        } else {
          const content = quoted2.imageMessage;
          const fixed   = Object.assign({}, content);
          for (const f of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
            if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
          }
          imgBuffer = Buffer.from(await client.message.downloadBytes({ imageMessage: fixed }));
        }

        // upload foto → dapat URL publik
        const form2 = new FormData();
        form2.append('file', imgBuffer, { filename: `fakecall_${Date.now()}.jpg`, contentType: 'image/jpeg' });
        const uploadRes2 = await axios.post(`${process.env.BASE_API}api/tools/upload`, form2, {
          headers: { ...form2.getHeaders(), 'X-API-Key': process.env.KEY_API },
          timeout: 20000,
        });
        const imageUrl2 = uploadRes2.data?.results?.file_url;
        if (!imageUrl2) throw new Error('Upload foto gagal');

        // GET fakecallandro
        const res2 = await axios.get(`${process.env.BASE_API}api/maker/fakecallandro`, {
          params: { name: nama2, duration, image: imageUrl2 },
          headers: { 'X-API-Key': process.env.KEY_API },
          responseType: 'arraybuffer',
          timeout: 30000,
        });
        const resultBuffer2  = Buffer.from(res2.data);
        const jpegThumbnail2 = await genThumbnail(resultBuffer2, 'image/png');
        await client.message.send(jid, {
          type: 'image',
          media: resultBuffer2,
          mimetype: 'image/png',
          caption: '',
          ...(jpegThumbnail2 ? { jpegThumbnail: jpegThumbnail2 } : {}),
        });
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`${mess.error}\n${e.message}`);
      }
      return true;
    }

    // ── fakecallip — Fake Call iPhone ────────────────────────────────────
    case 'fakecallip': {
      const rawArgs = args.join(' ').trim();
      if (!rawArgs) {
        await reply(`Penggunaan: ${p}fakecallip <nama>,<durasi>\nContoh: ${p}fakecallip my heart,01:00:39\n\n_Reply foto untuk dijadikan foto profil_`);
        return true;
      }

      const rawMsg3     = msg.message || {};
      const msgType3    = Object.keys(rawMsg3)[0] || '';
      const quoted3     = rawMsg3?.extendedTextMessage?.contextInfo?.quotedMessage;
      const quotedType3 = quoted3 ? Object.keys(quoted3)[0] : null;

      const isDirectImg3 = msgType3 === 'imageMessage';
      const isQuotedImg3 = quotedType3 === 'imageMessage';

      if (!isDirectImg3 && !isQuotedImg3) {
        await reply(`Reply foto dengan ${p}fakecallip <nama>,<durasi>`);
        return true;
      }

      const commaIdx3 = rawArgs.indexOf(',');
      const nama3     = commaIdx3 !== -1 ? rawArgs.slice(0, commaIdx3).trim() : rawArgs.trim();
      const duration3 = commaIdx3 !== -1 ? rawArgs.slice(commaIdx3 + 1).trim() : '00:00:00';

      try {
        await react(mess.reactLoading);
        const axios    = require('axios');
        const FormData = require('form-data');

        let imgBuffer;
        if (isDirectImg3) {
          const content = rawMsg3.imageMessage;
          const fixed   = Object.assign({}, content);
          for (const f of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
            if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
          }
          imgBuffer = Buffer.from(await client.message.downloadBytes({ imageMessage: fixed }));
        } else {
          const content = quoted3.imageMessage;
          const fixed   = Object.assign({}, content);
          for (const f of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
            if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
          }
          imgBuffer = Buffer.from(await client.message.downloadBytes({ imageMessage: fixed }));
        }

        const form3 = new FormData();
        form3.append('file', imgBuffer, { filename: `fakecallip_${Date.now()}.jpg`, contentType: 'image/jpeg' });
        const uploadRes3 = await axios.post(`${process.env.BASE_API}api/tools/upload`, form3, {
          headers: { ...form3.getHeaders(), 'X-API-Key': process.env.KEY_API },
          timeout: 20000,
        });
        const imageUrl3 = uploadRes3.data?.results?.file_url;
        if (!imageUrl3) throw new Error('Upload foto gagal');

        const res3 = await axios.get(`${process.env.BASE_API}api/maker/fakecalliphone`, {
          params: { name: nama3, duration: duration3, image: imageUrl3 },
          headers: { 'X-API-Key': process.env.KEY_API },
          responseType: 'arraybuffer',
          timeout: 30000,
        });
        const resultBuffer3  = Buffer.from(res3.data);
        const jpegThumbnail3 = await genThumbnail(resultBuffer3, 'image/png');
        await client.message.send(jid, {
          type: 'image',
          media: resultBuffer3,
          mimetype: 'image/png',
          caption: '',
          ...(jpegThumbnail3 ? { jpegThumbnail: jpegThumbnail3 } : {}),
        });
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`${mess.error}\n${e.message}`);
      }
      return true;
    }

    // ── fakedana — Fake Dana balance ─────────────────────────────────────
    case 'fakedana': {
      const amount = args.join(' ').trim();
      if (!amount) { await reply(`Penggunaan: ${p}fakedana <nominal>\nContoh: ${p}fakedana 1.000.000`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/maker/fakedana`, {
          params: { amount },
          headers: { 'X-API-Key': process.env.KEY_API },
          responseType: 'arraybuffer',
          timeout: 30000,
        });
        const resultBuffer  = Buffer.from(res.data);
        const jpegThumbnail = await genThumbnail(resultBuffer, 'image/png');
        await client.message.send(jid, {
          type: 'image',
          media: resultBuffer,
          mimetype: 'image/png',
          caption: '',
          ...(jpegThumbnail ? { jpegThumbnail } : {}),
        });
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`${mess.error}\n${e.message}`);
      }
      return true;
    }

    // ── fakeovo — Fake OVO balance ────────────────────────────────────────
    case 'fakeovo': {
      const amount = args.join(' ').trim();
      if (!amount) { await reply(`Penggunaan: ${p}fakeovo <nominal>\nContoh: ${p}fakeovo 5000000`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/maker/fakeovo`, {
          params: { amount },
          headers: { 'X-API-Key': process.env.KEY_API },
          responseType: 'arraybuffer',
          timeout: 30000,
        });
        const resultBuffer  = Buffer.from(res.data);
        const jpegThumbnail = await genThumbnail(resultBuffer, 'image/png');
        await client.message.send(jid, {
          type: 'image',
          media: resultBuffer,
          mimetype: 'image/png',
          caption: '',
          ...(jpegThumbnail ? { jpegThumbnail } : {}),
        });
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`${mess.error}\n${e.message}`);
      }
      return true;
    }

    // ── fakegcios — Fake GC iOS ───────────────────────────────────────────
    case 'fakegcios': {
      const rawArgs = args.join(' ').trim();
      if (!rawArgs) {
        await reply(`Penggunaan: ${p}fakegcios <nama>,<members>\nContoh: ${p}fakegcios YAPARI LABS,128\n\n_Reply foto untuk dijadikan foto grup_`);
        return true;
      }

      const rawMsgGc     = msg.message || {};
      const msgTypeGc    = Object.keys(rawMsgGc)[0] || '';
      const quotedGc     = rawMsgGc?.extendedTextMessage?.contextInfo?.quotedMessage;
      const quotedTypeGc = quotedGc ? Object.keys(quotedGc)[0] : null;
      const isDirectGc   = msgTypeGc === 'imageMessage';
      const isQuotedGc   = quotedTypeGc === 'imageMessage';

      if (!isDirectGc && !isQuotedGc) {
        await reply(`Reply foto dengan ${p}fakegcios <nama>,<members>`);
        return true;
      }

      const commaIdxGc = rawArgs.indexOf(',');
      const namaGc     = commaIdxGc !== -1 ? rawArgs.slice(0, commaIdxGc).trim() : rawArgs.trim();
      const membersGc  = commaIdxGc !== -1 ? rawArgs.slice(commaIdxGc + 1).trim() : '0';

      try {
        await react(mess.reactLoading);
        const axios    = require('axios');
        const FormData = require('form-data');

        let imgBuffer;
        if (isDirectGc) {
          const content = rawMsgGc.imageMessage;
          const fixed   = Object.assign({}, content);
          for (const f of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
            if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
          }
          imgBuffer = Buffer.from(await client.message.downloadBytes({ imageMessage: fixed }));
        } else {
          const content = quotedGc.imageMessage;
          const fixed   = Object.assign({}, content);
          for (const f of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
            if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
          }
          imgBuffer = Buffer.from(await client.message.downloadBytes({ imageMessage: fixed }));
        }

        const formGc = new FormData();
        formGc.append('file', imgBuffer, { filename: `fakegcios_${Date.now()}.jpg`, contentType: 'image/jpeg' });
        const uploadResGc = await axios.post(`${process.env.BASE_API}api/tools/upload`, formGc, {
          headers: { ...formGc.getHeaders(), 'X-API-Key': process.env.KEY_API },
          timeout: 20000,
        });
        const imageUrlGc = uploadResGc.data?.results?.file_url;
        if (!imageUrlGc) throw new Error('Upload foto gagal');

        const resGc = await axios.get(`${process.env.BASE_API}api/maker/fakegcios`, {
          params: { name: namaGc, members: membersGc, image: imageUrlGc },
          headers: { 'X-API-Key': process.env.KEY_API },
          responseType: 'arraybuffer',
          timeout: 30000,
        });
        const resultBufferGc  = Buffer.from(resGc.data);
        const jpegThumbnailGc = await genThumbnail(resultBufferGc, 'image/png');
        await client.message.send(jid, {
          type: 'image',
          media: resultBufferGc,
          mimetype: 'image/png',
          caption: '',
          ...(jpegThumbnailGc ? { jpegThumbnail: jpegThumbnailGc } : {}),
        });
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`${mess.error}\n${e.message}`);
      }
      return true;
    }

    // ── fakepptele — Fake Telegram Profile ───────────────────────────────
    case 'fakepptele': {
      const rawArgs = args.join(' ').trim();
      if (!rawArgs) {
        await reply(`Penggunaan: ${p}fakepptele <nama>,<username>,<bio>\nContoh: ${p}fakepptele YAPARI LABS,yapari,Official YaPari REST API\n\n_Reply foto untuk dijadikan foto profil_\n_Nomor HP otomatis dari nomor WA kamu_`);
        return true;
      }

      const rawMsgTele     = msg.message || {};
      const msgTypeTele    = Object.keys(rawMsgTele)[0] || '';
      const quotedTele     = rawMsgTele?.extendedTextMessage?.contextInfo?.quotedMessage;
      const quotedTypeTele = quotedTele ? Object.keys(quotedTele)[0] : null;
      const isDirectTele   = msgTypeTele === 'imageMessage';
      const isQuotedTele   = quotedTypeTele === 'imageMessage';

      if (!isDirectTele && !isQuotedTele) {
        await reply(`Reply foto dengan ${p}fakepptele <nama>,<username>,<bio>`);
        return true;
      }

      // parse nama,username,bio — split koma
      const partsTele = rawArgs.split(',').map(s => s.trim());
      const namaTele    = partsTele[0] || 'Unknown';
      const usernameTele = partsTele[1] || 'unknown';
      const bioTele     = partsTele.slice(2).join(',').trim() || '-';

      // nomor HP dari JID pengirim — format +62 812-3456-7890
      const senderNum = (msg.key?.remoteJid || jid).replace('@s.whatsapp.net', '').replace('@g.us', '');
      const phoneTele = '+' + senderNum.replace(/(\d{2})(\d{3})(\d{4})(\d+)/, '$1 $2-$3-$4');

      try {
        await react(mess.reactLoading);
        const axios    = require('axios');
        const FormData = require('form-data');

        let imgBuffer;
        if (isDirectTele) {
          const content = rawMsgTele.imageMessage;
          const fixed   = Object.assign({}, content);
          for (const f of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
            if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
          }
          imgBuffer = Buffer.from(await client.message.downloadBytes({ imageMessage: fixed }));
        } else {
          const content = quotedTele.imageMessage;
          const fixed   = Object.assign({}, content);
          for (const f of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
            if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
          }
          imgBuffer = Buffer.from(await client.message.downloadBytes({ imageMessage: fixed }));
        }

        const formTele = new FormData();
        formTele.append('file', imgBuffer, { filename: `fakepptele_${Date.now()}.jpg`, contentType: 'image/jpeg' });
        const uploadResTele = await axios.post(`${process.env.BASE_API}api/tools/upload`, formTele, {
          headers: { ...formTele.getHeaders(), 'X-API-Key': process.env.KEY_API },
          timeout: 20000,
        });
        const imageUrlTele = uploadResTele.data?.results?.file_url;
        if (!imageUrlTele) throw new Error('Upload foto gagal');

        const resTele = await axios.get(`${process.env.BASE_API}api/maker/fakepptele`, {
          params: { name: namaTele, phone: phoneTele, bio: bioTele, username: usernameTele, image: imageUrlTele },
          headers: { 'X-API-Key': process.env.KEY_API },
          responseType: 'arraybuffer',
          timeout: 30000,
        });
        const resultBufferTele  = Buffer.from(resTele.data);
        const jpegThumbnailTele = await genThumbnail(resultBufferTele, 'image/png');
        await client.message.send(jid, {
          type: 'image',
          media: resultBufferTele,
          mimetype: 'image/png',
          caption: '',
          ...(jpegThumbnailTele ? { jpegThumbnail: jpegThumbnailTele } : {}),
        });
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`${mess.error}\n${e.message}`);
      }
      return true;
    }

    // ── igqc — Fake Instagram Quote Chat ─────────────────────────────────
    case 'igqc': {
      const text = args.join(' ').trim();
      if (!text) {
        await reply(`Penggunaan: ${p}igqc <teks>\nContoh: ${p}igqc Ini tuh namanya pap dari my mbg yh\n\n_Reply foto opsional — foto kepake sebagai foto profil di kartu_`);
        return true;
      }

      // format waktu otomatis — singkatan hari Indonesia + jam.menit
      const hariId = ['MIN', 'SEN', 'SEL', 'RAB', 'KAM', 'JUM', 'SAB'];
      const nowIg  = new Date();
      const timeIg = `${hariId[nowIg.getDay()]} ${String(nowIg.getHours()).padStart(2, '0')}.${String(nowIg.getMinutes()).padStart(2, '0')}`;

      try {
        await react(mess.reactLoading);
        const axios    = require('axios');
        const FormData = require('form-data');

        // foto OPSIONAL: kalau ada direct image / reply image, upload & kirim param image
        const rawMsgIg     = msg.message || {};
        const msgTypeIg    = Object.keys(rawMsgIg)[0] || '';
        const quotedIg     = rawMsgIg?.extendedTextMessage?.contextInfo?.quotedMessage;
        const quotedTypeIg = quotedIg ? Object.keys(quotedIg)[0] : null;
        const isDirectIg   = msgTypeIg === 'imageMessage';
        const isQuotedIg   = quotedTypeIg === 'imageMessage';

        let imageUrlIg = null;
        if (isDirectIg || isQuotedIg) {
          const content = isDirectIg ? rawMsgIg.imageMessage : quotedIg.imageMessage;
          const fixed   = Object.assign({}, content);
          for (const f of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
            if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
          }
          const imgBuffer = Buffer.from(await client.message.downloadBytes({ imageMessage: fixed }));
          const formIg = new FormData();
          formIg.append('file', imgBuffer, { filename: `igqc_${Date.now()}.jpg`, contentType: 'image/jpeg' });
          const uploadResIg = await axios.post(`${process.env.BASE_API}api/tools/upload`, formIg, {
            headers: { ...formIg.getHeaders(), 'X-API-Key': process.env.KEY_API },
            timeout: 20000,
          });
          imageUrlIg = uploadResIg.data?.results?.file_url || null;
        }

        const paramsIg = { text, time: timeIg };
        if (imageUrlIg) paramsIg.image = imageUrlIg;

        const resIg = await axios.get(`${process.env.BASE_API}api/maker/igqc`, {
          params: paramsIg,
          headers: { 'X-API-Key': process.env.KEY_API },
          responseType: 'arraybuffer',
          timeout: 30000,
        });
        const resultBufferIg  = Buffer.from(resIg.data);
        const jpegThumbnailIg = await genThumbnail(resultBufferIg, 'image/png');
        await client.message.send(jid, {
          type: 'image',
          media: resultBufferIg,
          mimetype: 'image/png',
          caption: '',
          ...(jpegThumbnailIg ? { jpegThumbnail: jpegThumbnailIg } : {}),
        });
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`${mess.error}\n${e.message}`);
      }
      return true;
    }

    // ── igstoryimg — Fake Instagram Story Image ──────────────────────────
    case 'igstoryimg': {
      const rawArgs = args.join(' ').trim();
      if (!rawArgs) {
        await reply(`Penggunaan: ${p}igstoryimg <nama>,<username>\nContoh: ${p}igstoryimg YaPari,yapari.labs\n\n_Reply foto untuk dijadikan foto story & profil_`);
        return true;
      }

      const rawMsgIs     = msg.message || {};
      const msgTypeIs    = Object.keys(rawMsgIs)[0] || '';
      const quotedIs     = rawMsgIs?.extendedTextMessage?.contextInfo?.quotedMessage;
      const quotedTypeIs = quotedIs ? Object.keys(quotedIs)[0] : null;
      const isDirectIs   = msgTypeIs === 'imageMessage';
      const isQuotedIs   = quotedTypeIs === 'imageMessage';

      if (!isDirectIs && !isQuotedIs) {
        await reply(`Reply foto dengan ${p}igstoryimg <nama>,<username>`);
        return true;
      }

      const commaIdxIs = rawArgs.indexOf(',');
      const namaIs     = commaIdxIs !== -1 ? rawArgs.slice(0, commaIdxIs).trim() : rawArgs.trim();
      const usernameIs = commaIdxIs !== -1 ? rawArgs.slice(commaIdxIs + 1).trim() : namaIs.toLowerCase();

      try {
        await react(mess.reactLoading);
        const axios    = require('axios');
        const FormData = require('form-data');

        let imgBuffer;
        if (isDirectIs) {
          const content = rawMsgIs.imageMessage;
          const fixed   = Object.assign({}, content);
          for (const f of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
            if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
          }
          imgBuffer = Buffer.from(await client.message.downloadBytes({ imageMessage: fixed }));
        } else {
          const content = quotedIs.imageMessage;
          const fixed   = Object.assign({}, content);
          for (const f of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
            if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
          }
          imgBuffer = Buffer.from(await client.message.downloadBytes({ imageMessage: fixed }));
        }

        const formIs = new FormData();
        formIs.append('file', imgBuffer, { filename: `igstory_${Date.now()}.jpg`, contentType: 'image/jpeg' });
        const uploadResIs = await axios.post(`${process.env.BASE_API}api/tools/upload`, formIs, {
          headers: { ...formIs.getHeaders(), 'X-API-Key': process.env.KEY_API },
          timeout: 20000,
        });
        const imageUrlIs = uploadResIs.data?.results?.file_url;
        if (!imageUrlIs) throw new Error('Upload foto gagal');

        // pp: coba ambil dari WhatsApp, fallback ke foto yang di-reply
        let ppUrl = imageUrlIs;
        try {
          const senderJid = msg.key?.participant || msg.key?.remoteJid || jid;
          ppUrl = await client.profile.getProfilePicture(senderJid, 'image') || imageUrlIs;
        } catch { /* fallback ke foto reply */ }

        const resIs = await axios.get(`${process.env.BASE_API}api/maker/igstoryimg`, {
          params: { name: namaIs, username: usernameIs, photo: imageUrlIs, pp: ppUrl },
          headers: { 'X-API-Key': process.env.KEY_API },
          responseType: 'arraybuffer',
          timeout: 30000,
        });
        const resultBufferIs  = Buffer.from(resIs.data);
        const jpegThumbnailIs = await genThumbnail(resultBufferIs, 'image/png');
        await client.message.send(jid, {
          type: 'image',
          media: resultBufferIs,
          mimetype: 'image/png',
          caption: '',
          ...(jpegThumbnailIs ? { jpegThumbnail: jpegThumbnailIs } : {}),
        });
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`${mess.error}\n${e.message}`);
      }
      return true;
    }

    // ── iqc — Fake iMessage Quote Chat ───────────────────────────────────
    case 'iqc': {
      const text = args.join(' ').trim();
      if (!text) {
        await reply(`Penggunaan: ${p}iqc <teks>\nContoh: ${p}iqc Earth without art is just "eh"\n\n_Reply foto (opsional) untuk dijadikan foto profil_`);
        return true;
      }

      const rawMsgIqc     = msg.message || {};
      const msgTypeIqc    = Object.keys(rawMsgIqc)[0] || '';
      const quotedIqc     = rawMsgIqc?.extendedTextMessage?.contextInfo?.quotedMessage;
      const quotedTypeIqc = quotedIqc ? Object.keys(quotedIqc)[0] : null;
      const isDirectIqc   = msgTypeIqc === 'imageMessage';
      const isQuotedIqc   = quotedTypeIqc === 'imageMessage';

      const nowIqc  = new Date();
      const timeIqc = `${String(nowIqc.getHours()).padStart(2, '0')}.${String(nowIqc.getMinutes()).padStart(2, '0')}`;

      try {
        await react(mess.reactLoading);
        const axios    = require('axios');
        const FormData = require('form-data');

        // foto opsional — kalau ada upload, kalau tidak param image tidak dikirim
        let imageUrlIqc = null;
        if (isDirectIqc || isQuotedIqc) {
          let imgBuffer;
          if (isDirectIqc) {
            const content = rawMsgIqc.imageMessage;
            const fixed   = Object.assign({}, content);
            for (const f of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
              if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
            }
            imgBuffer = Buffer.from(await client.message.downloadBytes({ imageMessage: fixed }));
          } else {
            const content = quotedIqc.imageMessage;
            const fixed   = Object.assign({}, content);
            for (const f of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
              if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
            }
            imgBuffer = Buffer.from(await client.message.downloadBytes({ imageMessage: fixed }));
          }
          const formIqc = new FormData();
          formIqc.append('file', imgBuffer, { filename: `iqc_${Date.now()}.jpg`, contentType: 'image/jpeg' });
          const uploadResIqc = await axios.post(`${process.env.BASE_API}api/tools/upload`, formIqc, {
            headers: { ...formIqc.getHeaders(), 'X-API-Key': process.env.KEY_API },
            timeout: 20000,
          });
          imageUrlIqc = uploadResIqc.data?.results?.file_url || null;
        }

        const paramsIqc = { text, time: timeIqc };
        if (imageUrlIqc) paramsIqc.image = imageUrlIqc;

        const resIqc = await axios.get(`${process.env.BASE_API}api/maker/iqc`, {
          params: paramsIqc,
          headers: { 'X-API-Key': process.env.KEY_API },
          responseType: 'arraybuffer',
          timeout: 30000,
        });
        const resultBufferIqc  = Buffer.from(resIqc.data);
        const jpegThumbnailIqc = await genThumbnail(resultBufferIqc, 'image/png');
        await client.message.send(jid, {
          type: 'image',
          media: resultBufferIqc,
          mimetype: 'image/png',
          caption: '',
          ...(jpegThumbnailIqc ? { jpegThumbnail: jpegThumbnailIqc } : {}),
        });
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`${mess.error}\n${e.message}`);
      }
      return true;
    }

    // ── ttqc — TikTok-style Quote Card ───────────────────────────────────
    case 'ttqc': {
      const textTtqc = args.join(' ').trim();
      if (!textTtqc) {
        await reply(`Penggunaan: ${p}ttqc <teks>\nContoh: ${p}ttqc Just friend kok cemburu`);
        return true;
      }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');

        const senderJidTtqc  = msg.key?.participant || msg.key?.remoteJid || jid;
        const usernameTtqc   = ctx.pushName || sender.split('@')[0] || 'User';

        // pp opsional dari profile WA sender
        let ppUrlTtqc = null;
        try {
          const ppRawTtqc = await client.profile.getProfilePicture(senderJidTtqc, 'image');
          ppUrlTtqc = (ppRawTtqc && typeof ppRawTtqc === 'object') ? (ppRawTtqc.url || null) : (ppRawTtqc || null);
        } catch { /* pp opsional */ }

        const paramsTtqc = { username: usernameTtqc, text: textTtqc };
        if (ppUrlTtqc) paramsTtqc.pp = ppUrlTtqc;

        const resTtqc = await axios.get(`${process.env.BASE_API}api/maker/ttqc`, {
          params: paramsTtqc,
          headers: { 'X-API-Key': process.env.KEY_API },
          responseType: 'arraybuffer',
          timeout: 30000,
        });
        const bufTtqc       = Buffer.from(resTtqc.data);
        const thumbTtqc     = await genThumbnail(bufTtqc, 'image/png');
        await client.message.send(jid, {
          type: 'image',
          media: bufTtqc,
          mimetype: 'image/png',
          caption: '',
          ...(thumbTtqc ? { jpegThumbnail: thumbTtqc } : {}),
        });
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`${mess.error}\n${e.message}`);
      }
      return true;
    }

    // ── dafont — Search Font di DaFont ───────────────────────────────────
    case 'dafont': {
      const queryFont = args.join(' ').trim();
      if (!queryFont) {
        await reply(`Penggunaan: ${p}dafont <nama font>\nContoh: ${p}dafont roboto`);
        return true;
      }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/dafont`, {
          params: { action: 'search', query: queryFont },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 15000,
        });
        const results = res.data?.results;
        if (!results || results.length === 0) {
          await react(mess.reactError);
          await reply(`Tidak ditemukan font untuk: *${queryFont}*`);
          return true;
        }
        // Kirim preview image font pertama + daftar hasil
        const first = results[0];
        let text = `🔤 *Hasil Pencarian Font: ${queryFont}*\n\n`;
        results.slice(0, 5).forEach((f, i) => {
          text += `*${i + 1}. ${f.title}*\n`;
          text += `👤 Author: ${f.author || '-'}\n`;
          text += `🏷️ Theme: ${f.theme || '-'}\n`;
          text += `⬇️ Downloads: ${Number(f.totalDownloads).toLocaleString('id-ID')}\n`;
          text += `🔗 ${f.link}\n\n`;
        });
        text += `_Menampilkan ${Math.min(results.length, 5)} dari ${results.length} hasil_`;

        // Kirim preview image font pertama
        if (first.previewImage) {
          try {
            const imgRes = await axios.get(first.previewImage, { responseType: 'arraybuffer', timeout: 10000 });
            const imgBuf = Buffer.from(imgRes.data);
            const thumb  = await genThumbnail(imgBuf, 'image/png');
            await client.message.send(jid, {
              type: 'image',
              media: imgBuf,
              mimetype: 'image/png',
              caption: text,
              ...(thumb ? { jpegThumbnail: thumb } : {}),
            });
          } catch {
            // fallback tanpa gambar
            await reply(text);
          }
        } else {
          await reply(text);
        }
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`${mess.error}\n${e.message}`);
      }
      return true;
    }

    // ── dafontdl — Download Font dari DaFont ─────────────────────────────
    case 'dafontdl': {
      const queryDl = args.join(' ').trim();
      if (!queryDl) {
        await reply(`Penggunaan:\n• ${p}dafontdl <nama font>\n• ${p}dafontdl <url dafont.com>\n\nContoh:\n• ${p}dafontdl roboto\n• ${p}dafontdl https://www.dafont.com/roboto.font`);
        return true;
      }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');

        // Deteksi apakah input URL dafont atau nama font
        const isDafontUrl = /^https?:\/\/(www\.)?dafont\.com\/.+\.font/.test(queryDl);
        let fontUrl;

        if (isDafontUrl) {
          // Langsung pakai URL yang diberikan
          fontUrl = queryDl;
        } else {
          // Search dulu untuk dapat link font
          const searchRes = await axios.get(`${process.env.BASE_API}api/search/dafont`, {
            params: { action: 'search', query: queryDl },
            headers: { 'X-API-Key': process.env.KEY_API },
            timeout: 15000,
          });
          const searchResults = searchRes.data?.results;
          if (!searchResults || searchResults.length === 0) {
            await react(mess.reactError);
            await reply(`Tidak ditemukan font untuk: *${queryDl}*`);
            return true;
          }
          fontUrl = searchResults[0].link;
        }

        // Hit download endpoint
        const dlRes = await axios.get(`${process.env.BASE_API}api/search/dafont`, {
          params: { action: 'download', url: fontUrl },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 15000,
        });
        const dlData = dlRes.data?.results;
        if (!dlData || !dlData.downloadLinks || dlData.downloadLinks.length === 0) {
          await react(mess.reactError);
          await reply(`Link download untuk *${topFont.title}* tidak tersedia.`);
          return true;
        }

        const dlLink = dlData.downloadLinks[0];
        const info   = dlData.info || {};
        const files  = Array.isArray(info.files) ? info.files : [];

        // caption info font
        let caption = `🔤 *${dlData.title}*\n`;
        if (dlData.author)  caption += `👤 Author: ${dlData.author}\n`;
        if (info.licence)   caption += `📄 Lisensi: ${info.licence}\n`;
        if (info.downloads) caption += `⬇️ ${info.downloads}\n`;
        if (files.length)   caption += `📁 Files: ${files.length} file`;

        // Step 3: download file zip
        const zipRes = await axios.get(dlLink.url, {
          responseType: 'arraybuffer',
          timeout: 60000,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        const zipBuf      = Buffer.from(zipRes.data);
        const zipFilename = `${dlData.title.replace(/\s+/g, '_')}.zip`;

        await client.message.send(jid, {
          type: 'document',
          media: zipBuf,
          mimetype: 'application/zip',
          fileName: zipFilename,
          caption,
        });
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`${mess.error}\n${e.message}`);
      }
      return true;
    }

    // ── artinama — Arti Nama ─────────────────────────────────────────────
    case 'artinama': {
      const namaArti = args.join(' ').trim();
      if (!namaArti) { await reply(`Penggunaan: ${p}artinama <nama>\nContoh: ${p}artinama budi`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/arti-nama`, {
          params: { nama: namaArti }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = res.data?.results;
        if (!d) throw new Error('Nama tidak ditemukan');
        let text = `👤 *Arti Nama: ${d.nama || namaArti}*\n\n`;
        if (d.arti) text += `📖 ${d.arti}\n`;
        if (d.asal) text += `🌍 Asal: ${d.asal}\n`;
        if (d.karakter) text += `✨ Karakter: ${d.karakter}\n`;
        if (typeof d === 'string') text += d;
        if (typeof d === 'object' && !d.arti) text += JSON.stringify(d, null, 2);
        await reply(text);
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── bandinghp — Banding 2 HP ──────────────────────────────────────────
    case 'bandinghp':
    case 'comparehp': {
      const bhArgs = args.join(' ');
      if (!bhArgs.includes('vs') && !bhArgs.includes('>')) {
        await reply(`Penggunaan: ${p}bandinghp <hp1> vs <hp2>\nContoh: ${p}bandinghp oppo reno16 vs samsung a56`);
        return true;
      }
      const sep = bhArgs.includes(' vs ') ? ' vs ' : '>';
      const [hp1, hp2] = bhArgs.split(sep).map(s => s.trim());
      if (!hp1 || !hp2) { await reply(`Masukkan 2 nama HP yang valid.`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/banding-hp`, {
          params: { hp1, hp2 }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 20000,
        });
        const d = res.data?.results;
        if (!d) throw new Error('Data tidak ditemukan');
        let text = `📱 *Perbandingan HP*\n\n`;
        text += `*${hp1.toUpperCase()}* vs *${hp2.toUpperCase()}*\n\n`;
        if (Array.isArray(d)) {
          d.forEach(row => { text += `• ${row}\n`; });
        } else if (typeof d === 'object') {
          for (const [k, v] of Object.entries(d)) { text += `*${k}:* ${v}\n`; }
        }
        if (text.length > 4000) text = text.slice(0, 4000) + '\n_...terpotong_';
        await reply(text);
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── wilayah — Cari Wilayah dari Kode Pos ─────────────────────────────
    case 'wilayah':
    case 'cariwilayah': {
      const kpWilayah = args[0]?.trim();
      if (!kpWilayah) { await reply(`Penggunaan: ${p}wilayah <kode pos>\nContoh: ${p}wilayah 53263`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/cari-wilayah`, {
          params: { kodepos: kpWilayah }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = res.data?.results;
        if (!d) throw new Error('Kode pos tidak ditemukan');
        let text = `📮 *Wilayah Kode Pos: ${kpWilayah}*\n\n`;
        if (Array.isArray(d)) {
          d.forEach(r => { text += `🏘️ ${r.kelurahan}, ${r.kecamatan}, ${r.kota}, ${r.provinsi}\n`; });
        } else if (typeof d === 'object') {
          for (const [k, v] of Object.entries(d)) { text += `*${k}:* ${v}\n`; }
        }
        await reply(text);
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── imei — Cek IMEI HP ────────────────────────────────────────────────
    case 'imei':
    case 'cekimei': {
      const imeiNum = args[0]?.trim();
      if (!imeiNum) { await reply(`Penggunaan: ${p}imei <nomor imei>\nContoh: ${p}imei 356554448894580`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/check-imei`, {
          params: { imei: imeiNum }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = res.data?.results;
        if (!d) throw new Error('IMEI tidak valid');
        let text = `📱 *Cek IMEI: ${imeiNum}*\n\n`;
        if (typeof d === 'object') {
          for (const [k, v] of Object.entries(d)) { if (v) text += `*${k}:* ${v}\n`; }
        } else { text += d; }
        await reply(text);
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── gempa — Info Gempa Bumi ───────────────────────────────────────────
    case 'gempa': {
      const gempaType = args[0]?.trim() || 'terkini';
      const validTypes = ['terkini', 'dirasakan', 'terbesar'];
      if (args[0] && !validTypes.includes(gempaType)) {
        await reply(`Penggunaan: ${p}gempa [type]\nType tersedia: terkini, dirasakan, terbesar\nContoh: ${p}gempa terbesar`);
        return true;
      }
      const typeGempa = validTypes.includes(gempaType) ? gempaType : 'terkini';
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/gempa`, {
          params: { type: typeGempa }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = res.data?.results;
        if (!d) throw new Error('Data gempa tidak tersedia');
        // response: { type, gempa: {...} } atau { type, gempa: [{...}] }
        const gempaData = d.gempa;
        if (!gempaData) throw new Error('Data gempa tidak tersedia');
        const typeLabel = typeGempa.charAt(0).toUpperCase() + typeGempa.slice(1);
        const formatGempa = (g) => {
          let t = '';
          t += `📅 *Tanggal:* ${g.tanggal || '-'} ${g.jam || ''}\n`;
          t += `📍 *Wilayah:* ${g.wilayah || g.lokasi || '-'}\n`;
          t += `💥 *Magnitudo:* M${g.magnitude || g.mag || '-'}\n`;
          t += `🌊 *Kedalaman:* ${g.kedalaman || '-'}\n`;
          if (g.lintang) t += `🧭 *Koordinat:* ${g.lintang}, ${g.bujur || ''}\n`;
          if (g.dirasakan) t += `📡 *Dirasakan:* ${g.dirasakan}\n`;
          if (g.potensi) t += `⚠️ *Potensi:* ${g.potensi}\n`;
          return t;
        };
        if (Array.isArray(gempaData)) {
          let text = `🌏 *Info Gempa ${typeLabel}*\n\n`;
          gempaData.slice(0, 5).forEach((g, i) => {
            text += `*${i+1}.* M${g.magnitude || g.mag || '-'} — ${g.wilayah || g.lokasi || '-'}\n`;
            text += `   ⏰ ${g.tanggal || '-'} ${g.jam || ''} | 🌊 ${g.kedalaman || '-'}\n`;
            if (g.potensi) text += `   ⚠️ ${g.potensi}\n`;
            text += '\n';
          });
          await reply(text.trim());
        } else {
          const caption = `🌏 *Info Gempa ${typeLabel}*\n\n${formatGempa(gempaData)}`;
          if (gempaData.shakemap) {
            try {
              const imgRes = await axios.get(gempaData.shakemap, { responseType: 'arraybuffer', timeout: 15000 });
              await client.message.send(jid, { type: 'image', media: Buffer.from(imgRes.data), mimetype: 'image/jpeg', caption: caption.trim() });
            } catch { await reply(caption.trim()); }
          } else {
            await reply(caption.trim());
          }
        }
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── cuaca — Info Cuaca ───────────────────────────────────────────────
    case 'cuaca':
    case 'weather': {
      const kotaCuaca = args.join(' ').trim();
      if (!kotaCuaca) { await reply(`Penggunaan: ${p}cuaca <kota>\nContoh: ${p}cuaca Jakarta`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const { data } = await axios.get(`${process.env.BASE_API}api/tools/cuaca`, {
          params: { kota: kotaCuaca }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = data?.result;
        if (!d) throw new Error('Data cuaca tidak tersedia');
        const loc = d.location || {};
        const c = d.cuaca || {};
        const w = d.angin || {};
        const a = d.atmosfer || {};
        const s = d.astronomi || {};
        let text = `🌤️ *Cuaca — ${loc.kota || kotaCuaca}*\n`;
        if (loc.region) text += `📍 ${loc.area_terdekat || ''}, ${loc.region}, ${loc.negara || ''}\n\n`;
        text += `☁️ *Kondisi:* ${c.kondisi || '-'}\n`;
        text += `🌡️ *Suhu:* ${c.suhu || '-'} (terasa ${c.terasa || '-'})\n`;
        text += `📊 *Min/Max:* ${c.suhu_min || '-'} / ${c.suhu_max || '-'}\n`;
        text += `💧 *Kelembaban:* ${c.kelembaban || '-'}\n`;
        text += `💨 *Angin:* ${w.kecepatan || '-'} arah ${w.arah || '-'}\n`;
        text += `👁️ *Jarak Pandang:* ${a.jarak_pandang || '-'}\n`;
        text += `☀️ *UV Index:* ${a.uv_index || '-'}\n`;
        text += `🌅 *Matahari Terbit:* ${s.matahari_terbit || '-'}\n`;
        text += `🌇 *Matahari Terbenam:* ${s.matahari_terbenam || '-'}\n`;
        text += `🌙 *Fase Bulan:* ${s.fase_bulan || '-'}`;
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── accuweather — Prakiraan Cuaca AccuWeather ────────────────────────
    case 'accuweather':
    case 'prakiraan': {
      const kotaAccu = args.join(' ').trim();
      if (!kotaAccu) { await reply(`Penggunaan: ${p}accuweather <kota>\nContoh: ${p}accuweather Bandung`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const { data } = await axios.get(`${process.env.BASE_API}api/tools/accu-weather`, {
          params: { city: kotaAccu }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = data?.results;
        if (!d) throw new Error('Data tidak tersedia');
        const loc = d.location || {};
        const forecasts = d.forecastData?.DailyForecasts || [];
        let text = `🌤️ *Prakiraan Cuaca — ${loc.name || kotaAccu}, ${loc.country || ''}*\n`;
        if (d.forecastData?.Text) text += `_${d.forecastData.Text}_\n\n`;
        forecasts.slice(0, 5).forEach(f => {
          text += `📅 *${f.Date}*\n`;
          text += `   🌡️ ${f.Temperature?.Min}° — ${f.Temperature?.Max}°\n`;
          text += `   ☀️ Siang: ${f.Day?.IconPhrase || '-'}\n`;
          text += `   🌙 Malam: ${f.Night?.IconPhrase || '-'}\n`;
          if (f.Day?.HasPrecipitation) text += `   🌧️ Hujan: ${f.Day?.PrecipitationProbability}%\n`;
          text += '\n';
        });
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── checkwa — Cek Nomor WhatsApp ─────────────────────────────────────
    case 'checkwa':
    case 'cekwa': {
      const nomorWa = args[0]?.replace(/\D/g, '');
      if (!nomorWa) { await reply(`Penggunaan: ${p}checkwa <nomor>\nContoh: ${p}checkwa 6281234567890`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const { data } = await axios.get(`${process.env.BASE_API}api/tools/checkwa`, {
          params: { number: nomorWa }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = data?.results;
        if (!d) throw new Error('Gagal mengecek nomor');
        let text = `📱 *Cek Nomor WhatsApp*\n\n`;
        text += `📞 *Nomor:* ${d.number}\n`;
        text += `✅ *Terdaftar:* ${d.registered ? 'Ya' : 'Tidak'}\n`;
        text += `🚫 *Banned:* ${d.banned ? 'Ya' : 'Tidak'}\n`;
        text += `📋 *Status:* ${d.message || d.status || '-'}`;
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── bypass — Bypass Link ──────────────────────────────────────────────
    case 'bypass': {
      const bypassUrl = args[0];
      if (!bypassUrl) { await reply(`Penggunaan: ${p}bypass <url>\nContoh: ${p}bypass https://linkvertise.com/...`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const { data } = await axios.get(`${process.env.BASE_API}api/tools/bypass`, {
          params: { url: bypassUrl }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 30000,
        });
        const d = data?.results;
        if (!d?.result) throw new Error('Gagal bypass link');
        await reply(`🔓 *Bypass Link*\n\n🔗 *Input:* ${d.input}\n✅ *Result:* ${d.result}`);
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── bypasssfl — Bypass Shrinkfly ─────────────────────────────────────
    case 'bypasssfl':
    case 'bpsfl': {
      const sflUrl = args[0];
      if (!sflUrl) { await reply(`Penggunaan: ${p}bypasssfl <url>`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const { data } = await axios.get(`${process.env.BASE_API}api/tools/bypass-sfl`, {
          params: { url: sflUrl }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 30000,
        });
        const d = data?.results;
        if (!d?.final_url) throw new Error('Gagal bypass link');
        await reply(`🔓 *Bypass SFL*\n\n✅ *Result:* ${d.final_url}`);
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── translate — Terjemahkan Teks ─────────────────────────────────────
    case 'translate':
    case 'terjemah':
    case 'tr': {
      // Usage: .translate <lang> <text> atau .translate <text> (default to id)
      const langCodes = ['id','en','ja','ko','zh','ar','fr','de','es','pt','ru','th','vi','ms','tr'];
      let trLang = 'id', trText = '';
      if (args.length > 1 && langCodes.includes(args[0].toLowerCase())) {
        trLang = args[0].toLowerCase();
        trText = args.slice(1).join(' ').trim();
      } else {
        trText = args.join(' ').trim();
      }
      if (!trText) { await reply(`Penggunaan: ${p}translate [lang] <teks>\nContoh: ${p}translate en Halo dunia\nBahasa: id en ja ko zh ar fr de es pt ru`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const { data } = await axios.get(`${process.env.BASE_API}api/tools/google-translate`, {
          params: { text: trText, to: trLang }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = data?.results;
        if (!d?.translated) throw new Error('Gagal menerjemahkan');
        let text = `🌐 *Terjemahan*\n\n`;
        text += `📝 *Bahasa Sumber:* ${d.source_lang || 'auto'}\n`;
        text += `🎯 *Bahasa Target:* ${d.target_lang}\n\n`;
        text += `*Original:*\n${d.original}\n\n`;
        text += `*Terjemahan:*\n${d.translated}`;
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── removebg — Hapus background gambar (Pixelcut, lewat API YaPari) ────
    case 'removebg':
    case 'rbg': {
      const media = await extractMedia(ctx, ['imageMessage']);
      if (!media) {
        await reply(`Reply gambar dengan ${p}removebg, atau kirim gambar dengan caption ${p}removebg`);
        return true;
      }
      try {
        await react(mess.reactLoading);
        // Buffer WA → URL publik dulu; endpoint-nya yang ngunduh (mode `url`).
        const imgUrl = await upload(media.buffer, namaFileAman(null, media.mime), media.mime);
        const axios  = require('axios');
        const res    = await axios.get(apiUrl('api/tools/removebg'), {
          params: { url: imgUrl }, headers: apiAuth(),
          responseType: 'arraybuffer', timeout: 60000,
        });
        const hasil = Buffer.from(res.data);
        if (!hasil.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47]))) {
          throw new Error('Balasan API bukan gambar PNG');
        }
        // Image message + mimetype image/png: baileys ngunggah byte APA ADANYA
        // (nggak re-encode), jadi alpha tetep utuh.
        await client.message.send(jid, {
          type: 'image',
          media: hasil,
          mimetype: 'image/png',
        });
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${rapikanError(e)}`); }
      return true;
    }

    // ── qrcode — Buat QR Code ─────────────────────────────────────────────
    case 'qrcode':
    case 'qr': {
      const qrText = args.join(' ').trim();
      if (!qrText) { await reply(`Penggunaan: ${p}qrcode <teks/url>\nContoh: ${p}qrcode https://google.com`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/tools/qrcode`, {
          params: { text: qrText }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000, responseType: 'arraybuffer',
        });
        await client.message.send(jid, { type: 'image', media: Buffer.from(res.data), mimetype: 'image/png', caption: `📷 *QR Code*\n_${qrText}_` });
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── decodeqr — Decode QR Code dari Gambar ────────────────────────────
    case 'decodeqr':
    case 'readqr': {
      const media = await extractMedia(ctx, ['imageMessage']);
      if (!media) {
        await reply(`Reply gambar QR Code atau kirim gambar dengan caption ${p}decodeqr.\nContoh: reply gambar lalu ketik ${p}decodeqr`);
        return true;
      }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        // Upload gambar dulu
        const FormData = require('form-data');
        const form = new FormData();
        form.append('file', media.buffer, { filename: 'qr.png', contentType: media.mime || 'image/png' });
        const upload = await axios.post(`${process.env.BASE_API}api/tools/upload`, form, {
          headers: { ...form.getHeaders(), 'X-API-Key': process.env.KEY_API }, timeout: 30000,
        });
        const imgUrl = upload.data?.results?.file_url;
        if (!imgUrl) throw new Error('Gagal upload gambar');
        const { data } = await axios.get(`${process.env.BASE_API}api/tools/decode-qr`, {
          params: { url: imgUrl }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const teks = data?.results?.teks;
        if (!teks) throw new Error('QR Code tidak terbaca');
        await reply(`📷 *Decode QR Code*\n\n📋 *Isi:*\n${teks}`);
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── ocr — Baca Teks dari Gambar ──────────────────────────────────────
    case 'ocr': {
      // Mode: reply gambar, kirim gambar+caption, atau .ocr <url gambar>
      const media = await extractMedia(ctx, ['imageMessage']);
      const urlInput = args[0];
      if (!media && !urlInput) { await reply(`Reply gambar, kirim gambar dengan caption ${p}ocr, atau kirim URL gambar.\nContoh: reply gambar lalu ketik ${p}ocr\nAtau: ${p}ocr https://example.com/gambar.jpg`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        let imgUrl = urlInput && /^https?:\/\//i.test(urlInput) ? urlInput : null;
        if (!imgUrl && media) {
          const FormData = require('form-data');
          const form = new FormData();
          form.append('file', media.buffer, { filename: 'ocr.jpg', contentType: media.mime || 'image/jpeg' });
          const upload = await axios.post(`${process.env.BASE_API}api/tools/upload`, form, {
            headers: { ...form.getHeaders(), 'X-API-Key': process.env.KEY_API }, timeout: 30000,
          });
          imgUrl = upload.data?.results?.file_url;
          if (!imgUrl) throw new Error('Gagal upload gambar');
        }
        const { data } = await axios.get(`${process.env.BASE_API}api/tools/ocr`, {
          params: { url: imgUrl }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 30000,
        });
        const teks = data?.results?.teks;
        if (!teks) throw new Error('Teks tidak terdeteksi');
        await reply(`📖 *OCR — Hasil*\n\n${teks}`);
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── upscale — Perbesar Resolusi Gambar ───────────────────────────────
    case 'upscale':
    case 'hd':
    case 'enhance': {
      const media = await extractMedia(ctx, ['imageMessage']);
      const urlInput = args[0];
      if (!media && !urlInput) { await reply(`Reply gambar, kirim gambar dengan caption ${p}upscale, atau kirim URL gambar.\nContoh: reply gambar lalu ketik ${p}upscale\nAtau: ${p}upscale https://example.com/gambar.jpg`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        let imgUrl = urlInput && /^https?:\/\//i.test(urlInput) ? urlInput : null;
        if (!imgUrl && media) {
          const FormData = require('form-data');
          const form = new FormData();
          form.append('file', media.buffer, { filename: 'img.jpg', contentType: media.mime || 'image/jpeg' });
          const upload = await axios.post(`${process.env.BASE_API}api/tools/upload`, form, {
            headers: { ...form.getHeaders(), 'X-API-Key': process.env.KEY_API }, timeout: 30000,
          });
          imgUrl = upload.data?.results?.file_url;
          if (!imgUrl) throw new Error('Gagal upload gambar');
        }
        const { data } = await axios.get(`${process.env.BASE_API}api/tools/upscale`, {
          params: { url: imgUrl }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 60000,
        });
        const resultUrl = data?.results?.url;
        if (!resultUrl) throw new Error('Gagal upscale gambar');
        const res = await axios.get(resultUrl, { responseType: 'arraybuffer', timeout: 60000 });
        const upBuf = Buffer.from(res.data);
        const thumb = await genThumbnail(upBuf, 'image/jpeg');
        await client.message.send(jid, { type: 'image', media: upBuf, mimetype: 'image/jpeg', caption: '✨ *Upscale Berhasil*', ...(thumb ? { jpegThumbnail: thumb } : {}) });
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── ssweb — Screenshot Website ───────────────────────────────────────
    case 'ssweb':
    case 'ss':
    case 'screenshot': {
      const ssRaw = args.join(' ').trim();
      if (!ssRaw) { await reply(`Penggunaan: ${p}ssweb <url>\nContoh: ${p}ssweb https://google.com`); return true; }
      // URL telanjang ("luminara.com") → tambah https:// biar API nggak balikin 400
      const ssUrl = /^https?:\/\//i.test(ssRaw) ? ssRaw : `https://${ssRaw}`;
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const { data } = await axios.get(`${process.env.BASE_API}api/tools/ssweb`, {
          params: { url: ssUrl }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 20000,
        });
        const imgUrl = data?.results?.screenshot_url;
        if (!imgUrl) throw new Error(data?.message || 'Gagal screenshot');
        const res = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 30000 });
        await client.message.send(jid, { type: 'image', media: Buffer.from(res.data), mimetype: 'image/jpeg', caption: `🌐 *Screenshot*\n${ssUrl}` });
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${rapikanError(e)}`); }
      return true;
    }

    // ── fancytext — Fancy Text Generator ─────────────────────────────────
    case 'fancytext':
    case 'fancy': {
      const fancyInput = args.join(' ').trim();
      if (!fancyInput) { await reply(`Penggunaan: ${p}fancytext <teks>\nContoh: ${p}fancytext Hello`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const { data } = await axios.get(`${process.env.BASE_API}api/tools/fancytext`, {
          params: { text: fancyInput }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = data?.results;
        if (!d?.styles?.length) throw new Error('Gagal generate');
        let text = `✨ *Fancy Text: ${fancyInput}*\n\n`;
        d.styles.forEach(s => { text += `*${s.style}:* ${s.result}\n`; });
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── harga — Harga saham / crypto / forex / logam mulia ────────────────
    // SATU command buat semua kelas aset. Yang nentuin jenisnya endpoint
    // `api/tools/harga-saham`, bukan nama command — simbolnya udah jelas
    // sendiri (.JK saham IDX, -USD crypto, =X forex, ^ indeks, XAU logam).
    // Command terpisah per kelas aset = nol manfaat, cuma nambah entri menu.
    case 'harga':
    case 'saham':
    case 'crypto':
    case 'koin':
    case 'forex':
    case 'kurs':
    case 'emas':
    case 'gold': {
      const IKON = { EQUITY: '📈', CRYPTOCURRENCY: '🪙', CURRENCY: '💱', INDEX: '📉', LOGAM_MULIA: '🥇' };
      const ikon = (j) => IKON[j] || '📊';
      // `perubahan_persen` dari API udah string ("-1.19%") — panah ngikut tandanya.
      const panah = (pc) => (pc == null ? '' : ` ${String(pc).startsWith('-') ? '🔴' : '🟢'} ${String(pc).replace('-', '')}`);
      const simbol = args.join(' ').trim().toUpperCase();
      try {
        await react(mess.reactLoading);

        // Tanpa simbol = SEMUA kelas aset sekaligus. Endpoint-nya yang default ke
        // `mode=ringkasan` kalau `symbol` kosong — bot nggak nyimpen daftar apa-apa.
        if (!simbol) {
          const { data } = await apiGet('api/tools/harga-saham', { timeout: 30000 });
          const d = data?.results;
          if (!d) throw new Error('Data harga nggak tersedia');
          const grup = [
            ['🥇 Logam Mulia', d.logam_mulia],
            ['📉 Indeks',      d.indeks],
            ['💱 Forex',       d.forex],
            ['🪙 Crypto',      d.crypto],
            ['📈 Saham',       d.saham],
          ].map(([judul, items]) => [judul, (items || []).filter(Boolean)]);
          if (!grup.some(([, items]) => items.length)) throw new Error('Lagi nggak bisa ambil harga, coba lagi bentar ya');

          let teks = `📊 *Harga Terkini*\n_${new Date().toLocaleDateString('id-ID', { dateStyle: 'long' })}_\n`;
          for (const [judul, items] of grup) {
            if (!items.length) continue;
            teks += `\n*${judul}*\n`;
            for (const it of items) teks += `${it.symbol.replace(/=X$|\.JK$/, '')} — ${it.harga_format}${panah(it.perubahan_persen)}\n`;
          }
          // Yang gagal jangan disembunyiin, tapi juga jangan bikin pesan penuh.
          const gagal = (d.gagal || []).map((x) => x.symbol.replace(/=X$|\.JK$/, ''));
          if (gagal.length) teks += `\n_${gagal.join(', ')} lagi nggak kebaca._`;
          teks += `\n\nKetik ${p}harga <simbol> buat detail — mis. ${p}harga BBCA.JK`;
          await reply(teks.trim());
          await react(mess.reactSuccess);
          return true;
        }

        const ambil = (s) => apiGet('api/tools/harga-saham', { params: { symbol: s }, timeout: 20000 });
        let res;
        try {
          res = await ambil(simbol);
        } catch (e) {
          // `bbca` → BBCA.JK: orang IDX nggak pernah ngetik `.JK`, tapi `AAPL`
          // polos harus tetep AAPL. Jadi coba apa adanya DULU, tempel `.JK`
          // cuma kalau ditolak (400 = simbol nggak ada) — bukan nembak `.JK`
          // di awal, yang bikin saham US nggak pernah ketemu.
          if (e.response?.status === 400 && /^[A-Z]{2,5}$/.test(simbol)) res = await ambil(`${simbol}.JK`);
          else throw e;
        }
        const d = res.data?.results;
        if (!d) throw new Error(`Simbol ${simbol} nggak ketemu`);

        let text = `${ikon(d.jenis)} *${d.nama || d.symbol}*\n`;
        text += `🔖 ${d.symbol}${d.bursa ? ` · ${d.bursa}` : ''}\n\n`;
        text += `💰 *${d.harga_format || d.harga}*\n`;
        if (d.perubahan_persen != null) text += `${panah(d.perubahan_persen).trim()} dari penutupan sebelumnya\n`;
        if (d.harga_idr) text += `🇮🇩 *Rp${d.harga_idr.toLocaleString('id-ID')}* (per troy ounce)\n`;
        const waktu = d.waktu || d.updated_at;
        if (waktu) {
          text += `\n🕐 ${new Date(waktu).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })} ${d.zona_waktu || ''}`.trimEnd();
        }
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        // Pesan 400 dari API udah kalimat manusia ("Simbol 'X' tidak ditemukan…")
        // — pakai itu, jangan ditimpa "Request failed with status code 400".
        await reply(`${mess.error}\n${e.response?.data?.message || e.message}`);
      }
      return true;
    }

    // ── nikinfo — Info NIK KTP ────────────────────────────────────────────
    case 'nik':
    case 'nikinfo': {
      const nikInput = args[0];
      if (!nikInput || nikInput.length < 16) { await reply(`Penggunaan: ${p}nik <16 digit NIK>\nContoh: ${p}nik 3273011001900001`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const { data } = await axios.get(`${process.env.BASE_API}api/tools/nik-info`, {
          params: { nik: nikInput }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = data?.results;
        if (!d) throw new Error('NIK tidak valid');
        const lok = d.lokasi || {};
        let text = `🪪 *Info NIK*\n\n`;
        text += `🔢 *NIK:* ${d.nik}\n`;
        text += `👤 *Jenis Kelamin:* ${d.jenis_kelamin || '-'}\n`;
        text += `📅 *Tgl Lahir:* ${d.tanggal_lahir || '-'}\n`;
        text += `🎂 *Usia:* ${d.usia || '-'}\n`;
        text += `🎉 *Ulang Tahun:* ${d.ulang_tahun_berikutnya || '-'}\n`;
        text += `♈ *Zodiak:* ${d.zodiak || '-'}\n`;
        if (d.weton_jawa) text += `🗓️ *Weton:* ${d.weton_jawa}\n`;
        if (lok.provinsi?.nama) text += `🗺️ *Provinsi:* ${lok.provinsi.nama}\n`;
        if (lok.kota_kabupaten?.nama) text += `🏙️ *Kota/Kab:* ${lok.kota_kabupaten.nama}\n`;
        if (lok.kecamatan?.nama) text += `📍 *Kecamatan:* ${lok.kecamatan.nama}\n`;
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── iplookup — IP/Domain Lookup ───────────────────────────────────────
    case 'iplookup':
    case 'ipcek': {
      const ipInput = args[0];
      if (!ipInput) { await reply(`Penggunaan: ${p}iplookup <ip/domain>\nContoh: ${p}iplookup 8.8.8.8`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const { data } = await axios.get(`${process.env.BASE_API}api/tools/ip-lookup`, {
          params: { query: ipInput }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = data?.results?.geo || data?.results;
        if (!d) throw new Error('Gagal lookup IP');
        let text = `🌐 *IP Lookup*\n\n`;
        text += `🔍 *Query:* ${ipInput}\n`;
        text += `🌍 *IP:* ${d.ip || '-'}\n`;
        if (d.hostname) text += `🏠 *Hostname:* ${d.hostname}\n`;
        if (d.city) text += `🏙️ *Kota:* ${d.city}\n`;
        if (d.region) text += `🗺️ *Region:* ${d.region}\n`;
        if (d.countryName) text += `🚩 *Negara:* ${d.countryName} (${d.country || ''})\n`;
        if (d.org) text += `🏢 *Org:* ${d.org}\n`;
        if (d.timezone) text += `⏰ *Timezone:* ${d.timezone}\n`;
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── reverseip — Reverse IP Lookup ─────────────────────────────────────
    case 'reverseip': {
      const ripInput = args[0];
      if (!ripInput) { await reply(`Penggunaan: ${p}reverseip <ip/domain>\nContoh: ${p}reverseip 8.8.8.8`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const { data } = await axios.get(`${process.env.BASE_API}api/tools/reverse-ip`, {
          params: { ip: ripInput }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = data?.results;
        if (!d) throw new Error('Gagal reverse IP');
        const domains = d.domains || [];
        let text = `🔄 *Reverse IP*\n\n`;
        text += `🌐 *IP:* ${d.ip || ripInput}\n`;
        text += `📊 *Total Domain:* ${d.total || domains.length}\n\n`;
        if (domains.length) {
          text += `*Domain (${Math.min(10, domains.length)} dari ${d.total}):*\n`;
          domains.slice(0, 10).forEach(dm => { text += `• ${dm}\n`; });
        }
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── httpheaders — HTTP Headers Checker ───────────────────────────────
    case 'httpheaders':
    case 'headers': {
      const headerUrl = args[0];
      if (!headerUrl) { await reply(`Penggunaan: ${p}httpheaders <url>\nContoh: ${p}httpheaders https://google.com`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const { data } = await axios.get(`${process.env.BASE_API}api/tools/http-headers`, {
          params: { url: headerUrl }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = data?.results;
        if (!d) throw new Error('Gagal mengecek headers');
        const headers = d.headers || {};
        const sec = d.security || {};
        let text = `🔍 *HTTP Headers*\n\n`;
        text += `🌐 *URL:* ${d.url || headerUrl}\n`;
        text += `📡 *Status:* ${d.status || '-'}\n\n`;
        const importantHeaders = ['content-type','server','x-powered-by','cache-control','content-encoding'];
        importantHeaders.forEach(k => { if (headers[k]) text += `*${k}:* ${headers[k]}\n`; });
        if (Object.keys(sec).length) {
          text += `\n🔒 *Security Headers:*\n`;
          Object.entries(sec).slice(0, 5).forEach(([k, v]) => { text += `• ${k}: ${v}\n`; });
        }
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── nationalday — Hari Peringatan Nasional ────────────────────────────
    case 'nationalday':
    case 'hariini': {
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const { data } = await axios.get(`${process.env.BASE_API}api/tools/national-day`, {
          params: { sort: 'asc' }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = data?.results;
        if (!d) throw new Error('Data tidak tersedia');
        const holidays = d.holidays || [];
        let text = `🗓️ *National Day — ${d.scraped_date || ''}*\n`;
        text += `_Total: ${d.total_holidays} peringatan_\n\n`;
        holidays.slice(0, 8).forEach((h, i) => {
          text += `*${i+1}. ${h.name}*\n`;
          if (h.date) text += `   📅 ${h.date}\n`;
          text += '\n';
        });
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── shalat — Jadwal Shalat ────────────────────────────────────────────
    case 'shalat':
    case 'jadwalshalat': {
      const kotaShalat = args.join(' ').trim();
      if (!kotaShalat) { await reply(`Penggunaan: ${p}shalat <kota>\nContoh: ${p}shalat Jakarta`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const { data } = await axios.get(`${process.env.BASE_API}api/tools/jadwal-shalat`, {
          params: { kota: kotaShalat }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = data?.results;
        if (!d) throw new Error('Data tidak tersedia');
        const j = d.jadwal || {};
        const tgl = d.tanggal || {};
        let text = `🕌 *Jadwal Shalat — ${d.lokasi?.kota || kotaShalat}*\n`;
        text += `📅 ${tgl.masehi || ''} / ${tgl.hijriyah || ''}\n\n`;
        text += `🌙 *Imsak:* ${j.imsak || '-'}\n`;
        text += `🌅 *Subuh:* ${j.subuh || '-'}\n`;
        text += `☀️ *Terbit:* ${j.terbit || '-'}\n`;
        text += `🌤️ *Dhuha:* ${j.dhuha || '-'}\n`;
        text += `🕛 *Dzuhur:* ${j.dzuhur || '-'}\n`;
        text += `🌥️ *Ashar:* ${j.ashar || '-'}\n`;
        text += `🌆 *Maghrib:* ${j.maghrib || '-'}\n`;
        text += `🌃 *Isya:* ${j.isya || '-'}`;
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── kalendershalat — Kalender Shalat Bulanan ──────────────────────────
    case 'kalendershalat':
    case 'kshalat': {
      // Usage: .kalendershalat <kota> [bulan] [tahun]
      const [kotaKS, bulanKS, tahunKS] = args;
      if (!kotaKS) { await reply(`Penggunaan: ${p}kalendershalat <kota> [bulan] [tahun]\nContoh: ${p}kalendershalat Jakarta 9 2026`); return true; }
      const now = new Date();
      const bln = bulanKS || String(now.getMonth() + 1);
      const thn = tahunKS || String(now.getFullYear());
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const { data } = await axios.get(`${process.env.BASE_API}api/tools/kalender-shalat`, {
          params: { kota: kotaKS, bulan: bln, tahun: thn }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = data?.results;
        if (!d) throw new Error('Data tidak tersedia');
        const kalender = d.kalender || [];
        let text = `🗓️ *Kalender Shalat — ${d.lokasi}*\n`;
        text += `📅 ${d.bulan} ${d.tahun} (${d.total_hari} hari)\n\n`;
        // Tampil 7 hari pertama
        kalender.slice(0, 7).forEach(k => {
          text += `*${k.tanggal} (${k.hari})*\n`;
          const w = k.waktu || {};
          text += `   Subuh: ${w.subuh || '-'} | Dzuhur: ${w.dzuhur || '-'} | Ashar: ${w.ashar || '-'} | Maghrib: ${w.maghrib || '-'} | Isya: ${w.isya || '-'}\n\n`;
        });
        if (kalender.length > 7) text += `_...dan ${kalender.length - 7} hari lainnya_`;
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── konversitanggal — Konversi Tanggal Masehi-Hijriyah ───────────────
    case 'konversitanggal':
    case 'tanggal': {
      const tglInput = args[0];
      if (!tglInput) { await reply(`Penggunaan: ${p}konversitanggal <DD-MM-YYYY>\nContoh: ${p}konversitanggal 17-08-1945`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const { data } = await axios.get(`${process.env.BASE_API}api/tools/konversi-tanggal`, {
          params: { tanggal: tglInput }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = data?.results;
        if (!d) throw new Error('Gagal konversi tanggal');
        const m = d.masehi || {};
        const h = d.hijriyah || {};
        let text = `📅 *Konversi Tanggal*\n\n`;
        text += `🗓️ *Masehi:*\n`;
        text += `   ${m.format_panjang || m.tanggal || '-'}\n\n`;
        text += `☪️ *Hijriyah:*\n`;
        text += `   ${h.format_panjang || h.tanggal || '-'}\n`;
        if (h.hari) text += `   Hari: ${h.hari}`;
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── drakor — Search Drama Korea ───────────────────────────────────────
    case 'drakor': {
      const qDrakor = args.join(' ').trim();
      if (!qDrakor) { await reply(`Penggunaan: ${p}drakor <judul>\nContoh: ${p}drakor queen of tears`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/drakor`, {
          params: { action: 'search', query: qDrakor }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const results = res.data?.results;
        if (!results || (Array.isArray(results) && !results.length)) throw new Error('Drama tidak ditemukan');
        let text = `🎬 *Hasil Pencarian Drakor: ${qDrakor}*\n\n`;
        const list = Array.isArray(results) ? results : [results];
        list.slice(0, 5).forEach((d, i) => {
          text += `*${i+1}. ${d.judul || d.title || d.nama || '-'}*\n`;
          if (d.tahun || d.year) text += `📅 ${d.tahun || d.year}\n`;
          if (d.genre) text += `🏷️ ${d.genre}\n`;
          if (d.rating) text += `⭐ ${d.rating}\n`;
          if (d.url || d.link) text += `🔗 ${d.url || d.link}\n`;
          text += '\n';
        });
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── duolingo — Cari User Duolingo ─────────────────────────────────────
    case 'duolingo': {
      const qDuo = args.join(' ').trim();
      if (!qDuo) { await reply(`Penggunaan: ${p}duolingo <username>\nContoh: ${p}duolingo duolingo`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/duolingo`, {
          params: { query: qDuo }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = res.data?.results;
        if (!d) throw new Error('User tidak ditemukan');
        const users = d.users || (Array.isArray(d) ? d : []);
        if (!users.length) throw new Error('User tidak ditemukan');
        let text = `🦜 *Duolingo: ${qDuo}*\n_Total: ${d.totalResults || users.length} hasil_\n\n`;
        users.slice(0, 5).forEach((u, i) => {
          text += `*${i+1}. ${u.name || u.username}* (@${u.username})\n`;
          text += `   ⚡ XP: ${(u.totalXP || 0).toLocaleString()}\n`;
          if (u.learningLanguage) text += `   🌐 Belajar: ${u.learningLanguage}\n`;
          if (u.hasSubscription) text += `   ✨ Premium\n`;
          text += '\n';
        });
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── npm — Info Package NPM ────────────────────────────────────────────
    case 'npm': {
      const pkgNpm = args.join(' ').trim();
      if (!pkgNpm) { await reply(`Penggunaan: ${p}npm <package>\nContoh: ${p}npm express`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/npm`, {
          params: { package: pkgNpm }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = res.data?.results;
        if (!d) throw new Error('Package tidak ditemukan');
        let text = `📦 *NPM: ${d.name || pkgNpm}*\n\n`;
        if (d.description) text += `📝 ${d.description}\n`;
        if (d.version)     text += `🔖 Versi: ${d.version}\n`;
        if (d.author)      text += `👤 Author: ${typeof d.author === 'object' ? d.author.name : d.author}\n`;
        if (d.license)     text += `📄 Lisensi: ${d.license}\n`;
        if (d.downloads)   text += `⬇️ Downloads: ${d.downloads}\n`;
        if (d.homepage)    text += `🏠 ${d.homepage}\n`;
        if (d.repository)  text += `💻 ${typeof d.repository === 'object' ? d.repository.url : d.repository}\n`;
        if (d.keywords?.length) text += `🏷️ ${d.keywords.slice(0,8).join(', ')}\n`;
        await reply(text);
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── resep — Cari Resep Masakan ────────────────────────────────────────
    case 'resep': {
      const qResep = args.join(' ').trim();
      if (!qResep) { await reply(`Penggunaan: ${p}resep <nama masakan>\nContoh: ${p}resep nasi goreng`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/resep`, {
          params: { q: qResep }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = res.data?.results;
        if (!d) throw new Error('Resep tidak ditemukan');
        const item = Array.isArray(d) ? d[0] : d;
        let text = `🍳 *${item.judul || item.title || qResep}*\n\n`;
        if (item.porsi)    text += `🍽️ Porsi: ${item.porsi}\n`;
        if (item.waktu)    text += `⏱️ Waktu: ${item.waktu}\n`;
        if (item.bahan?.length) {
          text += `\n🧂 *Bahan:*\n`;
          item.bahan.forEach(b => { text += `• ${b}\n`; });
        }
        if (item.langkah?.length) {
          text += `\n📋 *Langkah:*\n`;
          item.langkah.slice(0, 8).forEach((l, i) => { text += `${i+1}. ${l}\n`; });
          if (item.langkah.length > 8) text += `_...dan ${item.langkah.length - 8} langkah lagi_\n`;
        }
        if (item.url) text += `\n🔗 ${item.url}`;
        if (text.length > 4000) text = text.slice(0, 4000) + '\n_...terpotong_';
        await reply(text);
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── steam — Cari Game di Steam ────────────────────────────────────────
    case 'steam': {
      const qSteam = args.join(' ').trim();
      if (!qSteam) { await reply(`Penggunaan: ${p}steam <nama game>\nContoh: ${p}steam counter strike`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/steam`, {
          params: { query: qSteam }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = res.data?.results;
        if (!d) throw new Error('Game tidak ditemukan');
        const item = Array.isArray(d) ? d[0] : d;
        let text = `🎮 *${item.nama || item.name || item.title || qSteam}*\n\n`;
        if (item.harga || item.price)  text += `💰 Harga: ${item.harga || item.price}\n`;
        if (item.developer)            text += `👨‍💻 Developer: ${item.developer}\n`;
        if (item.publisher)            text += `🏢 Publisher: ${item.publisher}\n`;
        if (item.tanggal || item.release_date) text += `📅 Rilis: ${item.tanggal || item.release_date}\n`;
        if (item.genre)                text += `🏷️ Genre: ${item.genre}\n`;
        if (item.rating)               text += `⭐ Rating: ${item.rating}\n`;
        if (item.deskripsi || item.description) text += `\n📝 ${(item.deskripsi || item.description).slice(0, 300)}...\n`;
        if (item.url || item.link)     text += `\n🔗 ${item.url || item.link}`;
        if (Array.isArray(d) && d.length > 1) {
          text += `\n\n_Lainnya: ${d.slice(1,4).map(g => g.nama || g.name || g.title).join(', ')}_`;
        }
        await reply(text);
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── play — Putar lagu: yt-dlp lokal (URL terikat IP server sendiri) ──
    // Akar fix ETIMEDOUT: URL googlevideo IP-locked ke pembuatnya. Kalau URL dibuat
    // di VPS A, VPS B nggak bisa download (ditolak instan). yt-dlp lokal → URL pakai IP sendiri.
    case 'play': {
      const qPlay = args.join(' ').trim();
      if (!qPlay) { await reply(`Penggunaan: ${p}play <judul lagu>\nContoh: ${p}play dalinda`); return true; }
      try {
        await react(mess.reactLoading);
        const lagu = await ambilAudioLagu(qPlay);
        if (!lagu.ok) throw new Error(lagu.alasan);
        await react(mess.reactSuccess);
        await client.message.send(jid, { type: 'audio', media: lagu.buf, mimetype: lagu.mime });
        await reply(`🎵 *${lagu.title || qPlay}*${lagu.dur ? ` [${lagu.dur}]` : ''}\n👤 ${lagu.artist || '-'}`);
      } catch (e) {
        await react(mess.reactError);
        const msgErr = rapikanError(e);
        await reply(`❌ Gagal memutar lagu.\n${msgErr ? `_${msgErr}_` : 'Coba lagi nanti atau periksa link.'}`);
      }
      return true;
    }

    // ── lk21trending — LK21 Trending ──────────────────────────────────────
    case 'lk21':
    case 'lk21trending': {
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/lk21-trending`, {
          headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = res.data?.results;
        if (!d) throw new Error('Data tidak tersedia');
        const list = Array.isArray(d) ? d : (d.movies || d.films || []);
        let text = `🎬 *Film Trending LK21*\n\n`;
        list.slice(0, 8).forEach((f, i) => {
          text += `*${i+1}. ${f.judul || f.title || '-'}*\n`;
          if (f.tahun || f.year) text += `📅 ${f.tahun || f.year}\n`;
          if (f.rating)          text += `⭐ ${f.rating}\n`;
          if (f.url || f.link)   text += `🔗 ${f.url || f.link}\n`;
          text += '\n';
        });
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── lk21search — Cari Film di LK21 ───────────────────────────────────
    case 'lk21search':
    case 'filmsearch': {
      const qLk21 = args.join(' ').trim();
      if (!qLk21) { await reply(`Penggunaan: ${p}lk21search <judul>\nContoh: ${p}lk21search avengers`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/lk21-search`, {
          params: { q: qLk21 }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = res.data?.results;
        if (!d) throw new Error('Film tidak ditemukan');
        const list = Array.isArray(d) ? d : (d.movies || d.results || [d]);
        let text = `🎬 *Hasil Pencarian LK21: ${qLk21}*\n\n`;
        list.slice(0, 5).forEach((f, i) => {
          text += `*${i+1}. ${f.judul || f.title || '-'}*\n`;
          if (f.tahun || f.year) text += `📅 ${f.tahun || f.year}\n`;
          if (f.type)            text += `📺 ${f.type}\n`;
          if (f.url || f.link)   text += `🔗 ${f.url || f.link}\n`;
          text += '\n';
        });
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── mcpedl — Cari Addon MCPE ──────────────────────────────────────────
    case 'mcpedl': {
      const qMcpe = args.join(' ').trim();
      if (!qMcpe) { await reply(`Penggunaan: ${p}mcpedl <nama addon>\nContoh: ${p}mcpedl sword`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/mcpedl`, {
          params: { query: qMcpe }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = res.data?.results;
        if (!d) throw new Error('Addon tidak ditemukan');
        const list = Array.isArray(d) ? d : [d];
        let text = `⛏️ *Hasil MCPEDL: ${qMcpe}*\n\n`;
        list.slice(0, 5).forEach((a, i) => {
          text += `*${i+1}. ${a.judul || a.title || a.nama || '-'}*\n`;
          if (a.kategori || a.category) text += `🏷️ ${a.kategori || a.category}\n`;
          if (a.download || a.downloads) text += `⬇️ ${a.download || a.downloads}\n`;
          if (a.url || a.link)          text += `🔗 ${a.url || a.link}\n`;
          text += '\n';
        });
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── news — Berita Terkini ─────────────────────────────────────────────
    // ── berita — Berita Terkini ───────────────────────────────────────────
    case 'berita': {
      const sumberMap = {
        detik: 'Detik', cnn: 'CNN Indonesia', cnbc: 'CNBC Indonesia',
        kompas: 'Kompas', tribun: 'Tribun News', indozone: 'Indozone',
        inews: 'iNews', kontan: 'Kontan', daily: 'Daily News',
      };
      const sumberKey = args[0]?.toLowerCase().trim();
      if (!sumberKey || !sumberMap[sumberKey]) {
        const daftar = Object.entries(sumberMap).map(([k, v]) => `• ${p}berita ${k} — ${v}`).join('\n');
        await reply(`Penggunaan: ${p}berita <sumber>\n\n*Sumber tersedia:*\n${daftar}`);
        return true;
      }
      const sumberLabel = sumberMap[sumberKey];
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/news`, {
          params: { sumber: sumberKey }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = res.data?.results;
        if (!d) throw new Error('Berita tidak tersedia');
        const list = Array.isArray(d.berita) ? d.berita : (Array.isArray(d) ? d : []);
        if (!list.length) throw new Error('Tidak ada berita');
        let text = `📰 *Berita Terkini — ${sumberLabel}*\n`;
        text += `_Total: ${d.total || list.length} berita_\n\n`;
        list.slice(0, 5).forEach((n, i) => {
          text += `*${i+1}. ${n.berita || n.judul || n.title || '-'}*\n`;
          if (n.berita_diupload || n.tanggal) text += `⏰ ${n.berita_diupload || n.tanggal}\n`;
          if (n.berita_url || n.url)          text += `🔗 ${n.berita_url || n.url}\n`;
          text += '\n';
        });
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── pinterest / pin — Cari gambar Pinterest
    // SEARCH pakai nama polos (.pin/.pinterest); DOWNLOAD pakai akhiran dl (.pindl).
    case 'pinterest':
    case 'pin': {
      const qPin = args.join(' ').trim();
      if (!qPin) { await reply(`Penggunaan: ${p}pin <query>\nContoh: ${p}pin anime`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/pinterest`, {
          params: { q: qPin }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = res.data?.results;
        if (!d) throw new Error('Tidak ada hasil');
        const list = Array.isArray(d) ? d : [];
        if (!list.length) throw new Error('Tidak ada hasil');
        // Kirim gambar pertama
        const imgUrl = list[0]?.gambar || list[0]?.image || list[0]?.url || list[0];
        if (imgUrl && typeof imgUrl === 'string') {
          const imgRes = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 10000 });
          const imgBuf = Buffer.from(imgRes.data);
          const thumb  = await genThumbnail(imgBuf, 'image/jpeg');
          let caption  = `🖼️ *Pinterest: ${qPin}*\n_${list.length} hasil ditemukan_`;
          await client.message.send(jid, {
            type: 'image', media: imgBuf, mimetype: 'image/jpeg', caption,
            ...(thumb ? { jpegThumbnail: thumb } : {}),
          });
        } else {
          await reply(`🖼️ *Pinterest: ${qPin}*\n_${list.length} hasil ditemukan_`);
        }
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── tokopedia — Search Produk Tokopedia ───────────────────────────────
    case 'tokopedia':
    case 'toped': {
      const qToped = args.join(' ').trim();
      if (!qToped) { await reply(`Penggunaan: ${p}tokopedia <nama produk>\nContoh: ${p}tokopedia vivo x300`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/tokopedia`, {
          params: { q: qToped, page: '1', limit: '10' }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = res.data?.results;
        if (!d) throw new Error('Produk tidak ditemukan');
        const list = Array.isArray(d) ? d : (d.products || d.data || []);
        let text = `🛒 *Tokopedia: ${qToped}*\n\n`;
        list.slice(0, 5).forEach((p, i) => {
          text += `*${i+1}. ${p.nama || p.name || p.judul || '-'}*\n`;
          if (p.harga || p.price)    text += `💰 ${p.harga || p.price}\n`;
          if (p.toko || p.shop)      text += `🏪 ${p.toko || p.shop}\n`;
          if (p.rating)              text += `⭐ ${p.rating}\n`;
          if (p.terjual || p.sold)   text += `📦 Terjual: ${p.terjual || p.sold}\n`;
          if (p.url || p.link)       text += `🔗 ${p.url || p.link}\n`;
          text += '\n';
        });
        if (text.length > 4000) text = text.slice(0, 4000) + '\n_...terpotong_';
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── nimegami — Nimegami Home ──────────────────────────────────────────
    case 'nimegami': {
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/nimegami-home`, {
          headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = res.data?.results;
        if (!d) throw new Error('Data tidak tersedia');
        let text = `🎌 *Nimegami - Anime Terbaru*\n\n`;
        const list = Array.isArray(d) ? d : (d.anime || d.list || []);
        list.slice(0, 8).forEach((a, i) => {
          text += `*${i+1}. ${a.judul || a.title || '-'}*\n`;
          if (a.episode) text += `📺 Ep: ${a.episode}\n`;
          if (a.url || a.link) text += `🔗 ${a.url || a.link}\n`;
          text += '\n';
        });
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── nimegamis — Search Anime di Nimegami ─────────────────────────────
    case 'nimegamis':
    case 'animesearch': {
      const qNime = args.join(' ').trim();
      if (!qNime) { await reply(`Penggunaan: ${p}nimegamis <judul anime>\nContoh: ${p}nimegamis naruto`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/nimegami-search`, {
          params: { query: qNime }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = res.data?.results;
        if (!d) throw new Error('Anime tidak ditemukan');
        const list = Array.isArray(d) ? d : [d];
        let text = `🎌 *Hasil Pencarian Anime: ${qNime}*\n\n`;
        list.slice(0, 5).forEach((a, i) => {
          text += `*${i+1}. ${a.judul || a.title || '-'}*\n`;
          if (a.genre)   text += `🏷️ ${a.genre}\n`;
          if (a.status)  text += `📺 ${a.status}\n`;
          if (a.url || a.link) text += `🔗 ${a.url || a.link}\n`;
          text += '\n';
        });
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── shinigami — Search Manga di Shinigami ─────────────────────────────
    case 'shinigami': {
      const qShini = args.join(' ').trim() || 'comedy';
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/shinigami`, {
          params: { q: qShini, page: '1', limit: '10' }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = res.data?.results;
        if (!d) throw new Error('Manga tidak ditemukan');
        const list = Array.isArray(d) ? d : (d.data || d.manga || []);
        let text = `📚 *Shinigami Manga: ${qShini}*\n\n`;
        list.slice(0, 5).forEach((m, i) => {
          text += `*${i+1}. ${m.judul || m.title || '-'}*\n`;
          if (m.genre)   text += `🏷️ ${Array.isArray(m.genre) ? m.genre.join(', ') : m.genre}\n`;
          if (m.status)  text += `📺 ${m.status}\n`;
          if (m.chapter) text += `📖 Ch: ${m.chapter}\n`;
          if (m.url || m.link) text += `🔗 ${m.url || m.link}\n`;
          text += '\n';
        });
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── spotify — Cari lagu di Spotify (nama polos) ──────────────────────
    // SEARCH = nama polos (.spotify). DOWNLOAD dari LINK = akhiran dl (.spotifydl).
    // Field dari BE: name / artist / album / duration / tid (bukan judul/artis).
    case 'spotify': {
      const qSpot = args.join(' ').trim();
      if (!qSpot) { await reply(`Penggunaan: ${p}spotify <judul lagu>\nContoh: ${p}spotify alan walker faded`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        // BE-nya suka 500 sekali (scrape gagal) → coba 2x sebelum nyerah
        let list = [], errTerakhir = null;
        for (let coba = 0; coba < 2 && !list.length; coba++) {
          try {
            const res = await axios.get(`${process.env.BASE_API}api/search/spotify`, {
              params: { query: qSpot }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 25000,
            });
            const d = res.data?.results;
            list = Array.isArray(d) ? d : (d?.tracks || []);
          } catch (e) { errTerakhir = e; }
        }
        if (!list.length) throw new Error(errTerakhir?.response?.data?.message || 'Lagu tidak ditemukan');
        let text = `🎵 *Hasil Spotify: ${qSpot}*\n\n`;
        list.slice(0, 5).forEach((s, i) => {
          const nm = s.name || s.judul || s.title || '-';
          const ar = s.artist || s.artis || '';
          text += `*${i + 1}. ${nm}*\n`;
          if (ar)  text += `👤 ${ar}\n`;
          if (s.album)   text += `💿 ${s.album}\n`;
          if (s.duration || s.durasi) text += `⏱️ ${s.duration || s.durasi}\n`;
          const tid = s.tid || (s.url || s.link || '').split('/track/')[1];
          if (tid) text += `🔗 https://open.spotify.com/track/${tid}\n`;
          else if (s.url || s.link) text += `🔗 ${s.url || s.link}\n`;
          text += '\n';
        });
        text += `_Download lagu lain: ${p}spotifydl <link>_`;
        await reply(text);

        // Rekomendasi #1 langsung dikirim jadi audio (artis+judul dari Spotify)
        const top  = list[0];
        const lagu = await ambilAudioLagu(`${top.name || qSpot} ${(top.artist || '').split(',')[0]}`.trim());
        if (!lagu.ok) { await react(mess.reactError); await reply(`❌ Gagal ambil audionya.\n_${lagu.alasan || 'Coba lagi nanti.'}_`); return true; }
        await client.message.send(jid, { type: 'audio', media: lagu.buf, mimetype: lagu.mime });
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal cari di Spotify.\n_${rapikanError(e) || 'Coba lagi nanti.'}_`);
      }
      return true;
    }
    // ── spotifylyrics — Lirik dari Spotify ────────────────────────────────
    case 'spotifylyrics':
    case 'slyrics': {
      const slArgs = args.join(' ').trim();
      if (!slArgs) { await reply(`Penggunaan: ${p}spotifylyrics <judul> - <artis>\nContoh: ${p}spotifylyrics Shape of You - Ed Sheeran`); return true; }
      const hasSep = slArgs.includes(' - ');
      const slQuery = hasSep ? slArgs.split(' - ')[0].trim() : slArgs;
      const slArtist = hasSep ? slArgs.split(' - ')[1].trim() : '';
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const params = { query: slQuery };
        if (slArtist) params.artist = slArtist;
        const res = await axios.get(`${process.env.BASE_API}api/search/spotify-lyrics`, {
          params, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = res.data?.results;
        if (!d) throw new Error('Lirik tidak ditemukan');
        let text = `🎵 *${d.judul || d.title || slQuery}*\n`;
        if (d.artis || d.artist) text += `👤 ${d.artis || d.artist}\n`;
        text += '\n';
        if (d.lirik || d.lyrics) text += d.lirik || d.lyrics;
        if (text.length > 4000) text = text.slice(0, 4000) + '\n_...terpotong_';
        await reply(text);
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── tiktokphoto — Search Foto TikTok ─────────────────────────────────
    case 'tiktokphoto':
    case 'ttkphoto': {
      const qTtk = args.join(' ').trim();
      if (!qTtk) { await reply(`Penggunaan: ${p}tiktokphoto <query>\nContoh: ${p}tiktokphoto Bmw M4`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/tiktok-photo`, {
          params: { q: qTtk, count: '6' }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = res.data?.results;
        if (!d) throw new Error('Tidak ada hasil');
        const list = Array.isArray(d) ? d : [d];
        const item = list[0];
        const imgList = Array.isArray(item?.images) ? item.images : [];
        const imgs = imgList.length > 0
          ? imgList
          : [item?.gambar || item?.image || item?.cover || item?.url].filter(Boolean);
        if (imgs.length === 0) throw new Error('Tidak ada gambar');
        let caption = `🎵 *TikTok Photo: ${qTtk}*\n`;
        if (item?.title || item?.judul || item?.desc) caption += `📝 ${item.title || item.judul || item.desc}\n`;
        if (item?.author) caption += `👤 ${item.author}\n`;

        // Download semua paralel dulu — kirim beruntun-cepat biar WA grouping jadi album (swipe)
        const bufs = [];
        for (let i = 0; i < imgs.length; i++) {
          try {
            const imgRes = await axios.get(imgs[i], { responseType: 'arraybuffer', timeout: 10000 });
            bufs.push(Buffer.from(imgRes.data));
          } catch { /* skip gambar gagal */ }
        }
        if (bufs.length === 0) { await reply(caption); await react(mess.reactError); return true; }

        for (let i = 0; i < bufs.length; i++) {
          try {
            const thumb = await genThumbnail(bufs[i], 'image/jpeg');
            const cap = i === 0 ? caption : `Image ${i + 1} / ${bufs.length}`;
            await client.message.send(jid, {
              type: 'image', media: bufs[i], mimetype: 'image/jpeg', caption: cap,
              ...(thumb ? { jpegThumbnail: thumb } : {}),
            });
          } catch (e) {
            if (i === 0) await reply(caption);
          }
        }
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── searchcode — Cari Kode di GitHub ──────────────────────────────────
    case 'searchcode': {
      const scArgs = args.join(' ').trim();
      if (!scArgs) { await reply(`Penggunaan: ${p}searchcode <query> [repo]\nContoh: ${p}searchcode hello world`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const params = { q: scArgs };
        const res = await axios.get(`${process.env.BASE_API}api/search/searchcode`, {
          params, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = res.data?.results;
        if (!d) throw new Error('Tidak ada hasil');
        const list = Array.isArray(d) ? d : (d.results || [d]);
        let text = `💻 *Hasil Pencarian Kode: ${scArgs}*\n\n`;
        list.slice(0, 5).forEach((c, i) => {
          text += `*${i+1}. ${c.nama || c.name || c.filename || '-'}*\n`;
          if (c.repo || c.repository) text += `📁 ${c.repo || c.repository}\n`;
          if (c.bahasa || c.language) text += `🔤 ${c.bahasa || c.language}\n`;
          if (c.url || c.link)        text += `🔗 ${c.url || c.link}\n`;
          text += '\n';
        });
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── lirik — Cari Lirik Lagu ───────────────────────────────────────────
    case 'lirik': {
      const qLirik = args.join(' ').trim();
      if (!qLirik) {
        await reply(`Penggunaan: ${p}lirik <judul lagu>\nContoh: ${p}lirik Bawa Dia Kembali Mahalini`);
        return true;
      }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/lirik`, {
          params: { q: qLirik },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 15000,
        });
        const d = res.data?.results;
        if (!d) throw new Error('Lirik tidak ditemukan');
        let text = `🎵 *${d.judul}*\n`;
        text += `👤 ${d.artis}\n`;
        text += `🔗 ${d.url}\n\n`;
        text += d.lirik;
        // Potong jika terlalu panjang
        if (text.length > 4000) text = text.slice(0, 4000) + '\n_...terpotong_';
        await reply(text);
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`${mess.error}\n${e.message}`);
      }
      return true;
    }

    // ── genius — Search Lagu/Artis/Album di Genius ────────────────────────
    case 'genius': {
      const qGenius = args.join(' ').trim();
      if (!qGenius) {
        await reply(`Penggunaan: ${p}genius <nama lagu/artis>\nContoh: ${p}genius yoasobi`);
        return true;
      }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/genius`, {
          params: { q: qGenius },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 15000,
        });
        const sections = res.data?.results?.sections || [];
        let text = `🔍 *Hasil Pencarian Genius: ${qGenius}*\n\n`;
        let hasResult = false;
        for (const section of sections) {
          const hits = section.hits?.filter(h => h.result) || [];
          if (!hits.length) continue;
          const label = section.type === 'song' ? '🎵 Lagu' :
                        section.type === 'artist' ? '👤 Artis' :
                        section.type === 'album' ? '💿 Album' : section.type;
          text += `*${label}*\n`;
          hits.slice(0, 3).forEach(h => {
            const r = h.result;
            text += `• ${r.full_title || r.name || r.title || r.login}\n`;
            if (r.url) text += `  ${r.url}\n`;
          });
          text += '\n';
          hasResult = true;
        }
        if (!hasResult) {
          await react(mess.reactError);
          await reply(`Tidak ditemukan hasil untuk: *${qGenius}*`);
          return true;
        }
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`${mess.error}\n${e.message}`);
      }
      return true;
    }

    // ── gsmarena — Spesifikasi HP dari GSMArena ───────────────────────────
    case 'gsmarena':
    case 'spek': {
      const qHp = args.join(' ').trim();
      if (!qHp) {
        await reply(`Penggunaan: ${p}gsmarena <nama HP>\nContoh: ${p}gsmarena Samsung Galaxy S24`);
        return true;
      }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/gsmarena`, {
          params: { q: qHp },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 20000,
        });
        const d = res.data?.results;
        if (!d) throw new Error('HP tidak ditemukan');
        const spek = d.spesifikasi || {};
        let text = `📱 *${d.nama}*\n🔗 ${d.url}\n\n`;
        const fields = ['Announced','Status','OS','Chipset','CPU','GPU','Dimensions','Weight','Display','Size','Resolution','Internal','Triple','Single','Battery','Charging','WLAN','Bluetooth','NFC','USB','Price'];
        for (const f of fields) {
          if (spek[f]) text += `*${f}:* ${spek[f]}\n`;
        }
        if (text.length > 4000) text = text.slice(0, 4000) + '\n_...terpotong_';
        if (d.gambar) {
          try {
            const imgRes = await axios.get(d.gambar, { responseType: 'arraybuffer', timeout: 10000 });
            const imgBuf = Buffer.from(imgRes.data);
            const thumb  = await genThumbnail(imgBuf, 'image/jpeg');
            await client.message.send(jid, {
              type: 'image', media: imgBuf, mimetype: 'image/jpeg', caption: text,
              ...(thumb ? { jpegThumbnail: thumb } : {}),
            });
          } catch { await reply(text); }
        } else {
          await reply(text);
        }
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`${mess.error}\n${e.message}`);
      }
      return true;
    }

    // ── jarak — Jarak & Estimasi Biaya Antar Kota ────────────────────────
    case 'jarak': {
      const jarakArgs = args.join(' ').trim();
      if (!jarakArgs || !jarakArgs.includes('>')) {
        await reply(`Penggunaan: ${p}jarak <kota asal> > <kota tujuan>\nContoh: ${p}jarak Jakarta > Bandung`);
        return true;
      }
      const [fromCity, toCity] = jarakArgs.split('>').map(s => s.trim());
      if (!fromCity || !toCity) {
        await reply(`Penggunaan: ${p}jarak <kota asal> > <kota tujuan>\nContoh: ${p}jarak Jakarta > Bandung`);
        return true;
      }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/jarak`, {
          params: { from: fromCity, to: toCity },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 20000,
        });
        const d = res.data?.results;
        if (!d) throw new Error('Tidak dapat menghitung jarak');
        let text = `🗺️ *Jarak & Estimasi Perjalanan*\n\n`;
        text += `📍 Dari  : ${d.dari}\n`;
        text += `📍 Ke    : ${d.ke}\n\n`;
        text += `📏 Jarak : ${d.jarak?.km}\n`;
        text += `⏱️ Waktu : ${d.durasi?.teks}\n\n`;
        text += `💰 *Estimasi Biaya:*\n`;
        text += `⛽ BBM   : ${d.estimasi_biaya?.bbm}\n`;
        text += `🛣️ Tol   : ${d.estimasi_biaya?.tol_perkiraan}\n`;
        if (d.estimasi_biaya?.catatan) text += `\n_${d.estimasi_biaya.catatan}_`;
        await reply(text);
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`${mess.error}\n${e.message}`);
      }
      return true;
    }

    // ── kbbi — Kamus Besar Bahasa Indonesia ──────────────────────────────
    case 'kbbi': {
      const kataKbbi = args.join(' ').trim();
      if (!kataKbbi) {
        await reply(`Penggunaan: ${p}kbbi <kata>\nContoh: ${p}kbbi merdeka`);
        return true;
      }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/kbbi`, {
          params: { kata: kataKbbi },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 15000,
        });
        const d = res.data?.results;
        if (!d || !d.arti?.length) throw new Error('Kata tidak ditemukan di KBBI');
        let text = `📖 *KBBI: ${d.kata}*\n🔗 ${d.url}\n\n`;
        d.arti.forEach((a, i) => { text += `${i + 1}. ${a}\n`; });
        if (d.lainnya?.length) {
          text += `\n📝 *Contoh:*\n`;
          d.lainnya.forEach(l => { text += `• ${l}\n`; });
        }
        await reply(text);
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`${mess.error}\n${e.message}`);
      }
      return true;
    }

    // ── kodepos — Cari Kode Pos ───────────────────────────────────────────
    case 'kodepos': {
      const daerahKp = args.join(' ').trim();
      if (!daerahKp) {
        await reply(`Penggunaan: ${p}kodepos <nama daerah>\nContoh: ${p}kodepos cilacap`);
        return true;
      }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const res = await axios.get(`${process.env.BASE_API}api/search/kodepos`, {
          params: { daerah: daerahKp },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 15000,
        });
        const d = res.data?.results;
        if (!d || !d.results?.length) throw new Error('Daerah tidak ditemukan');
        let text = `📮 *Kode Pos: ${d.query}*\n`;
        text += `_Total: ${d.total} hasil_\n\n`;
        // Group by kecamatan
        const grouped = {};
        d.results.slice(0, 15).forEach(r => {
          const key = `${r.kecamatan} (${r.kode_pos})`;
          if (!grouped[key]) grouped[key] = [];
          grouped[key].push(r.kelurahan);
        });
        for (const [kec, kels] of Object.entries(grouped)) {
          text += `🏘️ *${kec}*\n`;
          kels.forEach(k => { text += `  • ${k}\n`; });
        }
        if (d.total > 15) text += `\n_...dan ${d.total - 15} hasil lainnya_`;
        await reply(text);
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`${mess.error}\n${e.message}`);
      }
      return true;
    }

    // ── kalkulator ────────────────────────────────────────────────────────
    case 'kalkulator': {
      const expr = args.join(' ').replace(/[^0-9+\-*/().\s]/g, '');
      if (!expr) { await reply(`Penggunaan: ${p}kalkulator <ekspresi>\nContoh: ${p}kalkulator 2 + 2 * 3`); return true; }
      try {
        // Safe eval using Function constructor limited to math
        // eslint-disable-next-line no-new-func
        const result = Function(`"use strict"; return (${expr})`)();
        if (typeof result !== 'number' || !isFinite(result)) throw new Error('Hasil bukan angka');
        await reply(`🧮 *Kalkulator*\n\n${expr}\n= *${result}*`);
      } catch {
        await reply('❌ Ekspresi matematika tidak valid');
      }
      return true;
    }

    // ── pick ──────────────────────────────────────────────────────────────
    case 'pick': {
      const options = args.join(' ').split('|').map(s => s.trim()).filter(Boolean);
      if (options.length < 2) {
        await reply(`Penggunaan: ${p}pick opsi1 | opsi2 | opsi3\nContoh: ${p}pick makan | tidur | main game`);
        return true;
      }
      const chosen = options[Math.floor(Math.random() * options.length)];
      await reply(`🎲 *Pick Random*\n\nPilihan: ${options.join(', ')}\n\n✅ Bot memilih: *${chosen}*`);
      return true;
    }

    // ── tourl ─────────────────────────────────────────────────────────────
    case 'tourl':
    case 'upload': {
      const rawMsg    = msg.message || {};
      const msgType   = Object.keys(rawMsg)[0] || '';
      const quoted    = rawMsg?.extendedTextMessage?.contextInfo?.quotedMessage;
      const quotedType = quoted ? Object.keys(quoted)[0] : null;

      const mediaTypes = ['imageMessage','videoMessage','audioMessage','stickerMessage','documentMessage'];
      const isDirectMedia = mediaTypes.includes(msgType);
      const isQuotedMedia = quotedType && mediaTypes.includes(quotedType);

      if (!isDirectMedia && !isQuotedMedia) {
        await reply(`Reply atau kirim media dengan ${p}tourl untuk mendapatkan URL`);
        return true;
      }

      try {
        let buffer, mime, filename;

        if (isDirectMedia) {
          const content = rawMsg[msgType];
          const fixed   = Object.assign({}, content);
          for (const f of ['mediaKey','fileSha256','fileEncSha256']) {
            if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
          }
          buffer   = Buffer.from(await client.message.downloadBytes({ [msgType]: fixed }));
          mime     = content.mimetype || 'application/octet-stream';
          filename = namaFileAman(content.fileName, mime);
        } else {
          const content = quoted[quotedType];
          const fixed   = Object.assign({}, content);
          for (const f of ['mediaKey','fileSha256','fileEncSha256']) {
            if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
          }
          buffer   = Buffer.from(await client.message.downloadBytes({ [quotedType]: fixed }));
          mime     = content.mimetype || 'application/octet-stream';
          filename = namaFileAman(content.fileName, mime);
        }

        // Cek ukuran file max 5MB
        if (buffer.length > 5 * 1024 * 1024) {
          await reply('Ukuran media tidak boleh melebihi 5MB');
          return true;
        }

        // Kirim loading dulu, ambil ID-nya untuk di-edit nanti
        await react(mess.reactLoading);
        const loadingSent = await client.message.send(jid, mess.loading);
        const loadingId   = loadingSent?.key?.id || loadingSent?.id || null;

        const { url: fileUrl, expires, size } = await uploadInfo(buffer, filename, mime);

        const typeEmoji = {
          imageMessage:    '🖼️ Gambar',
          videoMessage:    '🎬 Video',
          audioMessage:    '🎵 Audio',
          stickerMessage:  '🎭 Sticker',
          documentMessage: '📄 Dokumen',
        };
        const activeType = isDirectMedia ? msgType : quotedType;
        const mediaLabel = typeEmoji[activeType] || '📎 Media';

        // Helper: kirim hasil — edit pesan loading jika bisa, fallback ke reply biasa
        const sendResult = async (text) => {
          if (loadingId) {
            try {
              const botJid = (botData.bot_number || '').replace(/\D/g, '') + '@s.whatsapp.net';
              await client.message.send(jid, text, {
                editKey: { id: loadingId, ...(isGroup ? { participant: botJid } : {}) }
              });
              return;
            } catch { /* fallback ke reply biasa */ }
          }
          await reply(text);
        };

        const expiredText = expires || 'Tidak diketahui';
        const sizeKb = size ? `${(size / 1024).toFixed(1)} KB` : `${(buffer.length / 1024).toFixed(1)} KB`;

        await sendResult(`🔗 *URL Media*\n\n${fileUrl}\n\n📦 Ukuran: ${sizeKb}\n⏳ Expired: ${expiredText}\n🏷️ Tipe: ${mediaLabel}`);
      } catch (e) {
        await reply(`${mess.error}\n${e.message}`);
      }
      return true;
    }

    // ── tourl2 ────────────────────────────────────────────────────────────
    case 'tourl2':
    case 'upload2': {
      const rawMsg    = msg.message || {};
      const msgType   = Object.keys(rawMsg)[0] || '';
      const quoted    = rawMsg?.extendedTextMessage?.contextInfo?.quotedMessage;
      const quotedType = quoted ? Object.keys(quoted)[0] : null;

      const mediaTypes = ['imageMessage','videoMessage','audioMessage','stickerMessage','documentMessage'];
      const isDirectMedia = mediaTypes.includes(msgType);
      const isQuotedMedia = quotedType && mediaTypes.includes(quotedType);

      if (!isDirectMedia && !isQuotedMedia) {
        await reply(`Reply atau kirim media dengan ${p}tourl2 untuk mendapatkan URL (Permanen)`);
        return true;
      }

      try {
        let buffer, mime, filename;

        if (isDirectMedia) {
          const content = rawMsg[msgType];
          const fixed   = Object.assign({}, content);
          for (const f of ['mediaKey','fileSha256','fileEncSha256']) {
            if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
          }
          buffer   = Buffer.from(await client.message.downloadBytes({ [msgType]: fixed }));
          mime     = content.mimetype || 'application/octet-stream';
          filename = namaFileAman(content.fileName, mime);
        } else {
          const content = quoted[quotedType];
          const fixed   = Object.assign({}, content);
          for (const f of ['mediaKey','fileSha256','fileEncSha256']) {
            if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
          }
          buffer   = Buffer.from(await client.message.downloadBytes({ [quotedType]: fixed }));
          mime     = content.mimetype || 'application/octet-stream';
          filename = namaFileAman(content.fileName, mime);
        }

        // Cek ukuran file. nginx VPS A = client_max_body_size 100m, PHP post_max_size = 100M.
        // Cap bot 64MB biar aman di bawah keduanya.
        const MAX_TOURL2_MB = 64;
        if (buffer.length > MAX_TOURL2_MB * 1024 * 1024) {
          await reply(`Ukuran media tidak boleh melebihi ${MAX_TOURL2_MB}MB (file ini ${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);
          return true;
        }

        await react(mess.reactLoading);
        const loadingSent = await client.message.send(jid, mess.loading);
        const loadingId   = loadingSent?.key?.id || loadingSent?.id || null;

        // v2 = URL PERMANEN (URL-nya ditampilkan ke user & mungkin disimpan)
        const info = await uploadInfo(buffer, filename, mime, { v2: true });

        const sendResult = async (text) => {
          if (loadingId) {
            try {
              const botJid = (botData.bot_number || '').replace(/\D/g, '') + '@s.whatsapp.net';
              await client.message.send(jid, text, {
                editKey: { id: loadingId, ...(isGroup ? { participant: botJid } : {}) }
              });
              return;
            } catch { /* fallback ke reply biasa */ }
          }
          await reply(text);
        };

        const sizeKb = info.size ? `${(info.size / 1024).toFixed(1)} KB` : `${(buffer.length / 1024).toFixed(1)} KB`;
        const providerText = info.provider ? `\n🏢 Provider: ${info.provider}` : '';
        const expiredText = info.expires || 'Permanen';

        await sendResult(`🔗 *URL Media (Permanen)*\n\n${info.url}\n\n📦 Ukuran: ${sizeKb}\n⏳ Expired: ${expiredText}${providerText}`);
      } catch (e) {
        await reply(`${mess.error}\n${e.message}`);
      }
      return true;
    }

    // ── pay ───────────────────────────────────────────────────────────────
    case 'pay': {
      // Prioritas: qris_url di botData (URL) → fallback ke QRIS_DEFAULT di env (bisa path lokal atau URL)
      const qrisSource = botData.qris_url || mess.qrisDefault || '';
      if (!qrisSource) {
        await reply('❌ QRIS belum diset. Owner bisa set dengan `.setqris` atau melalui dashboard.');
        return true;
      }
      try {
        const fs   = require('fs');
        const path = require('path');
        let buf, mime;

        const isUrl = qrisSource.startsWith('http://') || qrisSource.startsWith('https://');
        if (isUrl) {
          const res    = await fetch(qrisSource);
          const arrBuf = await res.arrayBuffer();
          buf  = Buffer.from(arrBuf);
          mime = res.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
        } else {
          // Path lokal — resolve relatif ke root project
          const absPath = path.resolve(__dirname, '..', qrisSource);
          if (!fs.existsSync(absPath)) throw new Error(`File tidak ditemukan: ${absPath}`);
          buf  = fs.readFileSync(absPath);
          const ext  = path.extname(absPath).toLowerCase();
          const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
          mime = mimeMap[ext] || 'image/jpeg';
        }

        await client.message.send(jid, {
          type:     'image',
          media:    buf,
          mimetype: mime,
          caption:  `💳 *Pembayaran via QRIS*\n\nScan QR di atas untuk melakukan pembayaran.\n\n${botData.footer_text || ''}`.trim(),
        });
      } catch (e) {
        await reply(`❌ Gagal mengirim gambar QRIS: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── rvo / readviewonce ────────────────────────────────────────────────────
    case 'rvo':
    case 'readviewonce':
    case 'readvo': {
      // Harus reply ke pesan view once
      const quoted = ctx.msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      if (!quoted) {
        await reply(`Penggunaan: Reply pesan view once lalu ketik *${p}rvo*`);
        return true;
      }

      // Cari tipe media di quoted message
      const mediaTypes = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'];
      const mediaType  = mediaTypes.find(t => quoted[t]);
      if (!mediaType) {
        await reply('❌ Pesan yang di-reply bukan media (gambar/video/audio)!');
        return true;
      }

      const mediaMsg = quoted[mediaType];

      // Pastikan ini memang view once
      const isViewOnce = mediaMsg?.viewOnce === true
        || ctx.msg?.message?.viewOnceMessage
        || ctx.msg?.message?.viewOnceMessageV2
        || ctx.msg?.message?.viewOnceMessageV2Extension;

      try {
        // Fix buffer fields yang mungkin base64 string
        const fixed = Object.assign({}, mediaMsg);
        for (const f of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
          if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
        }

        const buf = await client.message.downloadBytes({ [mediaType]: fixed });
        if (!buf || !buf.length) { await reply('❌ Gagal mengunduh media!'); return true; }

        const mime = mediaMsg.mimetype || 'image/jpeg';
        const typeMap = {
          imageMessage:    'image',
          videoMessage:    'video',
          audioMessage:    'audio',
          documentMessage: 'document',
        };
        const sendType = typeMap[mediaType] || 'image';

        await client.message.send(jid, {
          type:     sendType,
          media:    buf,
          mimetype: mime,
          caption:  mediaMsg.caption || '',
        });
      } catch (e) {
        await reply(`❌ Media gagal dimuat: ${e.message}`);
      }
      return true;
    }

    // ── chatgpt — ChatGPT AI ──────────────────────────────────────────────────
    case 'chatgpt':
    case 'gpt': {
      const prompt = args.join(' ').trim();
      if (!prompt) {
        await reply(`Penggunaan: *${p}chatgpt* <pertanyaan>\n\nContoh:\n• ${p}chatgpt siapa penemu listrik?\n\nKetik *${p}resetgpt* untuk reset sesi percakapan.`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);

        const sessionKey = `${botData.id}:${sender}`;
        const conversationId = gptSessions.get(sessionKey);

        const params = { prompt };
        if (conversationId) params.conversationId = conversationId;

        const { data } = await axios.get(`${process.env.BASE_API}api/ai/chatgpt`, {
          params,
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 30000,
        });
        const response = data?.results?.response;
        const newConvId = data?.results?.conversationId;
        if (!response) throw new Error('Tidak ada hasil dari API');

        // Simpan conversationId untuk sesi berikutnya
        if (newConvId) gptSessions.set(sessionKey, newConvId);

        // Bersihkan tag internal ChatGPT yang bocor ke response
        const clean = response
          .replace(/entity\["[^"]*","[^"]*","[^"]*"\]/g, '')
          .replace(/\[\s*\]/g, '')
          .trim();
        await react(mess.reactSuccess);
        await reply(`🤖 *ChatGPT*\n\n${clean}`);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── aio — All-in-One Downloader ───────────────────────────────────────────
    case 'aio': {
      const url = args[0];
      if (!url) {
        await reply(`Penggunaan: *${p}aio* <url>\n\nContoh:\n• ${p}aio https://youtu.be/dQw4w9WgXcQ\n• ${p}aio https://www.tiktok.com/@user/video/xxx`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);

        const { data } = await axios.get(`${process.env.BASE_API}api/download/aio`, {
          params: { url },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 30000,
        });

        if (!data?.success || !data?.results) throw new Error('Gagal mengambil data');

        const r        = data.results;
        const title    = r.title    || 'Tidak diketahui';
        const platform = r.platform || 'Unknown';
        const duration = r.duration_string || '';

        // Cari audio yang bisa di-download (bukan thumbnail/jpg, bukan HLS .m3u8)
        const audios = (r.audio || []).filter(a =>
          a.url && !a.url.includes('.jpg') && !a.url.includes('.m3u8') && a.has_audio
        );
        const audioUrl = audios[0]?.url;

        // Cari video yang bisa di-download (bukan HLS .m3u8, bukan thumbnail)
        const videos = (r.videos || []).filter(v =>
          v.url && !v.url.includes('.m3u8') && !v.url.includes('.jpg')
        );
        const videoUrl = videos[0]?.url;

        // Info header
        const info = `📥 *${title}*\n🌐 Platform: ${platform}${duration ? `\n⏱ Durasi: ${duration}` : ''}`;

        // Headers umum untuk bypass CDN restriction
        const refererMap = {
          'tiktok':    'https://www.tiktok.com/',
          'youtube':   'https://www.youtube.com/',
          'instagram': 'https://www.instagram.com/',
          'bilibili':  'https://www.bilibili.com/',
          'twitter':   'https://twitter.com/',
          'facebook':  'https://www.facebook.com/',
        };
        const referer = refererMap[(platform || '').toLowerCase()] || 'https://www.google.com/';
        const dlHeaders = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer':    referer,
        };

        if (videoUrl) {
          // Download video langsung (sebelum URL expired)
          const videoRes = await axios.get(videoUrl, {
            responseType: 'arraybuffer',
            timeout:      90000,
            headers:      dlHeaders,
            maxContentLength: 50 * 1024 * 1024, // max 50MB
          });
          const videoBuf = Buffer.from(videoRes.data);

          await react(mess.reactSuccess);
          await client.message.send(jid, {
            type:     'video',
            media:    videoBuf,
            mimetype: 'video/mp4',
            caption:  info,
          });
          videoBuf[0] = null;
        } else if (audioUrl) {
          // Tidak ada video, kirim audio saja
          const audioRes = await axios.get(audioUrl, {
            responseType: 'arraybuffer',
            timeout:      60000,
            headers:      dlHeaders,
          });
          const audioBuf = Buffer.from(audioRes.data);

          await react(mess.reactSuccess);
          await client.message.send(jid, {
            type:     'audio',
            media:    audioBuf,
            mimetype: 'audio/mp4',
          });
          audioBuf[0] = null; // hint GC untuk segera bebaskan memory
          await reply(`${info}\n\n🎵 Hanya audio tersedia`);
        } else {
          throw new Error('Tidak ada format yang bisa didownload');
        }
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal download: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── bratv2 — Brat sticker ─────────────────────────────────────────────────
    case 'bratv2': {
      const text = args.join(' ').trim();
      if (!text) {
        await reply(`Penggunaan: *${p}bratv2* <teks>\n\nContoh: ${p}bratv2 its not that deep`);
        return true;
      }
      try {
        const axios  = require('axios');
        const os     = require('os');
        const path   = require('path');
        const fs     = require('fs');
        const { spawn } = require('child_process');
        await react(mess.reactLoading);

        const res = await axios.get(`${process.env.BASE_API}api/maker/bratv2`, {
          params:       { text },
          headers:      { 'X-API-Key': process.env.KEY_API },
          responseType: 'arraybuffer',
          timeout:      30000,
        });

        const mp4Buf = Buffer.from(res.data);
        const tmpDir = os.tmpdir();
        const tmpIn  = path.join(tmpDir, `bratv2_in_${Date.now()}.mp4`);
        const tmpOut = path.join(tmpDir, `bratv2_out_${Date.now()}.webp`);
        fs.writeFileSync(tmpIn, mp4Buf);

        await new Promise((resolve, reject) => {
          const ff = spawn('ffmpeg', [
            '-y',
            // Sumbernya MP4 4 detik → di-loop biar genap 10 detik. `-t` di depan
            // `-i` WAJIB: tanpa itu palettegen nunggu EOF yang nggak pernah
            // datang (input di-loop terus) dan perintahnya nggantung.
            '-stream_loop', '-1', '-t', '10',
            '-i', tmpIn,
            '-vcodec', 'libwebp',
            '-vf', "scale='min(512,iw)':'min(512,ih)':force_original_aspect_ratio=decrease,fps=15,pad=512:512:-1:-1:color=white@0.0,split[a][b];[a]palettegen=reserve_transparent=on:transparency_color=ffffff[p];[b][p]paletteuse",
            '-loop', '0', '-ss', '00:00:00', '-t', '00:00:10',
            '-preset', 'default', '-an', tmpOut
          ]);
          ff.on('error', reject);
          ff.on('close', code => code !== 0 ? reject(new Error(`ffmpeg exit code ${code}`)) : resolve());
        });

        const webpBuffer = fs.readFileSync(tmpOut);
        try { fs.unlinkSync(tmpIn); } catch {}
        try { fs.unlinkSync(tmpOut); } catch {}

        const finalBuf = await addStickerExif(webpBuffer, mess.packname, mess.author);
        await react(mess.reactSuccess);
        await client.message.send(jid, { type: 'sticker', media: finalBuf, mimetype: 'image/webp' });
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── cekroblox / stalkroblox — Roblox User Info ───────────────────────────
    case 'cekroblox':
    case 'stalkroblox': {
      const username = args[0];
      if (!username) {
        await reply(`Penggunaan: *${p}cekroblox* <username>\n\nContoh:\n• ${p}cekroblox Builderman`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);

        const { data } = await axios.get(`${process.env.BASE_API}api/stalker/roblox`, {
          params:  { username },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 15000,
        });

        if (!data?.success || !data?.results) throw new Error('User tidak ditemukan');

        const r       = data.results;
        const created = r.created ? new Date(r.created).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' }) : '-';
        const caption = [
          `🎮 *Roblox User Info*`,
          ``,
          `👤 Username    : ${r.username || '-'}`,
          `📛 Display Name: ${r.display_name || '-'}`,
          `🆔 ID          : ${r.id || '-'}`,
          `📅 Bergabung   : ${created}`,
          `✅ Verified    : ${r.has_verified_badge ? 'Ya' : 'Tidak'}`,
          `🚫 Banned      : ${r.is_banned ? 'Ya' : 'Tidak'}`,
          ``,
          `👥 Friends     : ${(r.friends_count || 0).toLocaleString('id-ID')}`,
          `❤️ Followers   : ${(r.followers_count || 0).toLocaleString('id-ID')}`,
          `➡️ Following   : ${(r.following_count || 0).toLocaleString('id-ID')}`,
          ``,
          `🟢 Status      : ${r.presence || '-'}`,
          `📍 Last Seen   : ${r.last_location || '-'}`,
          `🔗 Profile     : ${r.profile_url || '-'}`,
        ].join('\n');

        // Kirim avatar headshot sebagai gambar + caption
        if (r.avatar_headshot) {
          const imgRes = await axios.get(r.avatar_headshot, { responseType: 'arraybuffer', timeout: 15000 });
          const imgBuf = Buffer.from(imgRes.data);
          await react(mess.reactSuccess);
          await client.message.send(jid, {
            type:     'image',
            media:    imgBuf,
            mimetype: 'image/png',
            caption,
          });
          imgBuf[0] = null;
        } else {
          await react(mess.reactSuccess);
          await reply(caption);
        }
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── douyin / douyindl — Douyin Downloader ─────────────────────────────────
    case 'douyin':
    case 'douyindl': {
      const dyUrl = args[0];
      if (!dyUrl) {
        await reply(`Penggunaan: *${p}douyin* <url>\n\nContoh:\n• ${p}douyin https://v.douyin.com/if894Bb/`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);

        const { data } = await axios.get(`${process.env.BASE_API}api/download/douyin`, {
          params:  { url: dyUrl },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 30000,
        });

        if (!data?.success || !data?.results) throw new Error('Gagal mengambil data');

        const r       = data.results;
        const title   = r.title || 'Tidak diketahui';
        const caption = `📥 *${title}*\n🌐 Platform: Douyin`;

        const videos   = (r.videos || []).filter(v => v.url && !v.url.includes('.m3u8'));
        const videoUrl = videos[0]?.url;
        if (!videoUrl) throw new Error('Tidak ada video yang bisa didownload');

        const videoRes = await axios.get(videoUrl, {
          responseType:     'arraybuffer',
          timeout:          90000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer':    'https://www.douyin.com/',
          },
          maxContentLength: 50 * 1024 * 1024,
        });
        const videoBuf = Buffer.from(videoRes.data);

        await react(mess.reactSuccess);
        await client.message.send(jid, {
          type:     'video',
          media:    videoBuf,
          mimetype: 'video/mp4',
          caption,
        });
        videoBuf[0] = null;
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal download: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── capcut / capcutdl — CapCut Downloader ────────────────────────────────
    case 'capcut':
    case 'capcutdl': {
      const ccUrl = args[0];
      if (!ccUrl) {
        await reply(`Penggunaan: *${p}capcut* <url>\n\nContoh:\n• ${p}capcut https://www.capcut.com/template-detail/7273798219329441025`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);

        const { data } = await axios.get(`${process.env.BASE_API}api/download/capcut`, {
          params:  { url: ccUrl },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 30000,
        });

        if (!data?.success || !data?.results) throw new Error('Gagal mengambil data');

        const r       = data.results;
        const title   = r.title || r.short_title || 'Tidak diketahui';
        const author  = r.author?.name || r.owner || 'Unknown';
        const caption = `📥 *${title}*\n👤 Author: ${author}`;

        const videoUrl = r.video;
        if (!videoUrl) throw new Error('Tidak ada video yang bisa didownload');

        const videoRes = await axios.get(videoUrl, {
          responseType:     'arraybuffer',
          timeout:          90000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer':    'https://www.capcut.com/',
          },
          maxContentLength: 50 * 1024 * 1024,
        });
        const videoBuf = Buffer.from(videoRes.data);

        await react(mess.reactSuccess);
        await client.message.send(jid, {
          type:     'video',
          media:    videoBuf,
          mimetype: 'video/mp4',
          caption,
        });
        videoBuf[0] = null;
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal download: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── bilibili / bilibildl — Bilibili Downloader ───────────────────────────
    case 'bilibili':
    case 'bilibildl': {
      const biliUrl = args[0];
      if (!biliUrl) {
        await reply(`Penggunaan: *${p}bilibili* <url>\n\nContoh:\n• ${p}bilibili https://www.bilibili.com/video/BV1cB8B6dE9K`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);

        const { data } = await axios.get(`${process.env.BASE_API}api/download/bilibili`, {
          params:  { url: biliUrl },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 30000,
        });

        if (!data?.success || !data?.results) throw new Error('Gagal mengambil data');

        const r        = data.results;
        const title    = r.title    || 'Tidak diketahui';
        const platform = r.platform || 'Bilibili';

        const videos = (r.videos || []).filter(v =>
          v.url && !v.url.includes('.m3u8') && !v.url.includes('.jpg')
        );
        const videoUrl = videos[0]?.url;
        if (!videoUrl) throw new Error('Tidak ada video yang bisa didownload');

        const videoRes = await axios.get(videoUrl, {
          responseType:     'arraybuffer',
          timeout:          90000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer':    'https://www.bilibili.com/',
          },
          maxContentLength: 50 * 1024 * 1024,
        });
        const videoBuf = Buffer.from(videoRes.data);

        await react(mess.reactSuccess);
        await client.message.send(jid, {
          type:     'video',
          media:    videoBuf,
          mimetype: 'video/mp4',
          caption:  `📥 *${title}*\n🌐 Platform: ${platform}`,
        });
        videoBuf[0] = null;
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal download: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── deepai — Standard AI dengan sesi ─────────────────────────────────────
    case 'deepai': {
      const message = args.join(' ').trim();
      if (!message) {
        await reply(`Penggunaan: *${p}deepai* <pesan>\n\nContoh:\n• ${p}deepai halo, apa kabar?\n\nKetik *${p}resetdeepai* untuk reset sesi.`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);

        const sessionKey  = `${botData.id}:${sender}`;
        const sessionUuid = deepaiSessions.get(sessionKey);

        const params = { message, searchMode: true };
        if (sessionUuid) params.sessionUuid = sessionUuid;

        const { data } = await axios.get(`${process.env.BASE_API}api/ai/standard`, {
          params,
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 30000,
        });
        const text      = data?.results?.message;
        const newUuid   = data?.results?.sessionUuid;
        if (!text) throw new Error('Tidak ada hasil dari API');

        // Simpan sessionUuid untuk sesi berikutnya
        if (newUuid) deepaiSessions.set(sessionKey, newUuid);

        await react(mess.reactSuccess);
        await reply(`🧠 *DeepAI*\n\n${text}`);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── resetdeepai — Reset sesi DeepAI ──────────────────────────────────────
    case 'resetdeepai': {
      const sessionKey = `${botData.id}:${sender}`;
      if (deepaiSessions.has(sessionKey)) {
        deepaiSessions.delete(sessionKey);
        await reply('🔄 Sesi DeepAI kamu berhasil direset.');
      } else {
        await reply('Kamu belum punya sesi aktif.');
      }
      return true;
    }

    // ── ai — NoTrack AI ───────────────────────────────────────────────────────
    case 'ai': {
      const message = args.join(' ').trim();
      if (!message) {
        await reply(`Penggunaan: *${p}ai* <pesan>\n\nContoh:\n• ${p}ai halo, apa kabar?\n• ${p}ai jelaskan apa itu gravitasi`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/ai/notrack`, {
          params: { message },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 30000,
        });
        const responses = data?.results?.responses;
        if (!responses?.length) throw new Error('Tidak ada hasil dari API');
        const text = responses.map(r => r.response).join('\n');
        await react(mess.reactSuccess);
        await reply(`🤖 *AI*\n\n${text}`);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── toghibli — Ghibli Style Generator ────────────────────────────────────
    case 'toghibli':
    case 'ghibli': {
      try {
        const axios    = require('axios');
        const FormData = require('form-data');

        const rawMsg     = msg.message || {};
        const msgType    = Object.keys(rawMsg)[0] || '';
        const quoted     = rawMsg?.extendedTextMessage?.contextInfo?.quotedMessage;
        const quotedType = quoted ? Object.keys(quoted)[0] : null;

        const imgTypes    = ['imageMessage'];
        const isDirectImg = imgTypes.includes(msgType);
        const isQuotedImg = quotedType && imgTypes.includes(quotedType);

        if (!isDirectImg && !isQuotedImg) {
          await reply(`Kirim atau reply gambar dengan *${p}toghibli*\n\nContoh: kirim foto selfie + caption *${p}toghibli*`);
          return true;
        }

        await react(mess.reactLoading);

        // Download gambar dari WA
        let buffer, mime, filename;
        if (isDirectImg) {
          const content = rawMsg[msgType];
          const fixed   = Object.assign({}, content);
          for (const f of ['mediaKey','fileSha256','fileEncSha256']) {
            if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
          }
          buffer   = Buffer.from(await client.message.downloadBytes({ [msgType]: fixed }));
          mime     = content.mimetype || 'image/jpeg';
          filename = `img_${Date.now()}.${mimeToExt(mime)}`;
        } else {
          const content = quoted[quotedType];
          const fixed   = Object.assign({}, content);
          for (const f of ['mediaKey','fileSha256','fileEncSha256']) {
            if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
          }
          buffer   = Buffer.from(await client.message.downloadBytes({ [quotedType]: fixed }));
          mime     = content.mimetype || 'image/jpeg';
          filename = `img_${Date.now()}.${mimeToExt(mime)}`;
        }

        // Upload gambar ke YaPari untuk dapat URL publik
        const form = new FormData();
        form.append('file', buffer, { filename, contentType: mime });
        const uploadRes = await axios.post(`${process.env.BASE_API}api/tools/upload`, form, {
          headers: { ...form.getHeaders(), 'X-API-Key': process.env.KEY_API },
          timeout: 20000,
        });
        const imageUrl = uploadRes.data?.results?.file_url || uploadRes.data?.results?.url || uploadRes.data?.url;
        if (!imageUrl) throw new Error('Gagal upload gambar');

        // Kirim ke Ghibli Style API (bisa lama ~30-40 detik)
        const aiRes = await axios.get(`${process.env.BASE_API}api/ai/ghibli-style`, {
          params: { url: imageUrl },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 60000,
        });
        const resultUrl = aiRes.data?.results?.uploaded_url || aiRes.data?.results?.result_url;
        if (!resultUrl) throw new Error('Tidak ada hasil dari API');

        // Download hasil gambar Ghibli
        const resultRes = await axios.get(resultUrl, { responseType: 'arraybuffer', timeout: 20000 });
        const resultBuf = Buffer.from(resultRes.data);

        await react(mess.reactSuccess);
        await client.message.send(jid, {
          type:    'image',
          media:   resultBuf,
          mimetype: 'image/jpeg',
          caption: '🎨 *Ghibli Style*\n\n_Powered by YaPari API_',
        });
      } catch (e) {
        await react(mess.reactError);
        console.error(`[bilibili debug] status: ${e.response?.status} url: ${e.config?.url?.slice(0,80)} msg: ${e.message}`);
        await reply(`❌ Gagal download: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── gemini — Gemini AI ────────────────────────────────────────────────────
    case 'gemini': {
      const prompt = args.join(' ').trim();
      if (!prompt) {
        await reply(`Penggunaan: *${p}gemini* <pertanyaan>\n\nContoh:\n• ${p}gemini apa itu fotosintesis?\n\nKetik *${p}resetgemini* untuk reset sesi percakapan.`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);

        const sessionKey = `${botData.id}:${sender}`;
        const previousId = geminiSessions.get(sessionKey);

        const params = { prompt };
        if (previousId) params.previousId = previousId;

        const { data } = await axios.get(`${process.env.BASE_API}api/ai/gemini`, {
          params,
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 30000,
        });
        const text = data?.results?.text;
        const newId = data?.results?.id;
        if (!text) throw new Error('Tidak ada hasil dari API');

        // Simpan id untuk sesi berikutnya
        if (newId) geminiSessions.set(sessionKey, newId);

        await react(mess.reactSuccess);
        await reply(`✨ *Gemini*\n\n${text}`);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── resetgemini — Reset sesi Gemini ───────────────────────────────────────
    case 'resetgemini': {
      const sessionKey = `${botData.id}:${sender}`;
      if (geminiSessions.has(sessionKey)) {
        geminiSessions.delete(sessionKey);
        await reply('🔄 Sesi Gemini kamu berhasil direset. Percakapan mulai dari awal.');
      } else {
        await reply('Kamu belum punya sesi aktif.');
      }
      return true;
    }

    // ── resetgpt — Reset sesi ChatGPT ────────────────────────────────────────
    case 'resetgpt': {
      const sessionKey = `${botData.id}:${sender}`;
      if (gptSessions.has(sessionKey)) {
        gptSessions.delete(sessionKey);
        await reply('🔄 Sesi ChatGPT kamu berhasil direset. Percakapan mulai dari awal.');
      } else {
        await reply('Kamu belum punya sesi aktif.');
      }
      return true;
    }

    // ── ailyrics — AI Song Lyrics Generator ──────────────────────────────────
    case 'ailyrics':
    case 'buatlirik': {
      const prompt = args.join(' ').trim();
      if (!prompt) {
        await reply(`Penggunaan: *${p}ailyrics* <deskripsi lagu>\n\nContoh:\n• ${p}ailyrics lagu tentang hujan dan kerinduan, genre pop Indonesia\n• ${p}ailyrics sad love song in English`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/ai/ai-lyrics`, {
          params: { prompt },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 30000,
        });
        const lyrics = data?.results?.lyrics;
        if (!lyrics) throw new Error('Tidak ada hasil dari API');
        await react(mess.reactSuccess);
        await reply(`🎵 *AI Lyrics Generator*\n\n${lyrics}`);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal generate lirik: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── tanyaimg — AI Image Reader ───────────────────────────────────────────
    case 'tanyaimg': {
      try {
        const axios    = require('axios');
        const FormData = require('form-data');

        const rawMsg     = msg.message || {};
        const msgType    = Object.keys(rawMsg)[0] || '';
        const quoted     = rawMsg?.extendedTextMessage?.contextInfo?.quotedMessage;
        const quotedType = quoted ? Object.keys(quoted)[0] : null;

        const imgTypes = ['imageMessage'];
        const isDirectImg = imgTypes.includes(msgType);
        const isQuotedImg = quotedType && imgTypes.includes(quotedType);

        if (!isDirectImg && !isQuotedImg) {
          await reply(`Kirim atau reply gambar dengan *${p}tanyaimg* [pertanyaan]\n\nContoh:\n• ${p}tanyaimg apa yang ada di gambar ini?\n• ${p}tanyaimg describe this image`);
          return true;
        }

        // Ambil prompt dari args, default ke pertanyaan umum
        // Tambah instruksi supaya AI langsung jawab tanpa balik tanya
        const userPrompt = args.join(' ').trim() || 'Deskripsikan gambar ini secara detail';
        const prompt = `${userPrompt}. Jawab langsung dan ringkas, jangan balik bertanya ke user.`;

        await react(mess.reactLoading);

        // Download gambar dari WA
        let buffer, mime, filename;
        if (isDirectImg) {
          const content = rawMsg[msgType];
          const fixed   = Object.assign({}, content);
          for (const f of ['mediaKey','fileSha256','fileEncSha256']) {
            if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
          }
          buffer   = Buffer.from(await client.message.downloadBytes({ [msgType]: fixed }));
          mime     = content.mimetype || 'image/jpeg';
          filename = `img_${Date.now()}.${mimeToExt(mime)}`;
        } else {
          const content = quoted[quotedType];
          const fixed   = Object.assign({}, content);
          for (const f of ['mediaKey','fileSha256','fileEncSha256']) {
            if (typeof fixed[f] === 'string') fixed[f] = Buffer.from(fixed[f], 'base64');
          }
          buffer   = Buffer.from(await client.message.downloadBytes({ [quotedType]: fixed }));
          mime     = content.mimetype || 'image/jpeg';
          filename = `img_${Date.now()}.${mimeToExt(mime)}`;
        }

        // Upload gambar ke YaPari untuk dapat URL publik
        const form = new FormData();
        form.append('file', buffer, { filename, contentType: mime });
        const uploadRes = await axios.post(`${process.env.BASE_API}api/tools/upload`, form, {
          headers: { ...form.getHeaders(), 'X-API-Key': process.env.KEY_API },
          timeout: 20000,
        });
        const imageUrl = uploadRes.data?.results?.file_url || uploadRes.data?.results?.url || uploadRes.data?.url;
        if (!imageUrl) throw new Error('Gagal upload gambar, URL tidak ditemukan');

        // Kirim ke AI Image Reader
        const aiRes = await axios.get(`${process.env.BASE_API}api/ai/ai-image-read`, {
          params: { url: imageUrl, prompt },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 30000,
        });

        const answer = aiRes.data?.results?.answer;
        if (!answer) throw new Error('Tidak ada jawaban dari AI');

        await react(mess.reactSuccess);
        await reply(`🔍 *AI Image Reader*\n\n${answer}`);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal membaca gambar: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── mediafire — MediaFire Downloader ────────────────────────────────────────
    case 'mediafire':
    case 'mfdl': {
      const url = args[0];
      if (!url) {
        await reply(`Masukkan link MediaFire.\nContoh: *${p}mediafire https://mediafire.com/...*`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/download/mediafire`, {
          params: { url },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 30000,
        });
        const dl = data?.results?.downloadUrl;
        if (!dl) throw new Error('Tidak ada link download dari API');
        const res = await axios.get(dl, { responseType: 'arraybuffer', timeout: 60000 });
        const buf = Buffer.from(res.data);
        const ct  = res.headers['content-type'] || 'application/octet-stream';
        const ext = mimeToExt(ct);
        await react(mess.reactSuccess);
        if (ct.startsWith('video/')) {
          const thumb = await genThumbnail(buf, ct);
          await client.message.send(jid, { type: 'video', media: buf, mimetype: ct, caption: `📁 *MediaFire*\n${dl}`, ...(thumb ? { jpegThumbnail: thumb } : {}) });
        } else if (ct.startsWith('audio/')) {
          await client.message.send(jid, { type: 'audio', media: buf, mimetype: ct });
        } else if (ct.startsWith('image/')) {
          const thumb = await genThumbnail(buf, ct);
          await client.message.send(jid, { type: 'image', media: buf, mimetype: ct, caption: `📁 *MediaFire*`, ...(thumb ? { jpegThumbnail: thumb } : {}) });
        } else {
          await reply(`📁 *MediaFire*\n\nLink download:\n${dl}`);
        }
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal download MediaFire: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── likee — Likee Downloader ─────────────────────────────────────────────
    case 'likee':
    case 'likeedl': {
      const url = args[0];
      if (!url) {
        await reply(`Masukkan link Likee.\nContoh: *${p}likee https://likee.video/...*`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/download/likee`, {
          params: { url },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 30000,
        });
        const videos = data?.results?.videos;
        if (!videos || !videos.length) throw new Error('Tidak ada video dari API');
        await react(mess.reactSuccess);
        for (const v of videos) {
          const dlUrl = v.url || v.download_url || v;
          if (!dlUrl) continue;
          const res = await axios.get(dlUrl, { responseType: 'arraybuffer', timeout: 60000 });
          const thumb = await genThumbnail(Buffer.from(res.data), 'video/mp4');
          await client.message.send(jid, { type: 'video', media: Buffer.from(res.data), mimetype: 'video/mp4', caption: `🎵 *Likee*`, ...(thumb ? { jpegThumbnail: thumb } : {}) });
        }
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal download Likee: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── moddroid — ModDroid Downloader ──────────────────────────────────────
    case 'moddroid':
    case 'moddroiddl': {
      const query = args.join(' ');
      if (!query) {
        await reply(`Masukkan nama aplikasi/game.\nContoh: *${p}moddroid minecraft*`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/download/moddroid`, {
          params: { query },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 30000,
        });
        const results = data?.results?.results;
        if (!results || !results.length) throw new Error('Tidak ada hasil dari API');
        await react(mess.reactSuccess);
        let txt = `🤖 *ModDroid Results*\n\n`;
        for (const r of results.slice(0, 5)) {
          txt += `*${r.title || r.name || 'Unknown'}*\n`;
          if (r.version) txt += `Versi: ${r.version}\n`;
          if (r.download_url || r.url) txt += `Link: ${r.download_url || r.url}\n`;
          txt += '\n';
        }
        await reply(txt.trim());
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal search ModDroid: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── facebook — Facebook Downloader ──────────────────────────────────────
    case 'facebook':
    case 'fbdl':
    case 'fb': {
      const url = args[0];
      if (!url) {
        await reply(`Masukkan link Facebook video.\nContoh: *${p}fb https://fb.com/...*`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/download/facebook`, {
          params: { url },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 30000,
        });
        const videos = data?.results?.videos;
        if (!videos || !videos.length) throw new Error('Tidak ada video dari API');
        // Prefer HD, fallback ke SD
        const vid = videos.find(v => v.quality === 'hd') || videos[0];
        const dlUrl = vid.url || vid.download_url;
        if (!dlUrl) throw new Error('URL video tidak ditemukan');
        const res = await axios.get(dlUrl, { responseType: 'arraybuffer', timeout: 90000 });
        await react(mess.reactSuccess);
        const thumb = await genThumbnail(Buffer.from(res.data), 'video/mp4');
        await client.message.send(jid, {
          type: 'video', media: Buffer.from(res.data), mimetype: 'video/mp4',
          caption: `📘 *Facebook*\nKualitas: ${vid.quality || 'unknown'}`,
          ...(thumb ? { jpegThumbnail: thumb } : {}),
        });
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal download Facebook: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── tgsticker — Telegram Sticker Downloader (dikirim sebagai SATU pack) ──
    case 'tgsticker':
    case 'telesticker':
    case 'stele': {
      const url = args[0];
      if (!url) {
        await reply(`Masukkan link sticker pack Telegram.\nContoh: *${p}telesticker https://t.me/addstickers/...*`);
        return true;
      }
      try {
        const axios  = require('axios');
        const { buatPaketSticker, bagiSticker } = require('../engine/stickerPack');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/download/telesticker`, {
          params: { url },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 30000,
        });
        const hasil = data?.results || {};
        const stickers = hasil.stickers;
        if (!stickers || !stickers.length) throw new Error('Tidak ada sticker dari API');
        // Telegram juga punya pack animasi (.tgs) & video (.webm) — cuma .webp yang bisa dikirim apa adanya
        const webp = stickers.filter(s => !s.format || s.format === 'webp');
        if (!webp.length) throw new Error('Pack ini cuma sticker animasi/video, belum didukung');

        const pilih = webp;
        const isi = [];
        for (const s of pilih) {
          const sUrl = s.url || s.file_url || s;
          if (!sUrl) continue;
          const res = await axios.get(sUrl, { responseType: 'arraybuffer', timeout: 30000 });
          isi.push({ isi: Buffer.from(res.data), emoji: s.emoji || '' });
        }
        if (isi.length < 3) throw new Error(`Pack ini cuma punya ${isi.length} sticker, minimal 3`);

        // WA batas 60 sticker PER pack, bukan per total -> 130 sticker = 3 kartu (60/60/10).
        const nama = hasil.title || 'Sticker Pack';
        const bagian = bagiSticker(isi);
        const jumlahPack = bagian.length;
        const paket = [];
        for (const b of bagian) {
          paket.push(await buatPaketSticker(b, {
            nama: jumlahPack > 1 ? `${nama} (${paket.length + 1}/${jumlahPack})` : nama,
          }));
        }
        // Zip pack + thumbnail di-enkripsi & diupload di adapter (harus satu media key).
        for (const p of paket) await client.message.send(jid, { paketSticker: p }, { quoted: msg });
        await react(mess.reactSuccess);
        await reply(`📦 *Sticker Pack Telegram*\nNama: ${nama}\nIsi: ${isi.length} sticker`
          + (jumlahPack > 1 ? ` -> *${jumlahPack} pack* (${paket.map(p => p.sticker.length).join('/')})` : '')
          + `\nUkuran: ${Math.round(paket.reduce((a, p) => a + p.zip.length, 0) / 1024)} KB\n\nTekan *Tambah* di tiap kartu buat nyimpen pack-nya ke WhatsApp.`);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal download Telegram Sticker: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── spotifydl — Download lagu dari LINK Spotify
    // Coba spotidown.app dulu; kalau sumber itu mati (reCAPTCHA / session token),
    // otomatis jatuh ke jalur YouTube (artis + judul dari halaman Spotify).
    case 'spotifydl': {
      const url = args[0];
      if (!url) {
        await reply(`Masukkan link Spotify.\nContoh: *${p}spotifydl https://open.spotify.com/track/...*`);
        return true;
      }
      const axios = require('axios');
      const kirimAudio = async (buf, mime, judul, artis) => {
        await client.message.send(jid, { type: 'audio', media: buf, mimetype: mime || 'audio/mpeg' });
        await reply(`🎵 *${judul || 'Spotify'}*${artis ? `\n👤 ${artis}` : ''}`);
      };
      const kueriDariLink = async () => {
        // oEmbed resmi Spotify → judul + artis tanpa API key
        const oe = await axios.get('https://open.spotify.com/oembed', {
          params: { url }, timeout: 15000,
        });
        const t = String(oe.data?.title || '');
        const parts = t.split(' - ').map(s => s.trim()).filter(Boolean);
        return {
          judul : parts.length > 1 ? parts.slice(1).join(' - ') : t,
          artis : parts.length > 1 ? parts[0] : '',
        };
      };
      try {
        await react(mess.reactLoading);
        let terkirim = false;
        try {
          const { data } = await axios.get(`${process.env.BASE_API}api/download/spotify`, {
            params: { url },
            headers: { 'X-API-Key': process.env.KEY_API },
            timeout: 60000,
          });
          const downloads = data?.results?.downloads;
          if (!downloads || !downloads.length) throw new Error('Tidak ada hasil dari API');
          const dl = downloads[0];
          const dlUrl = dl.url || dl.download_url;
          if (!dlUrl) throw new Error('URL download tidak ditemukan');
          const res = await axios.get(dlUrl, { responseType: 'arraybuffer', timeout: 60000 });
          await kirimAudio(Buffer.from(res.data), 'audio/mpeg',
                           data?.results?.title, data?.results?.artist);
          terkirim = true;
        } catch (eApi) {
          // Sumber spotidown sedang mati → pakai jalur YouTube
          const { judul, artis } = await kueriDariLink();
          if (!judul) throw eApi;
          const lagu = await ambilAudioLagu(`${judul} ${artis}`.trim());
          if (!lagu.ok) throw eApi;
          await kirimAudio(lagu.buf, lagu.mime, lagu.title || judul, lagu.artist || artis);
          terkirim = true;
        }
        if (!terkirim) throw new Error('Tidak ada audio yang bisa dikirim');
        await react(mess.reactSuccess);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal download Spotify: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── soundcloud — SoundCloud Downloader ──────────────────────────────────
    case 'soundcloud':
    case 'scdl': {
      const url = args[0];
      if (!url) {
        await reply(`Masukkan link SoundCloud.\nContoh: *${p}soundcloud https://soundcloud.com/...*`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/download/soundcloud`, {
          params: { url },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 60000,
        });
        const dlUrl = data?.results?.best_download?.url;
        if (!dlUrl) throw new Error('URL download tidak ditemukan');
        const res = await axios.get(dlUrl, { responseType: 'arraybuffer', timeout: 60000 });
        await react(mess.reactSuccess);
        const title  = data?.results?.title  || 'SoundCloud';
        const artist = data?.results?.artist || data?.results?.user?.username || '';
        await client.message.send(jid, {
          type: 'audio', media: Buffer.from(res.data), mimetype: 'audio/mpeg',
        });
        await reply(`🎵 *${title}*${artist ? `\n👤 ${artist}` : ''}`);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal download SoundCloud: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── sfilemobi — Sfile.mobi Search ────────────────────────────────────────
    case 'sfilemobi':
    case 'sfile': {
      const query = args.join(' ');
      if (!query) {
        await reply(`Masukkan kata kunci pencarian.\nContoh: *${p}sfile minecraft apk*`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/download/sfile-mobi`, {
          params: { query },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 30000,
        });
        const results = data?.results?.results;
        if (!results || !results.length) throw new Error('Tidak ada hasil dari API');
        await react(mess.reactSuccess);
        let txt = `📦 *Sfile.mobi Results*\n\n`;
        for (const r of results.slice(0, 5)) {
          txt += `*${r.title || r.name || 'Unknown'}*\n`;
          if (r.size) txt += `Ukuran: ${r.size}\n`;
          if (r.url || r.link) txt += `Link: ${r.url || r.link}\n`;
          txt += '\n';
        }
        await reply(txt.trim());
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal search Sfile.mobi: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── sfileco — Sfile.co Downloader ────────────────────────────────────────
    case 'sfileco': {
      const url = args[0];
      if (!url) {
        await reply(`Masukkan link Sfile.co.\nContoh: *${p}sfileco https://sfile.co/...*`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/download/sfileco`, {
          params: { url },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 30000,
        });
        const dlUrl = data?.results?.download_url;
        if (!dlUrl) throw new Error('URL download tidak ditemukan');
        await react(mess.reactSuccess);
        await reply(`📦 *Sfile.co*\n\nLink download:\n${dlUrl}`);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal download Sfile.co: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── rednote — RedNote/Xiaohongshu Downloader ────────────────────────────
    case 'rednote':
    case 'xiaohongshu':
    case 'xhs': {
      const url = args[0];
      if (!url) {
        await reply(`Masukkan link RedNote/Xiaohongshu.\nContoh: *${p}rednote https://www.xiaohongshu.com/...*`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/download/rednote`, {
          params: { url },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 30000,
        });
        const videos = data?.results?.videos;
        if (!videos || !videos.length) throw new Error('Tidak ada video dari API');
        await react(mess.reactSuccess);
        for (const v of videos) {
          const dlUrl = v.url || v.download_url || v;
          if (!dlUrl) continue;
          const res = await axios.get(dlUrl, { responseType: 'arraybuffer', timeout: 60000 });
          const thumb = await genThumbnail(Buffer.from(res.data), 'video/mp4');
          await client.message.send(jid, { type: 'video', media: Buffer.from(res.data), mimetype: 'video/mp4', caption: `📕 *RedNote*`, ...(thumb ? { jpegThumbnail: thumb } : {}) });
        }
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal download RedNote: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── reddit — Reddit Downloader ───────────────────────────────────────────
    case 'reddit':
    case 'redditdl': {
      const url = args[0];
      if (!url) {
        await reply(`Masukkan link Reddit.\nContoh: *${p}reddit https://reddit.com/r/...*`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/download/reddit`, {
          params: { url },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 30000,
        });
        const videos = data?.results?.videos;
        if (!videos || !videos.length) throw new Error('Tidak ada video dari API');
        await react(mess.reactSuccess);
        const v = videos[0];
        const dlUrl = v.url || v.download_url || v;
        const res = await axios.get(dlUrl, { responseType: 'arraybuffer', timeout: 90000 });
        const title = data?.results?.title || '';
        const thumb = await genThumbnail(Buffer.from(res.data), 'video/mp4');
        await client.message.send(jid, {
          type: 'video', media: Buffer.from(res.data), mimetype: 'video/mp4',
          caption: `🤖 *Reddit*${title ? `\n${title}` : ''}`,
          ...(thumb ? { jpegThumbnail: thumb } : {}),
        });
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal download Reddit: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── twitter — Twitter/X Downloader ──────────────────────────────────────
    case 'twitter':
    case 'twit':
    case 'xdl': {
      const url = args[0];
      if (!url) {
        await reply(`Masukkan link Twitter/X.\nContoh: *${p}twitter https://x.com/...*`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/download/twitter`, {
          params: { url },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 30000,
        });
        const videos = data?.results?.videos;
        if (!videos || !videos.length) throw new Error('Tidak ada video dari API');
        await react(mess.reactSuccess);
        // Prefer highest quality
        const v = videos.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        const dlUrl = v.url || v.download_url;
        const res = await axios.get(dlUrl, { responseType: 'arraybuffer', timeout: 90000 });
        const buf = Buffer.from(res.data);

        // ponytail: video X sering datang tanpa track audio (klip hasil cut, durasi pas
        // 1 detik). WA nolak file kayak gitu walau isinya sehat — muncul "video tidak
        // dapat diputar". Remux passthrough + audio senyap = 0 re-encode, 0 turun kualitas.
        const bersih = await normalVideo(buf);

        const thumb = await genThumbnail(bersih, 'video/mp4');
        await client.message.send(jid, {
          type: 'video', media: bersih, mimetype: 'video/mp4',
          caption: `🐦 *Twitter/X*`,
          ...(thumb ? { jpegThumbnail: thumb } : {}),
        });
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal download Twitter: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── tiktok — TikTok Downloader ───────────────────────────────────────────
    case 'tiktok':
    case 'tiktokdl':
    case 'ttdl':
    case 'tt': {
      const url = args[0];
      if (!url) {
        await reply(`Masukkan link TikTok.\nContoh: *${p}tiktok https://vt.tiktok.com/...*`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        // Player API TikTok sering menggantung ~31 dtk lalu upstream balas 503.
        // Bot WA timeout 30 dtk → user cuma lihat "timeout". Lewat 9 dtk kita
        // lekas pindah ke sumber cadangan (snaptik.app, terukur ~0,6 dtk).
        const { data } = await axios.get(`${process.env.BASE_API}api/download/tiktok`, {
          params: { url },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 20000,
        });
        const res     = data?.results || {};
        const title   = res.title  || '';
        const author  = res.author?.nickname || '';
        const caption = `🎵 *TikTok*${title ? `\n${title}` : ''}${author ? `\n👤 ${author}` : ''}`;

        // ── Photomode (slide foto) → kirim tiap gambar ────────────────────────
        const images = (res.images || res.download || []).filter(Boolean);
        if (images.length) {
          await react(mess.reactSuccess);
          for (let i = 0; i < Math.min(images.length, 10); i++) {
            const imgUrl = images[i];
            const imgRes = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 60000 });
            const { buf, ct } = await jpegkan(Buffer.from(imgRes.data), imgRes.headers['content-type']);
            const thumb  = await genThumbnail(buf, ct);
            await client.message.send(jid, {
              type: 'image', media: buf, mimetype: ct,
              caption: `${caption}${images.length > 1 ? `\n🖼️ ${i + 1}/${images.length}` : ''}`,
              ...(thumb ? { jpegThumbnail: thumb } : {}),
            });
          }
          return true;
        }

        // ── Video biasa ───────────────────────────────────────────────────────
        const dlUrl = res.video?.no_watermark;
        if (!dlUrl) throw new Error('Media tidak ditemukan di response API');
        const vidRes = await axios.get(dlUrl, { responseType: 'arraybuffer', timeout: 90000 });
        await react(mess.reactSuccess);
        const vbuf  = Buffer.from(vidRes.data);
        const thumb = await genThumbnail(vbuf, 'video/mp4');
        await client.message.send(jid, {
          type: 'video', media: vbuf, mimetype: 'video/mp4',
          caption,
          ...(thumb ? { jpegThumbnail: thumb } : {}),
        });
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal download TikTok: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── ttsearch — Cari Video TikTok ────────────────────────────────────────
    case 'ttsearch': {
      // Region opsional di paling belakang: `.ttsearch mcqueen edit indo id`
      const REGIONS = ['ID','MY','SG','US','GB','JP','KR','TH','VN','PH','IN','BR','MX','TR','SA','AU','CA','DE','FR','IT','ES','NL','RU','CN','TW','HK'];
      let argsTt  = args.slice();
      let argRegion = null;
      const lastTt = String(argsTt[argsTt.length - 1] || '').toLowerCase();
      if (argsTt.length > 1 && REGIONS.includes(lastTt.toUpperCase()) && lastTt.length === 2) {
        argRegion = lastTt.toUpperCase();
        argsTt = argsTt.slice(0, -1);
      }
      const qTt = argsTt.join(' ').trim();
      if (!qTt) {
        await reply(`Penggunaan: *${p}ttsearch* <kata kunci> [region]\n`
          + `Contoh: *${p}ttsearch McQueen kece*\n`
          + `Contoh: *${p}ttsearch mcqueen edit indo id* → video dari Indonesia\n\n`
          + `_Kode region: ID MY SG US GB JP KR TH VN PH IN BR MX TR SA AU CA DE FR IT ES NL RU CN TW HK_\n`
          + `_Tanpa kode region = hasil global (umumnya video luar)._`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/search/tiktok-search`, {
          params: { q: qTt, ...(argRegion ? { region: argRegion } : {}) },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 45000,
        });
        const list = Array.isArray(data?.results) ? data.results : [];
        if (!list.length) throw new Error('Tidak ada video yang cocok');

        // Hasil API udah urut relevansi, jadi kalau nggak ada satu pun judul
        // yang cocok dengan kata kunci, jangan diacak — pakai peringkat API apa
        // adanya. Kecocokan judul cuma dipakai kalau memang ada yang nyambung.
        const scored  = pickTopVideos(list, qTt, list.length);
        const matched = scored.some(v => keyMatch(v.title, qTt));
        const top     = (matched ? scored : list).slice(0, 3);

        await react(mess.reactSuccess);
        const fs   = require('fs');
        const os   = require('os');
        const path = require('path');

        // CDN hasil search bawaan watermark TikTok. Ambil file asli (watermark-free)
        // lewat yt-dlp pakai link TikTok-nya. Kalau yt-dlp nggak ada/gagal → fallback
        // file CDN, lebih baik ada video daripada tidak.
        const ambilVideo = async v => {
          const link = v.tiktok_url;
          if (link) {
            const tmpl = path.join(os.tmpdir(), `tts_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.%(ext)s`);
            const dl = await runYtDlp(['-f', 'b[format_id!=download]', '-S', 'vcodec:h264',
                                                   '--no-playlist', '--no-warnings',
                                                   '--no-simulate', '--print', 'after_move:filepath', '-o', tmpl, link], 180000);
            const lines = dl.out.split('\n').map(s => s.trim()).filter(Boolean);
            const real  = lines.reverse().find(l => /\.(mp4|webm|mkv)$/i.test(l));
            if (real && fs.existsSync(real)) {
              const buf = fs.readFileSync(real);
              try { fs.unlinkSync(real); } catch {}
              return buf;
            }
          }
          const r = await axios.get(v.play_url, { responseType: 'arraybuffer', timeout: 90000 });
          return Buffer.from(r.data);
        };

        for (let n = 0; n < top.length; n++) {
          const v = top[n];
          const cap = `🎵 *TikTok Search* ${n + 1}/${top.length}${argRegion ? ` · 🌏 ${argRegion}` : ''}\n📝 ${String(v.title || '-').slice(0, 220)}\n👤 ${v.author || '-'}${v.duration ? ` · ⏱️ ${v.duration}` : ''}`;
          try {
            const vbuf  = await ambilVideo(v);
            const thumb = await genThumbnail(vbuf, 'video/mp4');
            await client.message.send(jid, {
              type: 'video', media: vbuf, mimetype: 'video/mp4',
              caption: cap,
              ...(thumb ? { jpegThumbnail: thumb } : {}),
            });
          } catch {
            // video gagal diunduh → jangan hilangkan hasilnya, kirim link aslinya
            await reply(`${cap}\n🔗 ${v.tiktok_url || v.play_url}`);
          }
        }
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal cari video TikTok: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── pinterest — Pinterest Downloader ────────────────────────────────────
    case 'pindl': {
      const url = args[0];
      if (!url) {
        await reply(`Masukkan link Pinterest.\nContoh: *${p}pindl https://pinterest.com/pin/...*`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/download/pinterest`, {
          params: { url },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 30000,
        });
        const images = data?.results?.images;
        if (!images || !images.length) throw new Error('Tidak ada gambar dari API');
        await react(mess.reactSuccess);
        for (const img of images.slice(0, 5)) {
          const imgUrl = img.url || img.download_url || img;
          if (!imgUrl) continue;
          const res = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 30000 });
          const { buf, ct } = await jpegkan(Buffer.from(res.data), res.headers['content-type']);
          const thumb = await genThumbnail(buf, ct);
          await client.message.send(jid, { type: 'image', media: buf, mimetype: ct, caption: `📌 *Pinterest*`, ...(thumb ? { jpegThumbnail: thumb } : {}) });
        }
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal download Pinterest: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── threads — Threads Downloader ─────────────────────────────────────────
    case 'threads':
    case 'threadsdl': {
      const url = args[0];
      if (!url) {
        await reply(`Masukkan link Threads.\nContoh: *${p}threads https://www.threads.net/...*`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/download/threads`, {
          params: { url },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 30000,
        });
        const medias = data?.results?.medias;
        if (!medias || !medias.length) throw new Error('Tidak ada media dari API');
        await react(mess.reactSuccess);
        for (const m of medias) {
          const dlUrl = m.url || m.download_url || m;
          if (!dlUrl) continue;
          const res = await axios.get(dlUrl, { responseType: 'arraybuffer', timeout: 60000 });
          const ct  = res.headers['content-type'] || 'image/jpeg';
          if (ct.startsWith('video/')) {
            const thumb = await genThumbnail(Buffer.from(res.data), ct);
            await client.message.send(jid, { type: 'video', media: Buffer.from(res.data), mimetype: ct, caption: `🧵 *Threads*`, ...(thumb ? { jpegThumbnail: thumb } : {}) });
          } else {
            const { buf, ct } = await jpegkan(Buffer.from(res.data), ct);
            const thumb = await genThumbnail(buf, ct);
            await client.message.send(jid, { type: 'image', media: buf, mimetype: ct, caption: `🧵 *Threads*`, ...(thumb ? { jpegThumbnail: thumb } : {}) });
          }
        }
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal download Threads: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── youtube — YouTube Downloader ─────────────────────────────────────────
    case 'youtube':
    case 'ytdl':
    case 'yt': {
      const url  = args[0];
      const mode = (args[1] || 'video').toLowerCase(); // video | audio
      if (!url) {
        await reply(`Masukkan link YouTube.\nContoh:\n• *${p}yt https://youtu.be/... video*\n• *${p}yt https://youtu.be/... audio*`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/download/youtube`, {
          params: { url },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 60000,
        });
        const title = data?.results?.title || 'YouTube';
        if (mode === 'audio') {
          const audios = data?.results?.audios;
          if (!audios || !audios.length) throw new Error('Tidak ada audio dari API');
          const a = audios[0];
          const dlUrl = a.url || a.download_url;
          const res = await axios.get(dlUrl, { responseType: 'arraybuffer', timeout: 90000 });
          await react(mess.reactSuccess);
          await client.message.send(jid, { type: 'audio', media: Buffer.from(res.data), mimetype: 'audio/mpeg' });
          await reply(`🎵 *${title}*`);
        } else {
          const videos = data?.results?.videos;
          if (!videos || !videos.length) throw new Error('Tidak ada video dari API');
          // Format video-only (DASH) nggak bisa ditempel di sini tanpa ffmpeg —
          // dan yang dipilih `videos[0]` dulu malah HLS (isinya manifest .m3u8,
          // bukan video). Wajib yang `has_audio`: satu file video+suara.
          const ringan = q => q && (q.includes('360') || q.includes('480'));
          const v = videos.find(x => x.has_audio && ringan(x.quality))
                 || videos.find(x => x.has_audio)
                 || videos.find(x => ringan(x.quality))
                 || videos[0];
          const dlUrl = v.url || v.download_url;
          const res = await axios.get(dlUrl, { responseType: 'arraybuffer', timeout: 120000 });
          await react(mess.reactSuccess);
          const thumb = await genThumbnail(Buffer.from(res.data), 'video/mp4');
          await client.message.send(jid, {
            type: 'video', media: Buffer.from(res.data), mimetype: 'video/mp4',
            caption: `▶️ *${title}*${v.quality ? ` [${v.quality}]` : ''}`,
            ...(thumb ? { jpegThumbnail: thumb } : {}),
          });
        }
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal download YouTube: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── gdrive — Google Drive Downloader ────────────────────────────────────
    case 'gdrive':
    case 'gdrivedl': {
      const url = args[0];
      if (!url) {
        await reply(`Masukkan link Google Drive.\nContoh: *${p}gdrive https://drive.google.com/...*`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/download/gdrive`, {
          params: { url },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 30000,
        });
        const dlUrl = data?.results?.download_url;
        if (!dlUrl) throw new Error('URL download tidak ditemukan');
        await react(mess.reactSuccess);
        await reply(`📂 *Google Drive*\n\nLink download:\n${dlUrl}`);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal download Google Drive: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── instagram — Instagram Downloader ────────────────────────────────────
    case 'instagram':
    case 'igdl':
    case 'ig': {
      const url = args[0];
      if (!url) {
        await reply(`Masukkan link Instagram.\nContoh: *${p}ig https://www.instagram.com/p/...*`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/download/instagram`, {
          params: { url },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 30000,
        });
        const r = data?.results;
        const rd = r?.results || r;
        // 3 bentuk: carousel -> slides[]; reel/video -> video.*/video_url; photo -> thumbnails.full
        const pickVid = v => (v && (v.best || v.hd || v.sd)) || (typeof v === 'string' ? v : null);
        const caption = (rd?.caption || '').trim().slice(0, 700);
        // detail post: author + engagement + tanggal
        const au = rd?.author || {};
        const nfmt = n => (n == null || n === '' ? null : Number(n).toLocaleString('id-ID'));
        const meta = [];
        if (au.username) meta.push(`\u{1F464} *${au.username}*${au.is_verified ? ' \u{2714}\u{FE0F}' : ''}${au.full_name && au.full_name !== au.username ? ' \u{2022} ' + au.full_name : ''}`);
        const eng = [nfmt(rd?.like_count) ? `\u{2764}\u{FE0F} ${nfmt(rd.like_count)}` : null, nfmt(rd?.comment_count) ? `\u{1F4AC} ${nfmt(rd.comment_count)}` : null].filter(Boolean).join('   ');
        if (eng) meta.push(eng);
        if (rd?.posted_at) {
          try { meta.push(`\u{1F4C5} ${new Date(rd.posted_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}`); } catch {}
        }
        const metaTxt = meta.join('\n');
        let items = [];
        const slides = Array.isArray(rd?.slides) ? rd.slides : null;
        if (slides && slides.length) {
          items = slides.map(s => {
            const isVid = s.media_type === 'video' || !!s.video;
            return { url: (isVid ? (pickVid(s.video) || s.url) : (s.url || s.thumbnails?.full)), isVideo: isVid };
          });
        } else {
          const vid = pickVid(rd?.video) || rd?.video_url;
          const img = rd?.thumbnails?.full || rd?.thumbnail_url;
          if (vid) items.push({ url: vid, isVideo: true });
          else if (img) items.push({ url: img, isVideo: false });
        }
        items = items.filter(it => it.url);
        if (!items.length) throw new Error('Tidak ada media dari API');
        await react(mess.reactSuccess);
        // CDN Instagram (scontent) kadang nolak connect sesaat (ETIMEDOUT), dan VPS ini
        // nggak punya rute IPv6 (ENETUNREACH) -> kunci IPv4 + ulang sekali.
        const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        const unduh = async (url) => {
          let last;
          for (let i = 0; i < 2; i++) {
            try {
              return await axios.get(url, {
                responseType: 'arraybuffer', timeout: 60000, family: 4,
                headers: { 'User-Agent': UA },
              });
            } catch (e) { last = e; await new Promise(r => setTimeout(r, 1000)); }
          }
          throw new Error(String(last?.response?.status || last?.code || last?.message || 'unknown').slice(0, 140));
        };
        let n = 0, terkirim = 0;
        const gagal = [];
        const total = items.length;
        for (const it of items) {
          n++;
          let res;
          try { res = await unduh(it.url); }
          catch (e) { gagal.push(`#${n} unduh ${e.message}`); continue; }
          const ct  = res.headers['content-type'] || (it.isVideo ? 'video/mp4' : 'image/jpeg');
          const isVid = ct.startsWith('video/') || it.isVideo;
          const thumb = await genThumbnail(Buffer.from(res.data), isVid ? 'video/mp4' : ct);
          const cap = n === 1
            ? `\u{1F4F7} *Instagram*` + (metaTxt ? `\n\n${metaTxt}` : '') + (total > 1 ? `\n${'\u{1F4F7}'} 1 / ${total}` : '') + (caption ? `\n\n${caption}` : '')
            : `\u{1F4F7} ${n} / ${total}`;
          try {
            await client.message.send(jid, {
              type: isVid ? 'video' : 'image',
              media: Buffer.from(res.data),
              mimetype: isVid ? (ct.startsWith('video/') ? ct : 'video/mp4') : ct,
              caption: cap,
              ...(thumb ? { jpegThumbnail: thumb } : {}),
            });
            terkirim++;
          } catch (e) { gagal.push(`#${n} kirim ${e.message}`); }
        }
        // Jangan pernah "centang tapi sepi": kalau SEMUA media gagal, user harus tau
        // alasannya. Dulu `catch { continue; }` bikin media ilang tanpa jejak sama sekali.
        console.log(`[ig] ${terkirim}/${total} terkirim${gagal.length ? ' — ' + gagal.join('; ') : ''}`);
        if (!terkirim) {
          const uniq = [...new Set(gagal.map(g => g.replace(/^#\d+ /, '')))];
          await reply(`❌ Gagal Instagram (${total} media):\n${uniq.join('\n')}`);
        }
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal download Instagram: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── stalktiktok — Stalk TikTok Profile ──────────────────────────────────
    case 'stalktiktok':
    case 'stalktt':
    case 'tiktokstalk': {
      const username = args[0]?.replace('@', '');
      if (!username) { await reply(`Penggunaan: ${p}stalktiktok <username>`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const { data } = await axios.get(`${process.env.BASE_API}api/stalker/tiktok`, {
          params: { username }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = data?.results;
        if (!d) throw new Error('User tidak ditemukan');
        let text = `🎵 *TikTok Stalker*\n\n`;
        text += `👤 *Username:* @${d.username}\n`;
        text += `📛 *Nama:* ${d.name || '-'}\n`;
        text += `👥 *Followers:* ${d.followers || '-'}\n`;
        text += `➡️ *Following:* ${d.following || '-'}\n`;
        text += `❤️ *Hearts:* ${d.hearts || '-'}\n`;
        text += `🎬 *Videos:* ${d.videos || '-'}\n`;
        text += `🫂 *Friends:* ${d.friends || '-'}\n`;
        if (d.accountCreated) text += `📅 *Dibuat:* ${d.accountCreated}\n`;
        if (d.photoProfile) {
          const res = await axios.get(d.photoProfile, { responseType: 'arraybuffer', timeout: 15000 });
          await client.message.send(jid, { type: 'image', media: Buffer.from(res.data), mimetype: 'image/jpeg', caption: text.trim() });
        } else {
          await reply(text.trim());
        }
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── roblox — Stalk Roblox Profile ───────────────────────────────────────
    case 'roblox': {
      const username = args[0];
      if (!username) { await reply(`Penggunaan: ${p}roblox <username>`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const { data } = await axios.get(`${process.env.BASE_API}api/stalker/roblox`, {
          params: { username }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = data?.results;
        if (!d) throw new Error('User tidak ditemukan');
        let text = `🎮 *Roblox Stalker*\n\n`;
        text += `👤 *Username:* ${d.username}\n`;
        text += `📛 *Display Name:* ${d.display_name || '-'}\n`;
        text += `🆔 *ID:* ${d.id}\n`;
        text += `👥 *Followers:* ${(d.followers_count || 0).toLocaleString()}\n`;
        text += `➡️ *Following:* ${(d.following_count || 0).toLocaleString()}\n`;
        text += `🫂 *Friends:* ${(d.friends_count || 0).toLocaleString()}\n`;
        text += `🟢 *Status:* ${d.presence || '-'}\n`;
        text += `🚫 *Banned:* ${d.is_banned ? 'Ya' : 'Tidak'}\n`;
        if (d.created) text += `📅 *Dibuat:* ${new Date(d.created).toLocaleDateString('id-ID')}\n`;
        if (d.profile_url) text += `🔗 ${d.profile_url}\n`;
        const avatarUrl = d.avatar_headshot || d.avatar_full;
        if (avatarUrl) {
          const res = await axios.get(avatarUrl, { responseType: 'arraybuffer', timeout: 15000 });
          await client.message.send(jid, { type: 'image', media: Buffer.from(res.data), mimetype: 'image/png', caption: text.trim() });
        } else {
          await reply(text.trim());
        }
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── minecraft — Stalk Minecraft Profile ─────────────────────────────────
    case 'minecraft':
    case 'mc':
    case 'stalkmc': {
      const username = args[0];
      if (!username) { await reply(`Penggunaan: ${p}minecraft <username>`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const { data } = await axios.get(`${process.env.BASE_API}api/stalker/minecraft`, {
          params: { username }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = data?.results;
        if (!d) throw new Error('User tidak ditemukan');
        let text = `⛏️ *Minecraft Stalker*\n\n`;
        text += `👤 *Username:* ${d.username}\n`;
        text += `🆔 *UUID:* ${d.uuid || '-'}\n`;
        text += `🎨 *Skin Model:* ${d.skin_model || '-'}\n`;
        if (d.body_url) text += `🔗 *Body:* ${d.body_url}\n`;
        const imgUrl = d.body_url || d.head_url || d.skin_render_url;
        if (imgUrl) {
          const res = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 15000 });
          const { buf, ct } = await jpegkan(Buffer.from(res.data), res.headers['content-type']);
          await client.message.send(jid, { type: 'image', media: buf, mimetype: ct, caption: text.trim() });
        } else {
          await reply(text.trim());
        }
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── github — Stalk GitHub Profile ───────────────────────────────────────
    case 'stalkgithub':
    case 'ghstalk': {
      const username = args[0];
      if (!username) { await reply(`Penggunaan: ${p}ghstalk <username>`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const { data } = await axios.get(`${process.env.BASE_API}api/stalker/github`, {
          params: { username }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = data?.results?.profile;
        if (!d) throw new Error('User tidak ditemukan');
        const repos = data?.results?.repos || [];
        let text = `🐙 *GitHub Stalker*\n\n`;
        text += `👤 *Username:* ${d.login}\n`;
        if (d.name) text += `📛 *Nama:* ${d.name}\n`;
        if (d.bio) text += `📝 *Bio:* ${d.bio}\n`;
        if (d.location) text += `📍 *Lokasi:* ${d.location}\n`;
        text += `👥 *Followers:* ${d.followersFormatted || d.followers}\n`;
        text += `➡️ *Following:* ${d.followingFormatted || d.following}\n`;
        text += `📦 *Public Repos:* ${d.publicReposFormatted || d.publicRepos}\n`;
        if (d.type) text += `🏷️ *Tipe:* ${d.type}\n`;
        if (d.createdAt) text += `📅 *Dibuat:* ${new Date(d.createdAt).toLocaleDateString('id-ID')}\n`;
        if (d.url) text += `🔗 ${d.url}\n`;
        if (repos.length) {
          text += `\n📂 *Repo Terbaru:*\n`;
          repos.slice(0, 3).forEach(r => {
            text += `• ${r.name}${r.language ? ` (${r.language})` : ''} ⭐${r.stars}\n`;
          });
        }
        if (d.avatar) {
          const res = await axios.get(d.avatar, { responseType: 'arraybuffer', timeout: 15000 });
          await client.message.send(jid, { type: 'image', media: Buffer.from(res.data), mimetype: 'image/png', caption: text.trim() });
        } else {
          await reply(text.trim());
        }
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── genshin — Stalk Genshin Impact ──────────────────────────────────────
    case 'genshin':
    case 'stalkgenshin': {
      const uid = args[0];
      if (!uid) { await reply(`Penggunaan: ${p}genshin <uid>`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const { data } = await axios.get(`${process.env.BASE_API}api/stalker/genshin`, {
          params: { uid }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 20000,
        });
        const d = data?.results;
        if (!d) throw new Error('UID tidak ditemukan');
        const p2 = d.profil || {};
        let text = `🌟 *Genshin Impact Stalker*\n\n`;
        text += `🆔 *UID:* ${d.uid}\n`;
        text += `👤 *Nickname:* ${p2.nickname || '-'}\n`;
        text += `⚡ *Level:* ${p2.level || '-'}\n`;
        text += `🌍 *World Level:* ${p2.world_level || '-'}\n`;
        text += `🏆 *Achievement:* ${p2.achievement || '-'}\n`;
        text += `⚔️ *Spiral Abyss:* ${p2.abyss || '-'}\n`;
        text += `👥 *Total Karakter:* ${p2.karakter_total || '-'}\n`;
        if (p2.signature) text += `📝 *Bio:* ${p2.signature}\n`;
        const showcase = d.karakter_showcase || [];
        if (showcase.length) {
          text += `\n🎭 *Showcase (${showcase.length} karakter):*\n`;
          showcase.slice(0, 4).forEach(k => {
            text += `• ID ${k.avatar_id} | Lv.${k.level} | C${k.constellation} | ❤️${k.friendship}\n`;
          });
        }
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── freefire — Stalk Free Fire ───────────────────────────────────────────
    case 'freefire':
    case 'ff':
    case 'stalkff': {
      const uid = args[0];
      if (!uid) { await reply(`Penggunaan: ${p}freefire <uid>`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const { data } = await axios.get(`${process.env.BASE_API}api/stalker/freefire`, {
          params: { uid }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 20000,
        });
        const d = data?.results?.player;
        if (!d) throw new Error('UID tidak ditemukan');
        const ban = data?.results?.ban || {};
        const pet = data?.results?.pet || {};
        let text = `🔫 *Free Fire Stalker*\n\n`;
        text += `👤 *Nickname:* ${d.nickname || '-'}\n`;
        text += `🆔 *ID:* ${d.accountId}\n`;
        text += `🌍 *Region:* ${d.region || '-'}\n`;
        text += `⚡ *Level:* ${d.level || '-'}\n`;
        text += `🏆 *Rank:* ${d.rank || '-'} (${d.rankingPoints || 0} pts)\n`;
        text += `❤️ *Liked:* ${(d.liked || 0).toLocaleString()}\n`;
        text += `🚫 *Banned:* ${ban.isBanned ? `Ya (${ban.status})` : 'Tidak'}\n`;
        if (d.equippedCharacter) text += `🎭 *Karakter:* ${d.equippedCharacter.name}\n`;
        if (pet.name) text += `🐾 *Pet:* ${pet.name} (${pet.speciesName})\n`;
        await reply(text.trim());
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── discord — Stalk Discord User ─────────────────────────────────────────
    case 'discord':
    case 'stalkdiscord': {
      const userid = args[0];
      if (!userid) { await reply(`Penggunaan: ${p}discord <user_id>`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const { data } = await axios.get(`${process.env.BASE_API}api/stalker/discord`, {
          params: { userid }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = data?.results;
        if (!d) throw new Error('User tidak ditemukan');
        let text = `💬 *Discord Stalker*\n\n`;
        text += `🆔 *User ID:* ${d.user_id}\n`;
        text += `👤 *Username:* ${d.global_name || '-'}\n`;
        text += `📛 *Display Name:* ${d.display_name || '-'}\n`;
        text += `🏅 *Badges:* ${d.badges || '-'}\n`;
        if (d.created) text += `📅 *Dibuat:* ${d.created}\n`;
        if (d.avatar) {
          const res = await axios.get(d.avatar, { responseType: 'arraybuffer', timeout: 15000 });
          await client.message.send(jid, { type: 'image', media: Buffer.from(res.data), mimetype: 'image/png', caption: text.trim() });
        } else {
          await reply(text.trim());
        }
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── chess — Stalk Chess.com Profile ──────────────────────────────────────
    case 'chess':
    case 'stalkchess': {
      const username = args[0];
      if (!username) { await reply(`Penggunaan: ${p}chess <username>`); return true; }
      try {
        await react(mess.reactLoading);
        const axios = require('axios');
        const { data } = await axios.get(`${process.env.BASE_API}api/stalker/chess`, {
          params: { username }, headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const d = data?.results;
        if (!d) throw new Error('User tidak ditemukan');
        const r = d.ratings || {};
        let text = `♟️ *Chess.com Stalker*\n\n`;
        text += `👤 *Username:* ${d.username}\n`;
        if (d.name) text += `📛 *Nama:* ${d.name}\n`;
        if (d.title) text += `🏅 *Title:* ${d.title}\n`;
        if (d.location) text += `📍 *Lokasi:* ${d.location}\n`;
        text += `👥 *Followers:* ${(d.followers || 0).toLocaleString()}\n`;
        text += `📅 *Joined:* ${d.joined || '-'}\n`;
        text += `🟢 *Last Online:* ${d.last_online || '-'}\n`;
        if (r.chess_blitz?.last?.rating) text += `⚡ *Blitz:* ${r.chess_blitz.last.rating}\n`;
        if (r.chess_rapid?.last?.rating) text += `🕐 *Rapid:* ${r.chess_rapid.last.rating}\n`;
        if (r.chess_bullet?.last?.rating) text += `🚀 *Bullet:* ${r.chess_bullet.last.rating}\n`;
        if (d.url) text += `🔗 ${d.url}\n`;
        if (d.avatar) {
          const res = await axios.get(d.avatar, { responseType: 'arraybuffer', timeout: 15000 });
          await client.message.send(jid, { type: 'image', media: Buffer.from(res.data), mimetype: 'image/png', caption: text.trim() });
        } else {
          await reply(text.trim());
        }
        await react(mess.reactSuccess);
      } catch (e) { await react(mess.reactError); await reply(`${mess.error}\n${e.message}`); }
      return true;
    }

    // ── kuaishou — Kuaishou Downloader ───────────────────────────────────────
    case 'kuaishou':
    case 'kwai':
    case 'kuaishoudl': {
      const url = args[0];
      if (!url) {
        await reply(`Masukkan link Kuaishou/Kwai.\nContoh: *${p}kuaishou https://v.kuaishou.com/...*`);
        return true;
      }
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/download/kuaishou`, {
          params: { url },
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 30000,
        });
        const videos = data?.results?.videos;
        if (!videos || !videos.length) throw new Error('Tidak ada video dari API');
        await react(mess.reactSuccess);
        const v = videos[0];
        const dlUrl = v.url || v.download_url || v;
        const res = await axios.get(dlUrl, { responseType: 'arraybuffer', timeout: 90000 });
        const title = data?.results?.title || '';
        const thumb = await genThumbnail(Buffer.from(res.data), 'video/mp4');
        await client.message.send(jid, {
          type: 'video', media: Buffer.from(res.data), mimetype: 'video/mp4',
          caption: `⚡ *Kuaishou*${title ? `\n${title}` : ''}`,
          ...(thumb ? { jpegThumbnail: thumb } : {}),
        });
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal download Kuaishou: ${rapikanError(e)}`);
      }
      return true;
    }

    // ════════════════════════════════════════════════════════════════════════
    // RANDOM COMMANDS
    // ════════════════════════════════════════════════════════════════════════

    // ── aceh — Kata Bijak Aceh ───────────────────────────────────────────────
    case 'aceh':
    case 'kataaceh': {
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/random/aceh`, {
          headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const r = data?.results;
        await react(mess.reactSuccess);
        await reply(`🏝️ *Kata Bijak Aceh*\n\n_"${r?.kata}"_\n\n📖 ${r?.arti}`);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal ambil kata Aceh: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── batak — Kata Bijak Batak ─────────────────────────────────────────────
    case 'batak':
    case 'katabatak': {
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/random/batak`, {
          headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const r = data?.results;
        await react(mess.reactSuccess);
        await reply(`⛰️ *Kata Bijak Batak*\n\n_"${r}"_`);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal ambil kata Batak: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── bijak — Kata Bijak ───────────────────────────────────────────────────
    case 'bijak':
    case 'kataBijak': {
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/random/bijak`, {
          headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const r = data?.results;
        await react(mess.reactSuccess);
        await reply(`💡 *Kata Bijak*\n\n_"${r?.kata}"_${r?.penulis ? `\n\n— ${r.penulis}` : ''}`);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal ambil kata bijak: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── china — Peribahasa China ─────────────────────────────────────────────
    case 'china':
    case 'peribahasa china':
    case 'katachina': {
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/random/china`, {
          headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const r = data?.results;
        await react(mess.reactSuccess);
        await reply(`🇨🇳 *Peribahasa China*\n\n${r?.china}\n_${r?.latin}_\n\n📖 ${r?.arti}`);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal ambil kata China: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── dare — Dare/Tantangan ────────────────────────────────────────────────
    case 'dare':
    case 'tantangan': {
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/random/dare`, {
          headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const r = data?.results;
        await react(mess.reactSuccess);
        await reply(`🎯 *Dare / Tantangan*\n\n${r}`);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal ambil dare: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── fakta — Fakta Unik ───────────────────────────────────────────────────
    case 'fakta':
    case 'faktaunik': {
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/random/fakta`, {
          headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const r = data?.results;
        await react(mess.reactSuccess);
        await reply(`🧠 *Fakta Unik*\n\n${r}`);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal ambil fakta: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── fiersa — Quotes Fiersa Besari ────────────────────────────────────────
    case 'fiersa':
    case 'fiersabesari': {
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/random/fiersa`, {
          headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const r = data?.results;
        await react(mess.reactSuccess);
        await reply(`✍️ *Fiersa Besari*\n\n_"${r}"_`);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal ambil quote Fiersa: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── jawa — Pepatah Jawa ──────────────────────────────────────────────────
    case 'jawa':
    case 'pepatahjawa':
    case 'katajawa': {
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/random/jawa`, {
          headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const r = data?.results;
        await react(mess.reactSuccess);
        await reply(`🏔️ *Pepatah Jawa*${r?.jenis ? ` _(${r.jenis})_` : ''}\n\n_"${r?.kata}"_\n\n📖 ${r?.arti}`);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal ambil kata Jawa: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── katabucin — Kata Bucin ───────────────────────────────────────────────
    case 'katabucin':
    case 'bucin': {
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/random/katabucin`, {
          headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const r = data?.results;
        await react(mess.reactSuccess);
        const txt = r?.indonesia
          ? `💕 *Kata Bucin*\n\n🇮🇩 ${r.indonesia}${r?.jawa ? `\n\n☕ _${r.jawa}_` : ''}`
          : `💕 *Kata Bucin*\n\n${r}`;
        await reply(txt);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal ambil kata bucin: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── katasore — Kata Sore ─────────────────────────────────────────────────
    case 'katasore':
    case 'sore': {
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/random/katasore`, {
          headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const r = data?.results;
        await react(mess.reactSuccess);
        await reply(`🌅 *Kata Sore*\n\n_"${r}"_`);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal ambil kata sore: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── minangkabau — Kata Minangkabau ───────────────────────────────────────
    case 'minangkabau':
    case 'minang':
    case 'kataminang': {
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/random/minangkabau`, {
          headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const r = data?.results;
        await react(mess.reactSuccess);
        await reply(`🏡 *Kata Minangkabau*\n\n_"${r?.kata}"_\n\n📖 ${r?.arti}`);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal ambil kata Minang: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── motivasi — Kata Motivasi ─────────────────────────────────────────────
    case 'motivasi':
    case 'katamotivasi': {
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/random/motivasi`, {
          headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const r = data?.results;
        await react(mess.reactSuccess);
        await reply(`🔥 *Motivasi*\n\n_"${r}"_`);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal ambil motivasi: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── ngeles — Kata Ngeles ─────────────────────────────────────────────────
    case 'ngeles':
    case 'alasan': {
      try {
        const axios = require('axios');
        await react(mess.reactLoading);
        const { data } = await axios.get(`${process.env.BASE_API}api/random/ngeles`, {
          headers: { 'X-API-Key': process.env.KEY_API }, timeout: 15000,
        });
        const r = data?.results;
        await react(mess.reactSuccess);
        await reply(`😅 *Kata Ngeles*\n\n_"${r?.kata || r}"_`);
      } catch (e) {
        await react(mess.reactError);
        await reply(`❌ Gagal ambil kata ngeles: ${rapikanError(e)}`);
      }
      return true;
    }

    default:
      return false;
  }
};

// Diekspor biar tesnya pakai logika yang sama, bukan salinan yang bisa melenceng.
module.exports.pickTopVideos = pickTopVideos;
module.exports.keyMatch      = keyMatch;

// Command yang kena limit untuk user biasa
module.exports.limitedCmds = new Set([
  'sticker','s','wm','poll','readmore','base64','kalkulator','removebg','rbg',
  'harga','saham','crypto','koin','forex','kurs','emas','gold',
  'pick','tourl','upload','pay','rvo','readviewonce','readvo',
  'tovn','2vo','todoc',
  'tanyaimg','ailyrics','buatlirik','chatgpt','gpt','resetgpt','gemini','resetgemini','toghibli','ghibli','ai','deepai','resetdeepai',
  // downloader commands
  'mediafire','mfdl',
  'likee','likeedl',
  'moddroid','moddroiddl',
  'facebook','fbdl','fb',
  'tgsticker','telesticker','stele',
  'spotifydl',
  'soundcloud','scdl',
  'sfilemobi','sfile',
  'sfileco',
  'rednote','xiaohongshu','xhs',
  'reddit','redditdl',
  'twitter','twit','xdl',
  'tiktok','tiktokdl','ttdl','tt',
  'pindl',
  'threads','threadsdl',
  'youtube','ytdl','yt',
  'gdrive','gdrivedl',
  'instagram','igdl','ig',
  'kuaishou','kwai','kuaishoudl',
  // RPG: tambang, craft, kejahatan
  'tambang','kebon','tebang','bahan','craft',
  'skill','penjara','bebaskan','copet','rampok',
]);
