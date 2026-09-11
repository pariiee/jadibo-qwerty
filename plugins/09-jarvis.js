'use strict';

/**
 * plugins/09-jarvis.js
 * Jarvis — AI agent rahasia yang bisa baca kode & fitur bot-nya sendiri, lalu jalanin command.
 *
 * KHUSUS DEVELOPER (DEVELOPER_NUMBER di .env). Nomor lain diabaikan total.
 * TIDAK perlu prefix: cukup ketik biasa di chat.
 *
 *   jarvis menunya apa aja?
 *   jarvis tunjukin isi package.json
 *   jarvis jalanin ping
 *
 * Cara kerja: AI dikasih TOOLS (function calling). Dia sendiri yang mutusin
 * mau panggil tool apa, berapa kali, sampai bisa jawab. Maks 6 putaran.
 *
 * Tools: list_files, read_file, find_commands, search_code, run_command
 * Config .env: BASE_AI, KEY_AI, MODEL_AI, DEVELOPER_NUMBER
 */

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const ROOT       = path.resolve(__dirname, '..');
const PLUGIN_DIR = __dirname;
const SELF       = '09-jarvis.js';
const MAX_ROUNDS = 6;
const MAX_BYTES  = 200 * 1024;
const MAX_REPLY  = 3500;

// Folder yang nggak pernah dibaca AI
const SKIP_DIRS = new Set(['node_modules', '.git', 'sessions', 'assets', '.pm2', 'logs']);
const BAD_PATH  = /(^|[\\/])\.env|\.db$|\.sqlite$|\.pem$|id_rsa/i;

// Command yang TIDAK boleh dijalankan lewat AI — efeknya susah dibalikin
const DENY_CMD = new Set([
  'jarvis', 'aiagent', 'reset', 'restore', 'backup', 'broadcast', 'bcgc', 'bcgcht',
  'leaveall', 'leavegc', 'ban', 'unban', 'block', 'unblock', 'clearsession', 'cleartmp',
  'kickall', 'delprem', 'addprem', 'delsewa', 'addsewa',
]);

// ─── Helper: jalan keliling repo ─────────────────────────────────────────────
function walk(dir, out = [], depth = 0) {
  if (depth > 6 || out.length > 4000) return out;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, depth + 1);
    else if (/\.(js|json|md|txt|html)$/i.test(e.name)) out.push(full);
  }
  return out;
}

// Cegah path keluar dari repo / nyentuh file rahasia
function safePath(rel) {
  const abs = path.resolve(ROOT, String(rel || ''));
  if (!abs.startsWith(ROOT)) return null;
  if (BAD_PATH.test(abs)) return null;
  return abs;
}

// ─── Tools ───────────────────────────────────────────────────────────────────
function toolListFiles(glob) {
  const files = walk(ROOT).map(f => path.relative(ROOT, f).replace(/\\/g, '/'));
  const hit = glob ? files.filter(f => f.includes(glob)) : files;
  return `${hit.length} file (maks 200 ditampilkan):\n${hit.slice(0, 200).join('\n')}`;
}

function toolReadFile(rel) {
  const abs = safePath(rel);
  if (!abs) return 'DITOLAK: path di luar repo atau file rahasia (.env / *.db / sessions).';
  if (!fs.existsSync(abs)) return `Tidak ada file: ${rel}`;
  const st = fs.statSync(abs);
  if (st.isDirectory()) return toolListFiles(path.relative(ROOT, abs).replace(/\\/g, '/'));
  if (st.size > MAX_BYTES) return `File kegedean (${Math.round(st.size / 1024)}KB), maks ${MAX_BYTES / 1024}KB.`;
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  const head = lines.slice(0, 400).join('\n');
  return `${rel} (${lines.length} baris, ${st.size} byte):\n${head}${lines.length > 400 ? '\n...[dipotong]' : ''}`;
}

