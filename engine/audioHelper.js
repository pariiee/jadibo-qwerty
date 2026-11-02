const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CACHE_DIR = path.resolve(__dirname, '../data/audio_cache');
if (!fs.existsSync(CACHE_DIR)) {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
}

const inflightAudioDownloads = new Map();

function runYtDlp(argv, timeoutMs = 180000) {
  return new Promise(resolve => {
    let out = '', err = '', done = false, ch;
    try {
      ch = spawn('yt-dlp', argv);
    } catch (e) {
      return resolve({ ok: false, out: '', err: String(e.message), missing: true });
    }
    const timer = setTimeout(() => {
      try { ch.kill('SIGKILL'); } catch {}
      finish({ ok: false, out, err: err + ' [timeout]' });
    }, timeoutMs);

    const finish = r => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(r);
      }
    };
    ch.stdout.on('data', d => { out += d; });
    ch.stderr.on('data', d => { err += d; });
    ch.on('error', e => finish({ ok: false, out, err: String(e.message), missing: e.code === 'ENOENT' }));
    ch.on('close', code => finish({ ok: code === 0, out, err }));
  });
}

async function ambilAudioLagu(kueri) {
  const qClean = String(kueri || '').trim();
  if (!qClean) return { ok: false, alasan: 'Judul lagu tidak boleh kosong' };

  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

  // 1) Cari kandidat via yt-dlp
  let pick = null;
  const isDirectUrl = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(qClean);
  const searchArg = isDirectUrl ? qClean : `ytsearch10:${qClean}`;

  const srch = await runYtDlp(['--flat-playlist', '--no-warnings', '-J', searchArg], 90000);
  if (srch.ok) {
    let list = [];
    try {
      const parsed = JSON.parse(srch.out);
      list = parsed.entries || (parsed.id ? [parsed] : []);
    } catch {}
    const tokens = norm(qClean).split(' ').filter(t => t.length > 1);
    const scored = list
      .filter(e => e && e.id && !e.is_live && Number.isFinite(e.duration))
      .filter(e => e.duration >= 20 && e.duration <= 900)
      .map(e => {
        const t = norm(e.title);
        const hit = tokens.filter(tk => t.includes(tk)).length;
        return { ...e, _ratio: tokens.length ? hit / tokens.length : 0 };
      })
      .sort((a, b) => (b._ratio - a._ratio) || (a.duration - b.duration));

    pick = scored[0]
        || list.find(e => e && e.id && Number.isFinite(e.duration) && e.duration <= 3600)
        || list[0]
        || null;
  }

  // 2) Cek cache lokal berdasarkan YouTube ID
  if (pick?.id) {
    const cacheAudio = path.join(CACHE_DIR, `${pick.id}.mp3`);
    const cacheMeta  = path.join(CACHE_DIR, `${pick.id}.json`);
    if (fs.existsSync(cacheAudio) && fs.existsSync(cacheMeta)) {
      try {
        const meta = JSON.parse(fs.readFileSync(cacheMeta, 'utf8'));
        return {
          ok: true,
          buf: fs.readFileSync(cacheAudio),
          filePath: cacheAudio,
          mime: 'audio/mpeg',
          title: meta.title || pick.title,
          artist: meta.artist || pick.uploader,
          dur: meta.dur || '',
          url: `https://www.youtube.com/watch?v=${pick.id}`,
          cached: true,
        };
      } catch {}
    }

    if (inflightAudioDownloads.has(pick.id)) {
      return await inflightAudioDownloads.get(pick.id);
    }
  }

  // 3) Fallback jika yt-dlp binary tidak tersedia
  if (!pick) {
    try {
      const axios = require('axios');
      const search = require('yt-search');
      const look = await search(qClean);
      const conv = (look.videos || []).filter(v => v.seconds >= 20 && v.seconds <= 900)[0] || look.videos?.[0];
      if (!conv) return { ok: false, alasan: 'Lagu tidak ditemukan di YouTube' };

      const mp3 = await axios.get(`${process.env.BASE_API || 'http://163.172.110.146:2280/'}api/download/ytmp3`, {
        params: { url: conv.url },
        headers: { 'X-API-Key': process.env.KEY_API || '' },
        timeout: 60000,
      });
      const d = mp3.data?.results;
      if (!d?.audio?.url) return { ok: false, alasan: 'Audio konverter tidak tersedia' };
      const chosen = (Array.isArray(d.audios) ? d.audios.find(a => a.format === 'm4a') : null) || d.audio;
      const res = await axios.get(chosen.url, { responseType: 'arraybuffer', timeout: 120000 });

      return {
        ok: true,
        buf: Buffer.from(res.data),
        mime: chosen.format === 'm4a' ? 'audio/mp4' : 'audio/mpeg',
        title: d.title || conv.title,
        artist: d.channel || conv.author?.name,
        dur: d.duration_str || conv.timestamp,
        url: conv.url,
      };
    } catch (eFallback) {
      return { ok: false, alasan: eFallback.message || 'Gagal mencari lagu' };
    }
  }

  // 4) Download via yt-dlp lokal
  const doDownload = async () => {
    try {
      const tmpl = path.join(os.tmpdir(), `play_${Date.now()}.%(ext)s`);
      const dl = await runYtDlp([
        '-f', 'bestaudio[ext=m4a]/bestaudio',
        '--no-playlist',
        '--no-warnings',
        '--no-simulate',
        '--print', 'after_move:filepath',
        '-o', tmpl,
        pick.id
      ], 240000);

      const filePath = (dl.out || '').trim().split('\n').pop().trim();
      if (!dl.ok || !filePath || !fs.existsSync(filePath)) throw new Error('Gagal mengunduh stream audio yt-dlp');
      const rawBuf = fs.readFileSync(filePath);
      try { fs.unlinkSync(filePath); } catch {}

      // Convert ke MP3 via FFmpeg
      const tmpIn = path.join(os.tmpdir(), `play_in_${Date.now()}`);
      const tmpOut = path.join(os.tmpdir(), `play_out_${Date.now()}.mp3`);
      fs.writeFileSync(tmpIn, rawBuf);
      let finalBuf = rawBuf;
      let ffOk = false;
      try {
        await new Promise((resolve, reject) => {
          const ff = spawn('ffmpeg', ['-y', '-i', tmpIn, '-vn', '-codec:a', 'libmp3lame', '-b:a', '128k', tmpOut]);
          ff.on('error', reject);
          ff.on('close', code => code !== 0 ? reject(new Error(`ffmpeg exit ${code}`)) : resolve());
        });
        finalBuf = fs.readFileSync(tmpOut);
        ffOk = true;
      } catch { /* pakai raw */ }
      try { fs.unlinkSync(tmpIn); } catch {}
      try { fs.unlinkSync(tmpOut); } catch {}

      const fmtDur = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
      const durStr = pick.duration_string || (pick.duration ? fmtDur(pick.duration) : '');
      const cachePath = path.join(CACHE_DIR, `${pick.id}.mp3`);

      if (pick?.id && finalBuf) {
        try {
          fs.writeFileSync(cachePath, finalBuf);
          fs.writeFileSync(path.join(CACHE_DIR, `${pick.id}.json`), JSON.stringify({
            title: pick.title, artist: pick.uploader, dur: durStr, ts: Date.now()
          }));
        } catch {}
      }

      return {
        ok: true,
        buf: finalBuf,
        filePath: fs.existsSync(cachePath) ? cachePath : null,
        mime: ffOk ? 'audio/mpeg' : 'audio/mp4',
        title: pick.title,
        artist: pick.uploader,
        dur: durStr,
        url: `https://www.youtube.com/watch?v=${pick.id}`,
      };
    } catch (eYt) {
      const axios = require('axios');
      const search = require('yt-search');
      const look = await search(qClean);
      const conv = (look.videos || []).filter(v => v.seconds >= 20 && v.seconds <= 900)[0] || look.videos?.[0];
      if (!conv) return { ok: false, alasan: 'Lagu tidak ditemukan' };

      const mp3 = await axios.get(`${process.env.BASE_API || 'http://163.172.110.146:2280/'}api/download/ytmp3`, {
        params: { url: conv.url },
        headers: { 'X-API-Key': process.env.KEY_API || '' },
        timeout: 90000,
      });
      const d = mp3.data?.results;
      if (!d?.audio?.url) return { ok: false, alasan: 'Audio konverter tidak tersedia' };
      const chosen = (Array.isArray(d.audios) ? d.audios.find(a => a.format === 'm4a') : null) || d.audio;
      const res = await axios.get(chosen.url, { responseType: 'arraybuffer', timeout: 120000 });

      return {
        ok: true,
        buf: Buffer.from(res.data),
        mime: chosen.format === 'm4a' ? 'audio/mp4' : 'audio/mpeg',
        title: d.title || conv.title,
        artist: d.channel || conv.author?.name,
        dur: d.duration_str || conv.timestamp,
        url: conv.url,
      };
    }
  };

  const pDownload = doDownload().finally(() => {
    if (pick?.id) inflightAudioDownloads.delete(pick.id);
  });

  if (pick?.id) inflightAudioDownloads.set(pick.id, pDownload);
  return await pDownload;
}

module.exports = {
  ambilAudioLagu,
  runYtDlp,
};
