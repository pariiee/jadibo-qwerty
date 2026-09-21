'use strict';
// Rapikan video sebelum dikirim ke WA — remux passthrough, TANPA re-encode.
//
// Kenapa: video pendek dari X/Twitter (dan story/klip lain) sering datang
// TANPA track audio + durasi pas 1 detik. WA nolak file kayak gitu walau isinya
// sehat — user lihat "video tidak dapat diputar". Dua hal yang dibenerin:
//   1. track audio wajib ada → ditambah audio senyap (anullsrc) kalau kosong;
//   2. container di-remux ulang + faststart (moov di depan, brand isom).
// ponytail: stream video di-copy, jadi nol biaya CPU & nol turun kualitas.
// Ceiling: input non-mp4 (webm dll) bakal gagal remux → balik ke buffer asli.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function jalan(bin, argv) {
  return new Promise((resolve) => {
    const p = spawn(bin, argv);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', () => resolve({ ok: false, out: '', err: 'binernya nggak ada' }));
    p.on('close', (code) => resolve({ ok: code === 0, out, err }));
  });
}

async function punyaAudio(file) {
  const r = await jalan('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]);
  // nggak bisa dipastikan (ffprobe nggak ada / file aneh) → anggap ADA audio.
  // Aman: jalur itu cuma remux, jadi audio asli nggak mungkin kehapus/bisu.
  if (!r.ok) return true;
  return /audio/.test(r.out);
}

async function normalVideo(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return buffer;

  const id    = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const input = path.join(os.tmpdir(), `norm_in_${id}.mp4`);
  const out   = path.join(os.tmpdir(), `norm_out_${id}.mp4`);
  try {
    fs.writeFileSync(input, buffer);
    const argv = await punyaAudio(input)
      ? ['-v', 'error', '-y', '-i', input, '-c', 'copy', '-movflags', '+faststart', out]
      : ['-v', 'error', '-y', '-i', input, '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
        '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest',
        '-movflags', '+faststart', out];

    const r = await jalan('ffmpeg', argv);
    if (!r.ok || !fs.existsSync(out) || fs.statSync(out).size < 1024) return buffer;
    return fs.readFileSync(out);
  } catch {
    return buffer;
  } finally {
    for (const f of [input, out]) { try { fs.unlinkSync(f); } catch { /* biarin */ } }
  }
}

module.exports = { normalVideo };

// Self-check: video 1 detik tanpa audio harus keluar punya track audio.
if (require.main === module) {
  const assert = require('assert');
  const { spawnSync } = require('child_process');
  const asal = path.join(os.tmpdir(), 'norm_self_in.mp4');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', asal]);

  (async () => {
    const masuk  = fs.readFileSync(asal);
    const keluar = await normalVideo(masuk);
    assert.ok(Buffer.isBuffer(keluar) && keluar.length > 1024, 'keluaran kosong');
    assert.ok(keluar.slice(8, 12).toString('latin1') === 'isom', 'brand mp4 bukan isom');

    const cek = path.join(os.tmpdir(), 'norm_self_out.mp4');
    fs.writeFileSync(cek, keluar);
    const audio = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', cek], { encoding: 'utf8' });
    assert.ok(/audio/.test(audio.stdout || ''), 'track audio nggak nempel');
    console.log('normalVideo OK:', masuk.length, '->', keluar.length, 'bytes, audio nempel');
  })();
}
