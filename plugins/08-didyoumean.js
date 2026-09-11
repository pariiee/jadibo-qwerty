'use strict';

/**
 * plugins/08-didyoumean.js
 * Fitur:  .on didyoumean — saran command saat user typo
 * Contoh: user ketik .meni → bot saran ".menu" + tombol "YA"
 *         klik YA → bot langsung jalankan .menu
 *
 * Aktif via .on didyoumean (global per-bot, di-toggle dari grup oleh owner/admin).
 * Tanpa dependency — pakai Levenshtein distance homemade.
 */

const fs   = require('fs');
const path = require('path');
const { proto } = require('zapo-js');

const { getBotGlobalSetting } = require('../config/globalSettings');

const SELF_FILE = '08-didyoumean.js';
const PLUGINS_DIR = __dirname;

// ── Kumpulkan semua command valid dari semua file plugin (sekali saat boot) ──
const COMMAND_SET = new Set();
const PLUGIN_FILES = [];
for (const f of fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.js')).sort()) {
  if (f === SELF_FILE) continue;
  PLUGIN_FILES.push(f);
  const src = fs.readFileSync(path.join(PLUGINS_DIR, f), 'utf8');
  // Ambil semua case 'xxx' literal — termasuk alias per command
  for (const m of src.matchAll(/case\s+'([^']+)'/g)) {
    if (m[1]) COMMAND_SET.add(m[1]);
  }
}

// ─── Levenshtein distance ─────────────────────────────────────────────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,                         // hapus
        cur[j - 1] + 1,                      // sisip
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1) // ganti
      );
    }
    prev = cur;
  }
  return prev[n];
}

/** Cari command terdekat dengan typo. Return null kalau terlalu jauh. */
function suggest(typed) {
  if (!typed || typed.length < 3) return null;
  let best = null;
  let bestDist = Infinity;
  for (const cmd of COMMAND_SET) {
    if (cmd.length < 3) continue;
    const d = levenshtein(typed, cmd);
    if (d < bestDist) { bestDist = d; best = cmd; }
  }
  if (!best) return null;
  // Jarak maksimum wajar: 1 utk cmd pendek, maks 3 utk cmd panjang
  const threshold = Math.min(3, Math.max(1, Math.floor(best.length / 3)));
  return bestDist <= threshold ? best : null;
}

// Cooldown per chat+user biar nggak spam saran
const cdStore = new Map();
const CD_MS = 10000;
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of cdStore) if (now - t > CD_MS) cdStore.delete(k);
}, 30000).unref();

// ─── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function didyoumeanHandler(ctx) {
  const { client, jid, sender, isCmd, command, reply, msg, botData, react } = ctx;
  const p = botData.prefix ?? '.';

  // Fitur harus di-on-kan dulu (.on didyoumean)
  if (!getBotGlobalSetting(botData.id, 'didyoumean')) return false;

  const btn = msg?.message?.buttonsResponseMessage;

  // ── Klik tombol "YA" dari saran → jalankan command yang direkomendasikan ──
  if (btn?.selectedButtonId && btn.selectedButtonId.startsWith('dym:')) {
    const cmd = btn.selectedButtonId.slice(4).trim();
    if (!COMMAND_SET.has(cmd)) {
      await reply(`❌ Command *${p}${cmd}* sudah tidak tersedia.`);
      return true;
    }
    await react('⏳').catch(() => {});
    await reply(`✅ Oke, menjalankan *${p}${cmd}*...`).catch(() => {});
    // Patch ctx jadi seolah user mengetik command yang dimaksud, jalankan semua plugin
    const patched = {
      ...ctx,
      command: cmd,
      body: `${p}${cmd}`,
      args: [],
      isCmd: true,
      // Buang jejak tombol dari msg — kalau tidak, plugin lain (07-button, dll)
      // masuk cabang "buttons response" & skip switch command-nya
      msg: {
        ...ctx.msg,
        message: { ...(ctx.msg.message || {}), buttonsResponseMessage: undefined },
      },
    };
    for (const f of PLUGIN_FILES) {
      try {
        const mod = require(path.join(PLUGINS_DIR, f));
        const handler = typeof mod === 'function' ? mod : (mod.handler || null);
        if (!handler) continue;
        const handled = await handler(patched);
        if (handled) return true;
      } catch (e) {
        console.error(`[DidYouMean] Gagal eksekusi ${p}${cmd}:`, e.message);
        await reply(`❌ Gagal menjalankan *${p}${cmd}*: ${e.message}`).catch(() => {});
        return true;
      }
    }
    await reply(`❌ Command *${p}${cmd}* tidak ditemukan.`).catch(() => {});
    return true;
  }

  // ── Bukan command → biarkan (auto-listener plugin lain yang pegang) ───────
  if (!isCmd) return false;

  // Command valid biasanya udah ke-handle plugin lain (plugin ini paling akhir).
  // Sampai di sini = command nggak dikenal siapa pun → coba saran.
  const mean = suggest(command);
  if (!mean) return false;

  const cdKey = `${jid}:${sender}`;
  const now = Date.now();
  if ((cdStore.get(cdKey) || 0) > now - CD_MS) return true; // lagi cooldown
  cdStore.set(cdKey, now);

  const sim = Math.round((1 - levenshtein(command, mean) / Math.max(command.length, mean.length)) * 100);

  // ctx.sender sudah di-resolve engine LID→PN; cukup strip :device kalau ada
  const pnJid = sender.split(':')[0];

  try {
    await client.message.send(jid, {
      buttonsMessage: {
        contentText: `Nama menu : *${p}${mean}*
Kemiripan : *${sim}%*`,
        footerText:  botData.footer_text || 'YaaParBot',
        headerType:  proto.Message.ButtonsMessage.HeaderType.TEXT,
        text:        `Halo Kak @${pnJid.split('@')[0].split(':')[0]}! 👋 Kayaknya kamu nyari *${p}${mean}*, ya?`,
        contextInfo: { mentionedJid: [pnJid] },
        buttons: [
          {
            buttonId:   `dym:${mean}`,
            buttonText: { displayText: '✅ YA' },
            type:       proto.Message.ButtonsMessage.Button.Type.RESPONSE,
          },
        ],
      },
    }, { quote: msg });
  } catch (e) {
    // Fallback: kirim teks biasa tanpa tombol
    await reply(`Halo Kak @${pnJid.split('@')[0].split(':')[0]}, apakah Anda sedang mencari *${p}${mean}*?\n\n◦ Nama menu : *${p}${mean}*\n◦ Kemiripan : *${sim}%*\n\nKetik *${p}${mean}* untuk menjalankan.`);
  }
  return true;
};