function toolFindCommands(q) {
  const found = [];
  for (const f of fs.readdirSync(PLUGIN_DIR).filter(f => f.endsWith('.js')).sort()) {
    if (f === SELF) continue;
    const src = fs.readFileSync(path.join(PLUGIN_DIR, f), 'utf8');
    for (const m of src.matchAll(/case\s+'([^']+)'/g)) found.push({ cmd: m[1], file: f });
  }
  const seen = new Set();
  const uniq = found.filter(x => (seen.has(x.cmd) ? false : seen.add(x.cmd)));
  const hit = q ? uniq.filter(x => x.cmd.includes(q.toLowerCase())) : uniq;
  return `${uniq.length} command unik. Cocok "${q || '*'}": ${hit.length}\n${hit.slice(0, 150).map(x => `.${x.cmd}  (${x.file})`).join('\n')}`;
}

function toolSearchCode(pattern) {
  if (!pattern || pattern.length < 2) return 'pattern minimal 2 karakter';
  let re;
  try { re = new RegExp(pattern, 'i'); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  const out = [];
  for (const abs of walk(ROOT)) {
    if (BAD_PATH.test(abs)) continue;
    let txt;
    try { txt = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const ls = txt.split('\n');
    for (let i = 0; i < ls.length && out.length < 120; i++) {
      if (re.test(ls[i])) out.push(`${path.relative(ROOT, abs).replace(/\\/g, '/')}:${i + 1}: ${ls[i].trim().slice(0, 160)}`);
    }
    if (out.length >= 120) break;
  }
  return out.length ? `${out.length} baris cocok:\n${out.join('\n')}` : 'Nggak ada yang cocok.';
}

// ─── Handler ─────────────────────────────────────────────────────────────────
module.exports = async function jarvisHandler(ctx) {
  const { command, args, reply, react, botData, sender, jid, msg } = ctx;

  // Hanya developer — nomor lain diabaikan senyap (fitur rahasia)
  const devNum    = String(process.env.DEVELOPER_NUMBER || '').replace(/\D/g, '');
  const senderNum = String(sender || '').split('@')[0].split(':')[0];
  if (!devNum || senderNum !== devNum) return false;

  // Bisa dipanggil dengan prefix (.jarvis x) MAUPUN tanpa prefix (jarvis x)
  const body = String(ctx.body || '').trim();
  let ask = '';
  if (ctx.isCmd && (command === 'jarvis' || command === 'aiagent')) {
    ask = args.join(' ').trim();
  } else {
    const m = /^(?:jarvis|aiagent)\b[\s,:]*([\s\S]*)$/i.exec(body);
    if (!m) return false;
    ask = m[1].trim();
  }

  const p = botData.prefix ?? '.';
  if (!ask) {
    await reply(
      `Hai Pak, ini Jarvis 👋\n\n` +
      `Ketik: *jarvis <perintah>*\n\n` +
      `Contoh:\n• jarvis menunya apa aja?\n• jarvis tunjukin isi package.json\n` +
      `• jarvis cari command yang berhubungan sama tiktok\n• jarvis jalanin ping`
    );
    return true;
  }

  const base  = (process.env.BASE_AI || '').replace(/\/+$/, '');
  const key   = process.env.KEY_AI;
  const model = process.env.MODEL_AI || 'auto';
  if (!base || !key) {
    await reply('❌ BASE_AI / KEY_AI belum diisi di .env');
    return true;
  }

  const tools = [
    { type: 'function', function: {
      name: 'list_files',
      description: 'Daftar file di repo bot (relatif), opsional filter substring.',
      parameters: { type: 'object', properties: { glob: { type: 'string', description: 'filter substring path, misal "plugins/"' } } },
    } },
    { type: 'function', function: {
      name: 'read_file',
      description: 'Baca isi file di repo bot. Maks 400 baris pertama.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'path relatif, misal "package.json"' } }, required: ['path'] },
    } },
    { type: 'function', function: {
      name: 'find_commands',
      description: 'Cari daftar command (case ...) di folder plugins beserta file-nya.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'filter nama command, kosongkan untuk semua' } } },
    } },
    { type: 'function', function: {
      name: 'search_code',
      description: 'Cari teks/regex di seluruh source bot.',
      parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
    } },
    { type: 'function', function: {
      name: 'run_command',
      description: 'Jalankan command bot (tanpa prefix). Output command langsung dikirim ke chat. Contoh: ping, menu, cekbisnis',
      parameters: { type: 'object', properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } }, required: ['command'] },
    } },
  ];

  const sys =
    `Kamu "Jarvis", AI agent pribadi Pak di dalam bot WhatsApp YaaParBot — platform multi-bot WA+Telegram (Node.js, zapo-js, MySQL).\n` +
    `Working dir: ${ROOT}\n` +
    `Struktur: plugins/*.js (handler command, urut abjad), engine/*.js (engine), config/*.js.\n` +
    `Pakai tools untuk memeriksa kode asli — JANGAN mengarang isi file atau daftar command.\n` +
    `Kalau Pak minta menjalankan sesuatu, pakai run_command.\n` +
    `Jawab Bahasa Indonesia casual, singkat, langsung ke intinya. Jangan pakai tabel markdown (WA nggak render).`;

  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: ask },
  ];

  await react('⏳').catch(() => {});
  let ranCommand = false;

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const { data } = await axios.post(`${base}/chat/completions`, {
        model, messages, tools, temperature: 0.5,
      }, {
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        timeout: 90000,
      });

      const m = data?.choices?.[0]?.message;
      if (!m) throw new Error('Respons AI kosong');
      messages.push(m);

      const calls = m.tool_calls || [];
      if (!calls.length) {
        const text = (m.content || '').trim();
        if (text) await reply(`🤖 *Jarvis*\n\n${text.slice(0, MAX_REPLY)}`);
        else if (!ranCommand) await reply('🤖 Jarvis nggak ngasih jawaban.');
        await react('✅').catch(() => {});
        return true;
      }

      for (const c of calls) {
        const name = c.function?.name;
        let a = {};
        try { a = JSON.parse(c.function?.arguments || '{}'); } catch { /* argumen rusak */ }
        let res;

        try {
          if (name === 'list_files')         res = toolListFiles(a.glob);
          else if (name === 'read_file')     res = toolReadFile(a.path);
          else if (name === 'find_commands') res = toolFindCommands(a.query);
          else if (name === 'search_code')   res = toolSearchCode(a.pattern);
          else if (name === 'run_command') {
            const cmd = String(a.command || '').replace(/^[.\/!#]/, '').toLowerCase();
            if (DENY_CMD.has(cmd)) {
              res = `DITOLAK: .${cmd} termasuk command berbahaya, jalankan manual.`;
            } else {
              const patched = {
                ...ctx,
                command: cmd,
                body: `${p}${cmd}`,
                args: Array.isArray(a.args) ? a.args.map(String) : [],
                isCmd: true,
                isOwner: true,
                isPremium: true,
                sender: `${devNum}@s.whatsapp.net`,
                mentioned: [`${devNum}@s.whatsapp.net`],
                msg: { ...msg, message: { conversation: `${p}${cmd}` } },
              };
              let handled = false;
              for (const f of fs.readdirSync(PLUGIN_DIR).filter(f => f.endsWith('.js')).sort()) {
                if (f === SELF) continue;
                const mod = require(path.join(PLUGIN_DIR, f));
                const h = typeof mod === 'function' ? mod : mod.handler;
                if (typeof h !== 'function') continue;
                if (await h(patched)) { handled = true; break; }
              }
              ranCommand = true;
              res = handled ? `OK, .${cmd} sudah dijalankan (output dikirim ke chat).` : `Command .${cmd} nggak ada yang nanganin.`;
            }
          } else res = `Tool "${name}" nggak dikenal.`;
        } catch (e) {
          res = `ERROR pas jalanin ${name}: ${e.message}`;
        }

        messages.push({ role: 'tool', tool_call_id: c.id, content: String(res).slice(0, 6000) });
      }
    }

    await reply('🤖 Jarvis kehabisan putaran (max 6). Coba perintah yang lebih spesifik.');
    await react('✅').catch(() => {});
  } catch (e) {
    await react('❌').catch(() => {});
    const detail = e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 200)}` : e.message;
    await reply(`❌ Jarvis error: ${detail}`);
  }
  return true;
};
