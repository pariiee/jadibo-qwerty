'use strict';

/**
 * plugins/00-game.js
 * Semua mini game dalam satu file.
 *
 * Commands:
 *  .asahotak    → tebak jawaban (exact + fuzzy similarity)
 *  .clue       → hint konsonan disembunyikan
 *  .caklontong  → tebak absurd ala Cak Lontong, semua teks react 🤔
 *  .family100   → tebak banyak jawaban bersama-sama
 *  .fisika      → pilgan fisika A/B/C/D, skor per level
 *  .kuisislami  → pilgan islami A/B/C/D
 *  .nyerah      → reveal + reward (berlaku untuk game apapun yang aktif)
 *  .tebak-*     → tebakbendera, tebakanime, tebakchara, tebakgambar (gambar dari API)
 *
 * Rule: 1 grup = 1 game aktif (via sharedStore)
 */

const { rapikanError } = require('../engine/pesanError');
const { pool }    = require('../config/database');
const sharedStore = require('../engine/gameStore');

const TIMEOUT_MS      = 60000;  // 60 detik (asahotak, caklontong)
const TIMEOUT_F100_MS = 120000; // 120 detik (family100)
const TIMEOUT_FISIKA  = 30000;  // 30 detik (fisika, kuisislami)

// Skor fisika per level
const FISIKA_SCORE = { easy: 150, medium: 300, hard: 500 };

// ─── Helper: angka acak dalam range ──────────────────────────────────────────
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// ─── Simple string similarity (Dice coefficient) ─────────────────────────────
function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const getBigrams = str => {
    const bigrams = new Set();
    for (let i = 0; i < str.length - 1; i++) bigrams.add(str.slice(i, i + 2));
    return bigrams;
  };
  const biA = getBigrams(a);
  const biB = getBigrams(b);
  let intersection = 0;
  for (const bi of biA) if (biB.has(bi)) intersection++;
  return (2 * intersection) / (biA.size + biB.size);
}

// ─── Random reward — salah satu dari 5 tipe ──────────────────────────────────
const REWARD_TYPES = [
  { field: 'money',      emoji: '💰', label: 'Money'     },
  { field: 'xp',         emoji: '⭐', label: 'XP'        },
  { field: 'healt',      emoji: '❤️',  label: 'HP'        },
  { field: 'lim',        emoji: '⚡', label: 'lim'       },
  { field: 'bank_money', emoji: '🏦', label: 'Money bank' },
];

async function giveReward(botId, sender, minVal, maxVal) {
  const type   = REWARD_TYPES[Math.floor(Math.random() * REWARD_TYPES.length)];
  const amount = randInt(minVal, maxVal);
  try {
    await pool.execute(
      `UPDATE rpg_members SET ${type.field} = ${type.field} + ? WHERE bot_id = ? AND jid = ? AND registered = 1`,
      [amount, botId, sender]
    );
  } catch { /* non-critical */ }
  return { ...type, amount };
}

// ─── Reward ke banyak partisipan (caklontong) ─────────────────────────────────
async function rewardParticipants(botId, participants) {
  const results = [];
  for (const sender of participants) {
    const r = await giveReward(botId, sender, 50, 150);
    results.push({ sender, ...r });
  }
  return results;
}

// ─── Build papan skor family100 ───────────────────────────────────────────────
function buildBoard(jawabanList, found) {
  return jawabanList.map((jaw, i) => {
    const f = found.get(i);
    return f ? `${i + 1}. ✅ *${jaw}*` : `${i + 1}. ____`;
  }).join('\n');
}

// ─── Store wrappers ───────────────────────────────────────────────────────────
const asahotakStore = {
  has:    (jid) => sharedStore.has(jid) && sharedStore.get(jid).game === 'asahotak',
  get:    (jid) => sharedStore.get(jid),
  set:    (jid, data) => sharedStore.set(jid, { ...data, game: 'asahotak' }),
  delete: (jid) => sharedStore.delete(jid),
};

const clStore = {
  has:    (jid) => sharedStore.has(jid) && sharedStore.get(jid).game === 'caklontong',
  get:    (jid) => sharedStore.get(jid),
  set:    (jid, data) => sharedStore.set(jid, { ...data, game: 'caklontong' }),
  delete: (jid) => sharedStore.delete(jid),
};

const f100Store = {
  has:    (jid) => sharedStore.has(jid) && sharedStore.get(jid).game === 'family100',
  get:    (jid) => sharedStore.get(jid),
  set:    (jid, data) => sharedStore.set(jid, { ...data, game: 'family100' }),
  delete: (jid) => sharedStore.delete(jid),
};

const fisikaStore = {
  has:    (jid) => sharedStore.has(jid) && sharedStore.get(jid).game === 'fisika',
  get:    (jid) => sharedStore.get(jid),
  set:    (jid, data) => sharedStore.set(jid, { ...data, game: 'fisika' }),
  delete: (jid) => sharedStore.delete(jid),
};

const islamiStore = {
  has:    (jid) => sharedStore.has(jid) && sharedStore.get(jid).game === 'kuisislami',
  get:    (jid) => sharedStore.get(jid),
  set:    (jid, data) => sharedStore.set(jid, { ...data, game: 'kuisislami' }),
  delete: (jid) => sharedStore.delete(jid),
};

const mathStore = {
  has:    (jid) => sharedStore.has(jid) && sharedStore.get(jid).game === 'math',
  get:    (jid) => sharedStore.get(jid),
  set:    (jid, data) => sharedStore.set(jid, { ...data, game: 'math' }),
  delete: (jid) => sharedStore.delete(jid),
};

const siapakahakuStore = {
  has:    (jid) => sharedStore.has(jid) && sharedStore.get(jid).game === 'siapakahaku',
  get:    (jid) => sharedStore.get(jid),
  set:    (jid, data) => sharedStore.set(jid, { ...data, game: 'siapakahaku' }),
  delete: (jid) => sharedStore.delete(jid),
};

const singkatanStore = {
  has:    (jid) => sharedStore.has(jid) && sharedStore.get(jid).game === 'singkatan',
  get:    (jid) => sharedStore.get(jid),
  set:    (jid, data) => sharedStore.set(jid, { ...data, game: 'singkatan' }),
  delete: (jid) => sharedStore.delete(jid),
};

const susunKataStore = {
  has:    (jid) => sharedStore.has(jid) && sharedStore.get(jid).game === 'susunkata',
  get:    (jid) => sharedStore.get(jid),
  set:    (jid, data) => sharedStore.set(jid, { ...data, game: 'susunkata' }),
  delete: (jid) => sharedStore.delete(jid),
};

const tebakAnimeStore = {
  has:    (jid) => sharedStore.has(jid) && sharedStore.get(jid).game === 'tebakanime',
  get:    (jid) => sharedStore.get(jid),
  set:    (jid, data) => sharedStore.set(jid, { ...data, game: 'tebakanime' }),
  delete: (jid) => sharedStore.delete(jid),
};

const tebakBenderaStore = {
  has:    (jid) => sharedStore.has(jid) && sharedStore.get(jid).game === 'tebakbendera',
  get:    (jid) => sharedStore.get(jid),
  set:    (jid, data) => sharedStore.set(jid, { ...data, game: 'tebakbendera' }),
  delete: (jid) => sharedStore.delete(jid),
};

const tebakCharaStore = {
  has:    (jid) => sharedStore.has(jid) && sharedStore.get(jid).game === 'tebakchara',
  get:    (jid) => sharedStore.get(jid),
  set:    (jid, data) => sharedStore.set(jid, { ...data, game: 'tebakchara' }),
  delete: (jid) => sharedStore.delete(jid),
};

const tebakGambarStore = {
  has:    (jid) => sharedStore.has(jid) && sharedStore.get(jid).game === 'tebakgambar',
  get:    (jid) => sharedStore.get(jid),
  set:    (jid, data) => sharedStore.set(jid, { ...data, game: 'tebakgambar' }),
  delete: (jid) => sharedStore.delete(jid),
};

// ─── Helper: build soal pilgan (dipakai fisika & kuisislami) ─────────────────
function parsePilgan(pilihan, jawaban) {
  const huruf      = ['A', 'B', 'C', 'D'];
  const jawabanIdx = pilihan.findIndex(p => p.toLowerCase() === jawaban.toLowerCase());
  const jawabanHuruf = huruf[jawabanIdx >= 0 ? jawabanIdx : 0];
  const pilihanTeks  = pilihan.map((p, i) => `${huruf[i]}. ${p}`).join('\n');
  return { jawabanHuruf, pilihanTeks };
}

// ─── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function gameHandler(ctx) {
  const { command, reply, react, client, jid, sender, msg, botData, isCmd } = ctx;
  const p = botData.prefix;

  const rawMsg   = msg.message || {};
  const teksUser = (
    rawMsg?.extendedTextMessage?.text ||
    rawMsg?.conversation ||
    rawMsg?.imageMessage?.caption ||
    ''
  ).trim();

  const activeGame = sharedStore.activeGame(jid);
  // Log [GAME] hanya saat ada game aktif (bukan tiap pesan)
  if (activeGame) {
    console.log(`[GAME] jid=${jid} isCmd=${isCmd} activeGame=${activeGame} teks="${teksUser}"`);
  }

  // ── ASAHOTAK: cek jawaban di setiap pesan ────────────────────────────────────
  if (activeGame === 'asahotak') {
    const session   = asahotakStore.get(jid);
    const teksLower = teksUser.toLowerCase();
    const jawaban   = session.jawaban.toLowerCase().trim();
    const sim       = teksLower ? similarity(teksLower, jawaban) : -1;

    console.log(`[ASAHOTAK] teksUser="${teksLower}" jawaban="${jawaban}" sim=${sim >= 0 ? sim.toFixed(2) : 'n/a'}`);

    if (teksLower) {
      if (teksLower === jawaban || sim >= 0.85) {
        clearTimeout(session.timer);
        asahotakStore.delete(jid);
        const minR = session.hintUsed ? 150 : 300;
        const maxR = session.hintUsed ? 300 : 500;
        const r    = await giveReward(botData.id, sender, minR, maxR);
        const nama = ctx.pushName || sender.split('@')[0];
        await reply(
          `✅ *Benar!*\n\n` +
          `👤 ${nama} menjawab dengan benar!\n` +
          `💡 Jawaban: *${session.jawaban}*\n` +
          `${r.emoji} +${r.amount} ${r.label}${session.hintUsed ? ' _(pakai hint)_' : ''}`
        );
        return true;
      } else if (sim >= 0.65) {
        await client.message.send(jid, { text: `🤔 *Hampir tepat!* Coba lagi...`, quoted: msg });
        return true;
      } else if (!isCmd) {
        await react('❌');
        return true;
      }
    }
  }

  // ── CAKLONTONG: cek jawaban + catat partisipan ───────────────────────────
  if (activeGame === 'caklontong' && teksUser && !isCmd) {
    const session   = clStore.get(jid);
    const teksLower = teksUser.toLowerCase().trim();
    const jawaban   = session.answer.toLowerCase().trim();
    const sim       = similarity(teksLower, jawaban);
    console.log(`[CAKLONTONG] tebakan dari ${sender}: "${teksLower}" jawaban="${jawaban}" sim=${sim.toFixed(2)}`);

    session.participants.add(sender);

    if (teksLower === jawaban || sim >= 0.85) {
      clearTimeout(session.timer);
      clStore.delete(jid);
      const r    = await giveReward(botData.id, sender, 200, 400);
      const nama = ctx.pushName || sender.split('@')[0];
      await reply(
        `✅ *Benar!*\n\n` +
        `👤 ${nama} menjawab dengan benar!\n` +
        `💡 Jawaban: *${session.answer}*\n` +
        `${r.emoji} +${r.amount} ${r.label}\n\n` +
        `📖 _${session.detail}_`
      );
    } else if (sim >= 0.65) {
      await react('🤔');
    } else {
      await react('❌');
    }
    return true;
  }

  // ── FAMILY100: cek jawaban ke semua yang belum ditemukan ─────────────────────
  if (activeGame === 'family100' && teksUser && !isCmd) {
    const session   = f100Store.get(jid);
    const teksLower = teksUser.toLowerCase();
    let matched = false;
    let hampir  = false;

    for (let i = 0; i < session.sisa.length; i++) {
      const jawLower = session.sisa[i].toLowerCase();
      const sim      = similarity(teksLower, jawLower);
      console.log(`[F100] teks="${teksLower}" vs "${jawLower}" sim=${sim.toFixed(2)}`);

      if (teksLower === jawLower || sim >= 0.85) {
        const jawabanAsli = session.sisa[i];
        const origIdx     = session.jawaban.findIndex(j => j.toLowerCase() === jawLower);
        session.sisa.splice(i, 1);
        session.found.set(origIdx, { jawaban: jawabanAsli, finder: sender });

        const r    = await giveReward(botData.id, sender, 150, 300);
        const nama = ctx.pushName || sender.split('@')[0];

        const board = buildBoard(session.jawaban, session.found);
        const sisa  = session.sisa.length;

        await react('✅');
        await client.message.send(jid,
          `✅ *${nama}* menemukan jawaban!\n` +
          `💡 *${jawabanAsli}* • ${r.emoji} +${r.amount} ${r.label}\n\n` +
          `📊 *Progress:* ${session.found.size}/${session.jawaban.length}\n\n` +
          `${board}\n\n` +
          (sisa > 0 ? `_Masih ${sisa} jawaban tersisa!_` : '')
        );

        matched = true;

        if (session.sisa.length === 0) {
          clearTimeout(session.timer);
          f100Store.delete(jid);
          await client.message.send(jid,
            `🎉 *SEMUA JAWABAN DITEMUKAN!*\n\n` +
            `❓ Soal: _${session.soal}_\n\n` +
            `${board}\n\n` +
            `Game selesai! GG semua! 🏆`
          );
        }
        break;
      } else if (sim >= 0.65) {
        hampir = true;
      }
    }

    if (!matched) {
      await react(hampir ? '🤔' : '❌');
    }
    return true;
  }

  // ── FISIKA: deteksi A/B/C/D ───────────────────────────────────────────────
  if (activeGame === 'fisika' && teksUser && !isCmd) {
    const teksUp  = teksUser.toUpperCase();
    const session = fisikaStore.get(jid);
    if (session && ['A', 'B', 'C', 'D'].includes(teksUp)) {
      console.log(`[FISIKA] jawaban=${teksUp} benar=${session.jawabanHuruf}`);
      if (teksUp === session.jawabanHuruf) {
        clearTimeout(session.timer);
        fisikaStore.delete(jid);
        const baseMin = FISIKA_SCORE[session.level] || 300;
        const baseMax = baseMin + Math.floor(baseMin * 0.3);
        const r       = await giveReward(botData.id, sender, baseMin, baseMax);
        const nama    = ctx.pushName || sender.split('@')[0];
        await reply(
          `✅ *Benar!*\n\n` +
          `👤 ${nama} menjawab dengan benar!\n` +
          `💡 Jawaban: *${session.jawabanHuruf}. ${session.jawaban}*\n` +
          `${r.emoji} +${r.amount} ${r.label}\n\n` +
          `📖 _${session.deskripsi}_`
        );
      } else {
        await react('❌');
      }
      return true;
    }
  }

  // ── KUISISLAMI: deteksi A/B/C/D ──────────────────────────────────────────
  if (activeGame === 'kuisislami' && teksUser && !isCmd) {
    const teksUp  = teksUser.toUpperCase();
    const session = islamiStore.get(jid);
    if (session && ['A', 'B', 'C', 'D'].includes(teksUp)) {
      console.log(`[KUISISLAMI] jawaban=${teksUp} benar=${session.jawabanHuruf}`);
      if (teksUp === session.jawabanHuruf) {
        clearTimeout(session.timer);
        islamiStore.delete(jid);
        const r    = await giveReward(botData.id, sender, 200, 400);
        const nama = ctx.pushName || sender.split('@')[0];
        await reply(
          `✅ *Benar!*\n\n` +
          `👤 ${nama} menjawab dengan benar!\n` +
          `💡 Jawaban: *${session.jawabanHuruf}. ${session.jawaban}*\n` +
          `${r.emoji} +${r.amount} ${r.label}\n\n` +
          `📖 _${session.deskripsi}_`
        );
      } else {
        await react('❌');
      }
      return true;
    }
  }
  // ── MATH: deteksi A/B/C/D ────────────────────────────────────────────────
  if (activeGame === 'math' && teksUser && !isCmd) {
    const teksUp  = teksUser.toUpperCase();
    const session = mathStore.get(jid);
    if (session && ['A', 'B', 'C', 'D'].includes(teksUp)) {
      console.log(`[MATH] jawaban=${teksUp} benar=${session.jawabanHuruf}`);
      if (teksUp === session.jawabanHuruf) {
        clearTimeout(session.timer);
        mathStore.delete(jid);
        const baseMin = FISIKA_SCORE[session.level] || 300;
        const baseMax = baseMin + Math.floor(baseMin * 0.3);
        const r       = await giveReward(botData.id, sender, baseMin, baseMax);
        const nama    = ctx.pushName || sender.split('@')[0];
        await reply(
          `✅ *Benar!*\n\n` +
          `👤 ${nama} menjawab dengan benar!\n` +
          `💡 Jawaban: *${session.jawabanHuruf}. ${session.jawaban}*\n` +
          `${r.emoji} +${r.amount} ${r.label}\n\n` +
          `📖 _${session.deskripsi}_`
        );
      } else {
        await react('❌');
      }
      return true;
    }
  }

  // ── SIAPAKAHAKU: deteksi jawaban teks bebas ───────────────────────────────
  if (activeGame === 'siapakahaku' && teksUser && !isCmd) {
    const session   = siapakahakuStore.get(jid);
    const teksLower = teksUser.toLowerCase();
    const jawaban   = session.jawaban.toLowerCase().trim();
    const sim       = similarity(teksLower, jawaban);
    console.log(`[SIAPAKAHAKU] teks="${teksLower}" jawaban="${jawaban}" sim=${sim.toFixed(2)}`);
    if (teksLower === jawaban || sim >= 0.85) {
      clearTimeout(session.timer);
      siapakahakuStore.delete(jid);
      const r    = await giveReward(botData.id, sender, 200, 400);
      const nama = ctx.pushName || sender.split('@')[0];
      await reply(
        `✅ *Benar!*\n\n` +
        `👤 ${nama} menjawab dengan benar!\n` +
        `💡 Jawaban: *${session.jawaban}*\n` +
        `${r.emoji} +${r.amount} ${r.label}`
      );
    } else if (sim >= 0.65) {
      await client.message.send(jid, { text: `🤔 *Hampir tepat!* Coba lagi...`, quoted: msg });
    } else {
      await react('❌');
    }
    return true;
  }

  // ── SINGKATAN: deteksi jawaban kepanjangan ────────────────────────────────
  if (activeGame === 'singkatan' && teksUser && !isCmd) {
    const session   = singkatanStore.get(jid);
    const teksLower = teksUser.toLowerCase();
    const jawaban   = session.kepanjangan.toLowerCase().trim();
    const sim       = similarity(teksLower, jawaban);
    console.log(`[SINGKATAN] teks="${teksLower}" jawaban="${jawaban}" sim=${sim.toFixed(2)}`);
    if (teksLower === jawaban || sim >= 0.85) {
      clearTimeout(session.timer);
      singkatanStore.delete(jid);
      const r    = await giveReward(botData.id, sender, 150, 350);
      const nama = ctx.pushName || sender.split('@')[0];
      await reply(
        `✅ *Benar!*\n\n` +
        `👤 ${nama} menjawab dengan benar!\n` +
        `💡 *${session.singkatan}* = *${session.kepanjangan}*\n` +
        `${r.emoji} +${r.amount} ${r.label}\n\n` +
        `📖 _${session.deskripsi}_`
      );
    } else if (sim >= 0.65) {
      await client.message.send(jid, { text: `🤔 *Hampir tepat!* Coba lagi...`, quoted: msg });
    } else {
      await react('❌');
    }
    return true;
  }
  // ── SUSUNKATA: deteksi jawaban teks bebas ─────────────────────────────────
  if (activeGame === 'susunkata' && teksUser && !isCmd) {
    const session   = susunKataStore.get(jid);
    const teksUpper = teksUser.toUpperCase().trim();
    const jawaban   = session.jawaban.toUpperCase().trim();
    const sim       = similarity(teksUpper, jawaban);
    console.log(`[SUSUNKATA] teks="${teksUpper}" jawaban="${jawaban}" sim=${sim.toFixed(2)}`);
    if (teksUpper === jawaban || sim >= 0.85) {
      clearTimeout(session.timer);
      susunKataStore.delete(jid);
      const r    = await giveReward(botData.id, sender, 150, 300);
      const nama = ctx.pushName || sender.split('@')[0];
      await reply(
        `✅ *Benar!*\n\n` +
        `👤 ${nama} menjawab dengan benar!\n` +
        `🔤 *${session.soal}* → *${session.jawaban}*\n` +
        `${r.emoji} +${r.amount} ${r.label}`
      );
    } else if (sim >= 0.65) {
      await client.message.send(jid, { text: `🤔 *Hampir tepat!* Coba lagi...`, quoted: msg });
    } else {
      await react('❌');
    }
    return true;
  }
  // ── TEBAKANIME: deteksi jawaban teks bebas ────────────────────────────────
  if (activeGame === 'tebakanime' && teksUser && !isCmd) {
    const session   = tebakAnimeStore.get(jid);
    const teksLower = teksUser.toLowerCase().trim();
    const jawaban   = session.jawaban.toLowerCase().trim();
    const jawabanBersih = jawaban.replace(/\s*\(.*?\)\s*/g, '').trim();
    const sim1 = similarity(teksLower, jawaban);
    const sim2 = similarity(teksLower, jawabanBersih);
    const sim  = Math.max(sim1, sim2);
    console.log(`[TEBAKANIME] teks="${teksLower}" jawaban="${jawaban}" sim=${sim.toFixed(2)}`);
    if (teksLower === jawaban || teksLower === jawabanBersih || sim >= 0.85) {
      clearTimeout(session.timer);
      tebakAnimeStore.delete(jid);
      const r    = await giveReward(botData.id, sender, 200, 500);
      const nama = ctx.pushName || sender.split('@')[0];
      await reply(
        `✅ *Benar!*\n\n` +
        `👤 ${nama} menebak dengan benar!\n` +
        `🎌 Anime: *${session.jawaban}*\n` +
        `${r.emoji} +${r.amount} ${r.label}\n\n` +
        `⭐ Score: *${session.score}* | 🎬 ${session.tipe} | 📅 ${session.tahunRilis}`
      );
    } else if (sim >= 0.65) {
      await client.message.send(jid, { text: `🤔 *Hampir tepat!* Coba lagi...`, quoted: msg });
    } else {
      await react('❌');
    }
    return true;
  }
  // ── TEBAKBENDERA: deteksi jawaban teks bebas ──────────────────────────────
  if (activeGame === 'tebakbendera' && teksUser && !isCmd) {
    const session   = tebakBenderaStore.get(jid);
    const teksLower = teksUser.toLowerCase().trim();
    const jawaban   = session.nama.toLowerCase().trim();
    const sim       = similarity(teksLower, jawaban);
    console.log(`[TEBAKBENDERA] teks="${teksLower}" jawaban="${jawaban}" sim=${sim.toFixed(2)}`);
    if (teksLower === jawaban || sim >= 0.85) {
      clearTimeout(session.timer);
      tebakBenderaStore.delete(jid);
      const r    = await giveReward(botData.id, sender, 150, 350);
      const nama = ctx.pushName || sender.split('@')[0];
      await reply(
        `✅ *Benar!*\n\n` +
        `👤 ${nama} menebak dengan benar!\n` +
        `${session.bendera} Negara: *${session.nama}*\n` +
        `${r.emoji} +${r.amount} ${r.label}`
      );
    } else if (sim >= 0.65) {
      await client.message.send(jid, { text: `🤔 *Hampir tepat!* Coba lagi...`, quoted: msg });
    } else {
      await react('❌');
    }
    return true;
  }

  // ── TEBAKCHARA: deteksi jawaban teks bebas ────────────────────────────────
  if (activeGame === 'tebakchara' && teksUser && !isCmd) {
    const session   = tebakCharaStore.get(jid);
    const teksLower = teksUser.toLowerCase().trim();
    // jawaban format "Lastname, Firstname" — coba juga "Firstname Lastname"
    const jawabanAsli  = session.name.toLowerCase().trim();
    const jawabanBalik = jawabanAsli.includes(',')
      ? jawabanAsli.split(',').map(s => s.trim()).reverse().join(' ')
      : jawabanAsli;
    const sim1 = similarity(teksLower, jawabanAsli);
    const sim2 = similarity(teksLower, jawabanBalik);
    const sim  = Math.max(sim1, sim2);
    console.log(`[TEBAKCHARA] teks="${teksLower}" jawaban="${jawabanAsli}" sim=${sim.toFixed(2)}`);
    if (teksLower === jawabanAsli || teksLower === jawabanBalik || sim >= 0.85) {
      clearTimeout(session.timer);
      tebakCharaStore.delete(jid);
      const r    = await giveReward(botData.id, sender, 200, 450);
      const nama = ctx.pushName || sender.split('@')[0];
      await reply(
        `✅ *Benar!*\n\n` +
        `👤 ${nama} menebak dengan benar!\n` +
        `🎭 Karakter: *${session.name}*\n` +
        `${r.emoji} +${r.amount} ${r.label}\n\n` +
        `🎌 Anime: ${session.anime[0] || '-'}`
      );
    } else if (sim >= 0.65) {
      await client.message.send(jid, { text: `🤔 *Hampir tepat!* Coba lagi...`, quoted: msg });
    } else {
      await react('❌');
    }
    return true;
  }

  // ── TEBAKGAMBAR: deteksi jawaban teks bebas (fuzzy, sama kaya sodara-sodaranya) ──
  if (activeGame === 'tebakgambar' && teksUser && !isCmd) {
    const session   = tebakGambarStore.get(jid);
    if (!session) return false;   // soal udah kedaluwarsa — biarin lewat biasa
    const teksLower = teksUser.toLowerCase().trim();
    const jawaban   = session.jawaban.toLowerCase().trim();
    const sim       = similarity(teksLower, jawaban);
    console.log(`[TEBAKGAMBAR] teks="${teksLower}" jawaban="${jawaban}" sim=${sim.toFixed(2)}`);
    if (teksLower === jawaban || sim >= 0.85) {
      clearTimeout(session.timer);
      tebakGambarStore.delete(jid);
      const r    = await giveReward(botData.id, sender, 150, 350);
      const nama = ctx.pushName || sender.split('@')[0];
      await reply(
        `✅ *Benar!*\n\n` +
        `👤 ${nama} menebak dengan benar!\n` +
        `🖼️ Jawaban: *${session.jawaban}* _(soal #${session.index})_\n` +
        `${r.emoji} +${r.amount} ${r.label}`
      );
    } else if (sim >= 0.65) {
      await client.message.send(jid, { text: `🤔 *Hampir tepat!* Coba lagi...`, quoted: msg });
    } else {
      await react('❌');
    }
    return true;
  }


  switch (command) {

    // ── asahotak — mulai game ──────────────────────────────────────────────────
    case 'asahotak': {
      if (activeGame === 'asahotak') {
        const s = asahotakStore.get(jid);
        await reply(`⚠️ Masih ada soal asah otak aktif!\n\n_"${s.soal}"_\n\nJawab dulu atau ketik *${p}nyerah* untuk skip.`);
        return true;
      } else if (activeGame) {
        await reply(`⚠️ Masih ada game *${activeGame}* aktif di sini!\nKetik *${p}nyerah* untuk mengakhirinya dulu.`);
        return true;
      }

      try {
        const axios = require('axios');
        await react('🧠');

        const { data } = await axios.get(`${process.env.BASE_API}api/game/asahotak`, {
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 15000,
        });

        const soal    = data?.results?.soal;
        const jawaban = data?.results?.jawaban;
        if (!soal || !jawaban) throw new Error('Format data soal tidak valid dari API');

        const caption =
          `🧠 *ASAH OTAK*\n\n` +
          `❓ ${soal}\n\n` +
          `┌─────────────────\n` +
          `│ ⏱️ Timeout: *${TIMEOUT_MS / 1000} detik*\n` +
          `│ 💡 Clue: ketik *${p}clue*\n` +
          `│ 🏳️ Skip: ketik *${p}nyerah*\n` +
          `└─────────────────`;

        const sentMsg = await reply(caption);
        const msgId   = sentMsg?.key?.id || sentMsg?.id || `asahotak_${Date.now()}`;

        const timer = setTimeout(async () => {
          if (asahotakStore.has(jid)) {
            asahotakStore.delete(jid);
            try {
              await client.message.send(jid, `⏰ *Waktu habis!*\n\nJawabannya adalah: *${jawaban}*`);
            } catch { /* non-critical */ }
          }
        }, TIMEOUT_MS);

        asahotakStore.set(jid, { soal, jawaban, msgId, timer, hintUsed: false, starter: sender });

      } catch (e) {
        await react('❌');
        await reply(`❌ Gagal ambil soal: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── clue — bantuan universal untuk semua game aktif ─────────────────────
    case 'clue': {
      if (!activeGame) {
        await reply(`❗ Tidak ada game aktif saat ini.`);
        return true;
      }

      // asahotak — sembunyikan konsonan (sama seperti .clue)
      if (activeGame === 'asahotak') {
        const s = asahotakStore.get(jid);
        s.hintUsed = true;
        const clue = s.jawaban.replace(/[bcdfghjklmnpqrstvwxyz]/gi, '_');
        await reply(`💡 *Clue Asah Otak:*\n\n\`${clue}\``);
        return true;
      }

      // caklontong — sembunyikan vokal dari jawaban
      if (activeGame === 'caklontong') {
        const s    = clStore.get(jid);
        const clue = s.answer.replace(/[aiueo]/gi, '_');
        await reply(`💡 *Clue Cak Lontong:*\n\n\`${clue}\``);
        return true;
      }

      // family100 — huruf pertama setiap jawaban yang belum ditemukan
      if (activeGame === 'family100') {
        const s    = f100Store.get(jid);
        const clue = s.sisa.map((j, i) => `• ${j[0].toUpperCase()}${'_'.repeat(j.length - 1)}`).join('\n');
        await reply(`💡 *Clue Family 100:*\n\nHuruf pertama jawaban yang tersisa:\n${clue}`);
        return true;
      }

      // fisika/kuisislami/math — eliminasi 1 pilihan salah (50/50)
      if (activeGame === 'fisika' || activeGame === 'kuisislami' || activeGame === 'math') {
        const store   = activeGame === 'fisika' ? fisikaStore : activeGame === 'kuisislami' ? islamiStore : mathStore;
        const s       = store.get(jid);
        const huruf   = ['A', 'B', 'C', 'D'];
        // Kumpulkan pilihan salah
        const salah   = huruf.filter(h => h !== s.jawabanHuruf);
        // Eliminasi satu secara random
        const elim    = salah[Math.floor(Math.random() * salah.length)];
        const sisa    = huruf.filter(h => h !== elim);
        const teks    = sisa.map((h, i) => `${h}. ${s.pilihan[huruf.indexOf(h)]}`).join('\n');
        await reply(`💡 *Clue (eliminasi pilihan ${elim}):*\n\n${teks}`);
        return true;
      }

      // siapakahaku — reveal huruf pertama dan terakhir
      if (activeGame === 'siapakahaku') {
        const s    = siapakahakuStore.get(jid);
        const kata = s.jawaban.split(' ').map(w =>
          w.length <= 2 ? w : `${w[0]}${'_'.repeat(w.length - 2)}${w[w.length - 1]}`
        ).join(' ');
        await reply(`💡 *Clue Siapa Aku:*\n\n\`${kata}\``);
        return true;
      }

      // singkatan — reveal huruf pertama setiap kata kepanjangan
      if (activeGame === 'singkatan') {
        const s    = singkatanStore.get(jid);
        const clue = s.kepanjangan.split(' ').map(w => `${w[0]}${'_'.repeat(w.length - 1)}`).join(' ');
        await reply(`💡 *Clue Singkatan:*\n\n\`${clue}\``);
        return true;
      }

      // susunkata — reveal posisi 2 huruf yang benar
      if (activeGame === 'susunkata') {
        const s      = susunKataStore.get(jid);
        const jaw    = s.jawaban.toUpperCase();
        // Pilih 2 posisi random untuk di-reveal
        const posisi = [];
        while (posisi.length < Math.min(2, jaw.length)) {
          const p = Math.floor(Math.random() * jaw.length);
          if (!posisi.includes(p)) posisi.push(p);
        }
        const clue = jaw.split('').map((h, i) => posisi.includes(i) ? h : '_').join('');
        await reply(`💡 *Clue Susun Kata:*\n\n\`${clue}\`\n_(huruf di posisi yang benar di-reveal)_`);
        return true;
      }

      // tebakanime — reveal studio + tahun rilis
      if (activeGame === 'tebakanime') {
        const s = tebakAnimeStore.get(jid);
        await reply(`💡 *Clue Tebak Anime:*\n\n🏢 Studio: *${s.studio}*\n📅 Tahun: *${s.tahunRilis}*\n🎬 Tipe: *${s.tipe}*`);
        return true;
      }

      // tebakbendera — reveal huruf pertama nama negara
      if (activeGame === 'tebakbendera') {
        const s    = tebakBenderaStore.get(jid);
        const clue = s.nama.split(' ').map(w => `${w[0]}${'_'.repeat(w.length - 1)}`).join(' ');
        await reply(`💡 *Clue Tebak Bendera:*\n\n${s.bendera} \`${clue}\``);
        return true;
      }

      // tebakchara — reveal jumlah karakter dalam nama
      if (activeGame === 'tebakchara') {
        const s    = tebakCharaStore.get(jid);
        const clue = s.name.split(',').map(w => w.trim()).map(w =>
          `${w[0]}${'_'.repeat(w.length - 1)}`
        ).join(', ');
        await reply(`💡 *Clue Tebak Karakter:*\n\n\`${clue}\`\n🎌 Anime: *${s.anime[0] || '-'}*`);
        return true;
      }

      // tebakgambar — reveal jumlah kata (spasi dipertahankan biar kebaca)
      if (activeGame === 'tebakgambar') {
        const s = tebakGambarStore.get(jid);
        if (!s) { await reply(`❗ Soal tebak gambar udah nggak aktif.`); return true; }
        const pet = s.jawaban.split(' ').map(w => `${w[0]}${'_'.repeat(w.length - 1)}`).join(' ');
        await reply(`💡 *Clue Tebak Gambar:*\n\n\`${pet}\`\n_${s.jawaban.replace(/[^\s]/g, '_')}_ (${s.jawaban.length} huruf)`);
        return true;
      }

      await reply(`❗ Tidak ada clue tersedia untuk game *${activeGame}*.`);
      return true;
    }

    // ── caklontong — mulai game ───────────────────────────────────────────────
    case 'caklontong': {
      if (activeGame === 'caklontong') {
        const s = clStore.get(jid);
        await reply(`⚠️ Masih ada soal cak lontong aktif!\n\n_"${s.question}"_\n\nKetik *${p}nyerah* untuk skip.`);
        return true;
      } else if (activeGame) {
        await reply(`⚠️ Masih ada game *${activeGame}* aktif di sini!\nKetik *${p}nyerah* untuk mengakhirinya dulu.`);
        return true;
      }

      try {
        const axios = require('axios');
        await react('😂');

        const { data } = await axios.get(`${process.env.BASE_API}api/game/caklontong`, {
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 15000,
        });

        const question = data?.results?.question;
        const answer   = data?.results?.answer;
        const detail   = data?.results?.detail || '';
        if (!question || !answer) throw new Error('Format data soal tidak valid dari API');

        const caption =
          `😂 *CAK LONTONG*\n\n` +
          `❓ ${question}\n\n` +
          `┌─────────────────\n` +
          `│ ⏱️ Timeout: *${TIMEOUT_MS / 1000} detik*\n` +
          `│ 🏳️ Reveal: ketik *${p}nyerah*\n` +
          `└─────────────────\n\n` +
          `_Tebak dulu, siapapun yang ikut tebak dapat reward!_`;

        await reply(caption);

        const timer = setTimeout(async () => {
          if (clStore.has(jid)) {
            const s = clStore.get(jid);
            clStore.delete(jid);
            await rewardParticipants(botData.id, s.participants);
            const jumlah = s.participants.size;
            try {
              await client.message.send(jid,
                `⏰ *Waktu habis!*\n\n` +
                `❓ Soal: _${s.question}_\n` +
                `💡 Jawaban: *${s.answer}*\n\n` +
                `📖 _${s.detail}_\n\n` +
                (jumlah > 0
                  ? `🎉 *${jumlah} orang* ikut tebak dan dapat reward partisipasi!`
                  : `😅 Tidak ada yang tebak...`)
              );
            } catch { /* non-critical */ }
          }
        }, TIMEOUT_MS);

        clStore.set(jid, { question, answer, detail, timer, participants: new Set(), starter: sender });

      } catch (e) {
        await react('❌');
        await reply(`❌ Gagal ambil soal: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── family100 — mulai game ────────────────────────────────────────────────
    case 'family100': {
      if (activeGame === 'family100') {
        const s     = f100Store.get(jid);
        const board = buildBoard(s.jawaban, s.found);
        await reply(`⚠️ Masih ada game Family 100 aktif!\n\n❓ _${s.soal}_\n\n${board}\n\nKetik *${p}nyerah* untuk skip.`);
        return true;
      } else if (activeGame) {
        await reply(`⚠️ Masih ada game *${activeGame}* aktif di sini!\nKetik *${p}nyerah* untuk mengakhirinya dulu.`);
        return true;
      }

      try {
        const axios = require('axios');
        await react('👨‍👩‍👧‍👦');

        const { data } = await axios.get(`${process.env.BASE_API}api/game/family100`, {
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 15000,
        });

        const soal    = data?.results?.soal;
        const jawaban = data?.results?.jawaban;
        if (!soal || !Array.isArray(jawaban) || jawaban.length === 0)
          throw new Error('Format data soal tidak valid dari API');

        const jawabanUniq = [...new Set(jawaban)];
        const boardAwal   = jawabanUniq.map((_, i) => `${i + 1}. ____`).join('\n');

        const caption =
          `👨‍👩‍👧‍👦 *FAMILY 100*\n\n` +
          `❓ ${soal}\n\n` +
          `${boardAwal}\n\n` +
          `┌─────────────────\n` +
          `│ ⏱️ Timeout: *${TIMEOUT_F100_MS / 1000} detik*\n` +
          `│ 💡 Clue: ketik *${p}clue*\n` +
          `│ 🏳️ Skip: ketik *${p}nyerah*\n` +
          `└─────────────────\n\n` +
          `_Ketik jawaban untuk mengisi papan!_`;

        await reply(caption);

        const timer = setTimeout(async () => {
          if (f100Store.has(jid)) {
            const s     = f100Store.get(jid);
            const board = buildBoard(s.jawaban, s.found);
            f100Store.delete(jid);
            try {
              await client.message.send(jid,
                `⏰ *Waktu habis!*\n\n` +
                `❓ Soal: _${s.soal}_\n\n` +
                `${board}\n\n` +
                (s.sisa.length > 0
                  ? `💡 Jawaban yang belum ditemukan:\n${s.sisa.map(j => `• ${j}`).join('\n')}`
                  : `🎉 Semua jawaban sudah ditemukan!`)
              );
            } catch { /* non-critical */ }
          }
        }, TIMEOUT_F100_MS);

        f100Store.set(jid, {
          soal,
          jawaban:  jawabanUniq,
          sisa:     [...jawabanUniq],
          found:    new Map(),
          timer,
          starter:  sender,
        });

      } catch (e) {
        await react('❌');
        await reply(`❌ Gagal ambil soal: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── fisika — mulai game pilgan ────────────────────────────────────────────
    case 'fisika': {
      if (activeGame === 'fisika') {
        const s = fisikaStore.get(jid);
        await reply(`⚠️ Masih ada soal fisika aktif!\n\n_"${s.soal}"_\n\nJawab dulu (A/B/C/D) atau ketik *${p}nyerah* untuk skip.`);
        return true;
      } else if (activeGame) {
        await reply(`⚠️ Masih ada game *${activeGame}* aktif di sini!\nKetik *${p}nyerah* untuk mengakhirinya dulu.`);
        return true;
      }

      try {
        const axios = require('axios');
        await react('⚛️');

        const { data } = await axios.get(`${process.env.BASE_API}api/game/fisika`, {
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 15000,
        });

        const soal      = data?.results?.soal;
        const pilihan   = data?.results?.pilihan;
        const jawaban   = data?.results?.jawaban;
        const deskripsi = data?.results?.deskripsi || '';
        const level     = data?.results?.level || 'medium';
        if (!soal || !Array.isArray(pilihan) || !jawaban) throw new Error('Format data soal tidak valid dari API');

        const { jawabanHuruf, pilihanTeks } = parsePilgan(pilihan, jawaban);
        const levelEmoji = level === 'hard' ? '🔴' : level === 'medium' ? '🟡' : '🟢';

        const caption =
          `⚛️ *FISIKA*\n\n` +
          `${levelEmoji} Level: *${level.toUpperCase()}*\n\n` +
          `❓ ${soal}\n\n` +
          `${pilihanTeks}\n\n` +
          `┌─────────────────\n` +
          `│ ⏱️ Timeout: *${TIMEOUT_FISIKA / 1000} detik*\n` +
          `│ 💬 Jawab: ketik *A / B / C / D*\n` +
          `│ 💡 Clue: ketik *${p}clue*\n` +
          `│ 🏳️ Skip: ketik *${p}nyerah*\n` +
          `└─────────────────`;

        await reply(caption);

        const timer = setTimeout(async () => {
          if (fisikaStore.has(jid)) {
            fisikaStore.delete(jid);
            try {
              await client.message.send(jid,
                `⏰ *Waktu habis!*\n\n` +
                `💡 Jawaban: *${jawabanHuruf}. ${jawaban}*\n\n` +
                `📖 _${deskripsi}_`
              );
            } catch { /* non-critical */ }
          }
        }, TIMEOUT_FISIKA);

        fisikaStore.set(jid, { soal, pilihan, jawaban, jawabanHuruf, deskripsi, level, timer, starter: sender });

      } catch (e) {
        await react('❌');
        await reply(`❌ Gagal ambil soal: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── math — mulai game pilgan ──────────────────────────────────────────────
    case 'math': {
      if (activeGame === 'math') {
        const s = mathStore.get(jid);
        await reply(`⚠️ Masih ada soal math aktif!\n\n_"${s.soal}"_\n\nJawab dulu (A/B/C/D) atau ketik *${p}nyerah* untuk skip.`);
        return true;
      } else if (activeGame) {
        await reply(`⚠️ Masih ada game *${activeGame}* aktif di sini!\nKetik *${p}nyerah* untuk mengakhirinya dulu.`);
        return true;
      }

      try {
        const axios = require('axios');
        await react('🔢');

        const { data } = await axios.get(`${process.env.BASE_API}api/game/math`, {
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 15000,
        });

        const soal      = data?.results?.soal;
        const pilihan   = data?.results?.jawabanGanda;
        const jawaban   = data?.results?.jawaban;
        const deskripsi = data?.results?.deskripsi || '';
        const level     = data?.results?.level || 'medium';
        if (!soal || !Array.isArray(pilihan) || !jawaban) throw new Error('Format data soal tidak valid dari API');

        const { jawabanHuruf, pilihanTeks } = parsePilgan(pilihan, jawaban);
        const levelEmoji = level === 'hard' ? '🔴' : level === 'medium' ? '🟡' : '🟢';

        const caption =
          `🔢 *MATEMATIKA*\n\n` +
          `${levelEmoji} Level: *${level.toUpperCase()}*\n\n` +
          `❓ ${soal}\n\n` +
          `${pilihanTeks}\n\n` +
          `┌─────────────────\n` +
          `│ ⏱️ Timeout: *${TIMEOUT_FISIKA / 1000} detik*\n` +
          `│ 💬 Jawab: ketik *A / B / C / D*\n` +
          `│ 💡 Clue: ketik *${p}clue*\n` +
          `│ 🏳️ Skip: ketik *${p}nyerah*\n` +
          `└─────────────────`;

        await reply(caption);

        const timer = setTimeout(async () => {
          if (mathStore.has(jid)) {
            mathStore.delete(jid);
            try {
              await client.message.send(jid,
                `⏰ *Waktu habis!*\n\n` +
                `💡 Jawaban: *${jawabanHuruf}. ${jawaban}*\n\n` +
                `📖 _${deskripsi}_`
              );
            } catch { /* non-critical */ }
          }
        }, TIMEOUT_FISIKA);

        mathStore.set(jid, { soal, pilihan, jawaban, jawabanHuruf, deskripsi, level, timer, starter: sender });

      } catch (e) {
        await react('❌');
        await reply(`❌ Gagal ambil soal: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── kuisislami — mulai game pilgan ────────────────────────────────────────
    case 'kuisislami': {      if (activeGame === 'kuisislami') {
        const s = islamiStore.get(jid);
        await reply(`⚠️ Masih ada soal kuis islami aktif!\n\n_"${s.soal}"_\n\nJawab dulu (A/B/C/D) atau ketik *${p}nyerah* untuk skip.`);
        return true;
      } else if (activeGame) {
        await reply(`⚠️ Masih ada game *${activeGame}* aktif di sini!\nKetik *${p}nyerah* untuk mengakhirinya dulu.`);
        return true;
      }

      try {
        const axios = require('axios');
        await react('🕌');

        const { data } = await axios.get(`${process.env.BASE_API}api/game/kuisislami`, {
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 15000,
        });

        const soal      = data?.results?.soal;
        const pilihan   = data?.results?.pilihan;
        const jawaban   = data?.results?.jawaban;
        const deskripsi = data?.results?.deskripsi || '';
        if (!soal || !Array.isArray(pilihan) || !jawaban) throw new Error('Format data soal tidak valid dari API');

        const { jawabanHuruf, pilihanTeks } = parsePilgan(pilihan, jawaban);

        const caption =
          `🕌 *KUIS ISLAMI*\n\n` +
          `❓ ${soal}\n\n` +
          `${pilihanTeks}\n\n` +
          `┌─────────────────\n` +
          `│ ⏱️ Timeout: *${TIMEOUT_FISIKA / 1000} detik*\n` +
          `│ 💬 Jawab: ketik *A / B / C / D*\n` +
          `│ 💡 Clue: ketik *${p}clue*\n` +
          `│ 🏳️ Skip: ketik *${p}nyerah*\n` +
          `└─────────────────`;

        await reply(caption);

        const timer = setTimeout(async () => {
          if (islamiStore.has(jid)) {
            islamiStore.delete(jid);
            try {
              await client.message.send(jid,
                `⏰ *Waktu habis!*\n\n` +
                `💡 Jawaban: *${jawabanHuruf}. ${jawaban}*\n\n` +
                `📖 _${deskripsi}_`
              );
            } catch { /* non-critical */ }
          }
        }, TIMEOUT_FISIKA);

        islamiStore.set(jid, { soal, pilihan, jawaban, jawabanHuruf, deskripsi, timer, starter: sender });

      } catch (e) {
        await react('❌');
        await reply(`❌ Gagal ambil soal: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── siapakahaku — mulai game ──────────────────────────────────────────────
    case 'siapakahaku': {
      if (activeGame === 'siapakahaku') {
        const s = siapakahakuStore.get(jid);
        await reply(`⚠️ Masih ada soal siapa aku aktif!\n\n_"${s.soal}"_\n\nJawab dulu atau ketik *${p}nyerah* untuk skip.`);
        return true;
      } else if (activeGame) {
        await reply(`⚠️ Masih ada game *${activeGame}* aktif di sini!\nKetik *${p}nyerah* untuk mengakhirinya dulu.`);
        return true;
      }

      try {
        const axios = require('axios');
        await react('🕵️');

        const { data } = await axios.get(`${process.env.BASE_API}api/game/siapakahaku`, {
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 15000,
        });

        const soal    = data?.results?.soal;
        const jawaban = data?.results?.jawaban;
        if (!soal || !jawaban) throw new Error('Format data soal tidak valid dari API');

        const caption =
          `🕵️ *SIAPA KAMU?*\n\n` +
          `❓ ${soal}\n\n` +
          `┌─────────────────\n` +
          `│ ⏱️ Timeout: *${TIMEOUT_MS / 1000} detik*\n` +
          `│ 💡 Clue: ketik *${p}clue*\n` +
          `│ 🏳️ Skip: ketik *${p}nyerah*\n` +
          `└─────────────────`;

        await reply(caption);

        const timer = setTimeout(async () => {
          if (siapakahakuStore.has(jid)) {
            siapakahakuStore.delete(jid);
            try {
              await client.message.send(jid, `⏰ *Waktu habis!*\n\nJawabannya: *${jawaban}*`);
            } catch { /* non-critical */ }
          }
        }, TIMEOUT_MS);

        siapakahakuStore.set(jid, { soal, jawaban, timer, starter: sender });

      } catch (e) {
        await react('❌');
        await reply(`❌ Gagal ambil soal: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── singkatan — mulai game ────────────────────────────────────────────────
    case 'singkatan': {
      if (activeGame === 'singkatan') {
        const s = singkatanStore.get(jid);
        await reply(`⚠️ Masih ada soal singkatan aktif!\n\n_"${s.singkatan}"_\n\nJawab dulu atau ketik *${p}nyerah* untuk skip.`);
        return true;
      } else if (activeGame) {
        await reply(`⚠️ Masih ada game *${activeGame}* aktif di sini!\nKetik *${p}nyerah* untuk mengakhirinya dulu.`);
        return true;
      }

      try {
        const axios = require('axios');
        await react('🔤');

        const { data } = await axios.get(`${process.env.BASE_API}api/game/singkatan`, {
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 15000,
        });

        const singkatan    = data?.results?.singkatan;
        const kepanjangan  = data?.results?.kepanjangan;
        const deskripsi    = data?.results?.deskripsi || '';
        if (!singkatan || !kepanjangan) throw new Error('Format data soal tidak valid dari API');

        const caption =
          `🔤 *TEBAK SINGKATAN*\n\n` +
          `❓ Apa kepanjangan dari *${singkatan}*?\n\n` +
          `┌─────────────────\n` +
          `│ ⏱️ Timeout: *${TIMEOUT_MS / 1000} detik*\n` +
          `│ 💡 Clue: ketik *${p}clue*\n` +
          `│ 🏳️ Skip: ketik *${p}nyerah*\n` +
          `└─────────────────`;

        await reply(caption);

        const timer = setTimeout(async () => {
          if (singkatanStore.has(jid)) {
            singkatanStore.delete(jid);
            try {
              await client.message.send(jid,
                `⏰ *Waktu habis!*\n\n` +
                `💡 *${singkatan}* = *${kepanjangan}*\n\n` +
                `📖 _${deskripsi}_`
              );
            } catch { /* non-critical */ }
          }
        }, TIMEOUT_MS);

        singkatanStore.set(jid, { singkatan, kepanjangan, deskripsi, timer, starter: sender });

      } catch (e) {
        await react('❌');
        await reply(`❌ Gagal ambil soal: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── susunkata — mulai game ────────────────────────────────────────────────
    case 'susunkata': {
      if (activeGame === 'susunkata') {
        const s = susunKataStore.get(jid);
        await reply(`⚠️ Masih ada soal susun kata aktif!\n\n_"${s.soal}"_\n\nJawab dulu atau ketik *${p}nyerah* untuk skip.`);
        return true;
      } else if (activeGame) {
        await reply(`⚠️ Masih ada game *${activeGame}* aktif di sini!\nKetik *${p}nyerah* untuk mengakhirinya dulu.`);
        return true;
      }

      try {
        const axios = require('axios');
        await react('🔀');

        const { data } = await axios.get(`${process.env.BASE_API}api/game/susunkata`, {
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 15000,
        });

        const soal    = data?.results?.soal;
        const jawaban = data?.results?.jawaban;
        const tipe    = data?.results?.tipe || '';
        if (!soal || !jawaban) throw new Error('Format data soal tidak valid dari API');

        const caption =
          `🔀 *SUSUN KATA*\n\n` +
          `🏷️ Tipe: *${tipe}*\n\n` +
          `🔤 Susun huruf-huruf ini menjadi sebuah kata:\n` +
          `*${soal}*\n\n` +
          `┌─────────────────\n` +
          `│ ⏱️ Timeout: *${TIMEOUT_MS / 1000} detik*\n` +
          `│ 💡 Clue: ketik *${p}clue*\n` +
          `│ 🏳️ Skip: ketik *${p}nyerah*\n` +
          `└─────────────────`;

        await reply(caption);

        const timer = setTimeout(async () => {
          if (susunKataStore.has(jid)) {
            susunKataStore.delete(jid);
            try {
              await client.message.send(jid,
                `⏰ *Waktu habis!*\n\n` +
                `💡 *${soal}* → *${jawaban}*`
              );
            } catch { /* non-critical */ }
          }
        }, TIMEOUT_MS);

        susunKataStore.set(jid, { soal, jawaban, tipe, timer, starter: sender });

      } catch (e) {
        await react('❌');
        await reply(`❌ Gagal ambil soal: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── tebakchara — mulai game ───────────────────────────────────────────────
    case 'tebakchara': {
      if (activeGame === 'tebakchara') {
        await reply(`⚠️ Masih ada soal tebak karakter aktif!\n\nJawab dulu atau ketik *${p}nyerah* untuk skip.`);
        return true;
      } else if (activeGame) {
        await reply(`⚠️ Masih ada game *${activeGame}* aktif di sini!\nKetik *${p}nyerah* untuk mengakhirinya dulu.`);
        return true;
      }

      try {
        const axios = require('axios');
        await react('🎭');

        const { data } = await axios.get(`${process.env.BASE_API}api/game/tebakchara`, {
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 15000,
        });

        const name  = data?.results?.name;
        const image = data?.results?.image;
        const anime = data?.results?.anime || [];
        if (!name || !image) throw new Error('Format data soal tidak valid dari API');

        // Download + konversi ke JPEG
        const sharp     = require('sharp');
        const imgResp   = await axios.get(image, { responseType: 'arraybuffer', timeout: 15000 });
        const imgBuffer = await sharp(Buffer.from(imgResp.data)).jpeg({ quality: 90 }).toBuffer();

        const caption =
          `🎭 *TEBAK KARAKTER ANIME*\n\n` +
          `🎌 Muncul di: ${anime.slice(0, 2).join(', ')}${anime.length > 2 ? `, +${anime.length - 2} lagi` : ''}\n\n` +
          `_Siapa karakter ini?_\n\n` +
          `┌─────────────────\n` +
          `│ ⏱️ Timeout: *${TIMEOUT_MS / 1000} detik*\n` +
          `│ 💬 Ketik nama karakternya!\n` +
          `│ 💡 Clue: ketik *${p}clue*\n` +
          `│ 🏳️ Skip: ketik *${p}nyerah*\n` +
          `└─────────────────`;

        await client.message.send(jid, {
          type:     'image',
          media:    imgBuffer,
          mimetype: 'image/jpeg',
          caption,
        });

        const timer = setTimeout(async () => {
          if (tebakCharaStore.has(jid)) {
            tebakCharaStore.delete(jid);
            try {
              await client.message.send(jid, `⏰ *Waktu habis!*\n\n🎭 Karakternya: *${name}*`);
            } catch { /* non-critical */ }
          }
        }, TIMEOUT_MS);

        tebakCharaStore.set(jid, { name, image, anime, timer, starter: sender });

      } catch (e) {
        await react('❌');
        await reply(`❌ Gagal ambil soal: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── tebakbendera — mulai game ─────────────────────────────────────────────
    case 'tebakbendera': {
      if (activeGame === 'tebakbendera') {
        const s = tebakBenderaStore.get(jid);
        await reply(`⚠️ Masih ada soal tebak bendera aktif!\n\n${s.bendera}\n\nJawab dulu atau ketik *${p}nyerah* untuk skip.`);
        return true;
      } else if (activeGame) {
        await reply(`⚠️ Masih ada game *${activeGame}* aktif di sini!\nKetik *${p}nyerah* untuk mengakhirinya dulu.`);
        return true;
      }

      try {
        const axios = require('axios');
        await react('🌍');

        const { data } = await axios.get(`${process.env.BASE_API}api/game/tebakbendera`, {
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 15000,
        });

        const bendera = data?.results?.bendera;
        const nama    = data?.results?.nama;
        if (!bendera || !nama) throw new Error('Format data soal tidak valid dari API');

        const caption =
          `🌍 *TEBAK BENDERA*\n\n` +
          `${bendera}\n\n` +
          `_Negara manakah bendera di atas?_\n\n` +
          `┌─────────────────\n` +
          `│ ⏱️ Timeout: *${TIMEOUT_MS / 1000} detik*\n` +
          `│ 💡 Clue: ketik *${p}clue*\n` +
          `│ 🏳️ Skip: ketik *${p}nyerah*\n` +
          `└─────────────────`;

        await reply(caption);

        const timer = setTimeout(async () => {
          if (tebakBenderaStore.has(jid)) {
            tebakBenderaStore.delete(jid);
            try {
              await client.message.send(jid, `⏰ *Waktu habis!*\n\n${bendera} Negaranya: *${nama}*`);
            } catch { /* non-critical */ }
          }
        }, TIMEOUT_MS);

        tebakBenderaStore.set(jid, { bendera, nama, timer, starter: sender });

      } catch (e) {
        await react('❌');
        await reply(`❌ Gagal ambil soal: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── tebakanime — mulai game ───────────────────────────────────────────────
    case 'tebakanime': {
      if (activeGame === 'tebakanime') {
        const s = tebakAnimeStore.get(jid);
        await reply(`⚠️ Masih ada soal tebak anime aktif!\n\nJawab dulu atau ketik *${p}nyerah* untuk skip.`);
        return true;
      } else if (activeGame) {
        await reply(`⚠️ Masih ada game *${activeGame}* aktif di sini!\nKetik *${p}nyerah* untuk mengakhirinya dulu.`);
        return true;
      }

      try {
        const axios = require('axios');
        await react('🎌');

        const { data } = await axios.get(`${process.env.BASE_API}api/game/tebakanime`, {
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 15000,
        });

        const gambar     = data?.results?.gambar;
        const deskripsi  = data?.results?.deskripsi || '';
        const tahunRilis = data?.results?.tahun_rilis || '?';
        const tipe       = data?.results?.tipe || '?';
        const genre      = data?.results?.genre || [];
        const studio     = data?.results?.studio || '?';
        const score      = data?.results?.score || '?';
        const jawaban    = data?.results?.jawaban;
        if (!gambar || !jawaban) throw new Error('Format data soal tidak valid dari API');

        // Download gambar dan konversi ke JPEG supaya tampil di semua platform
        const imgResp   = await axios.get(gambar, { responseType: 'arraybuffer', timeout: 15000 });
        const sharp     = require('sharp');
        const imgBuffer = await sharp(Buffer.from(imgResp.data)).jpeg({ quality: 90 }).toBuffer();

        const caption =
          `🎌 *TEBAK ANIME*\n\n` +
          `🎬 Tipe: *${tipe}* | 📅 ${tahunRilis}\n` +
          `🏷️ Genre: ${genre.join(', ')}\n` +
          `🏢 Studio: *${studio}*\n` +
          `⭐ Score: *${score}*\n\n` +
          `_${deskripsi.length > 200 ? deskripsi.slice(0, 200) + '...' : deskripsi}_\n\n` +
          `┌─────────────────\n` +
          `│ ⏱️ Timeout: *${TIMEOUT_MS / 1000} detik*\n` +
          `│ 💬 Ketik nama anime!\n` +
          `│ 💡 Clue: ketik *${p}clue*\n` +
          `│ 🏳️ Skip: ketik *${p}nyerah*\n` +
          `└─────────────────`;

        await client.message.send(jid, {
          type:     'image',
          media:    imgBuffer,
          mimetype: 'image/jpeg',
          caption,
        });

        const timer = setTimeout(async () => {
          if (tebakAnimeStore.has(jid)) {
            tebakAnimeStore.delete(jid);
            try {
              await client.message.send(jid, `⏰ *Waktu habis!*\n\n🎌 Anime: *${jawaban}*`);
            } catch { /* non-critical */ }
          }
        }, TIMEOUT_MS);

        tebakAnimeStore.set(jid, { gambar, jawaban, deskripsi, tahunRilis, tipe, genre, studio, score, timer, starter: sender });

      } catch (e) {
        await react('❌');
        await reply(`❌ Gagal ambil soal: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── tebakgambar — mulai game (gambar dari endpoint /api/game/tebak-gambar) ──
    case 'tebakgambar':
    case 'tebak-gambar': {
      if (activeGame === 'tebakgambar') {
        const s = tebakGambarStore.get(jid);
        await reply(`⚠️ Masih ada soal tebak gambar aktif! _(soal #${s.index})_\n\nJawab dulu atau ketik *${p}nyerah* untuk skip.`);
        return true;
      } else if (activeGame) {
        await reply(`⚠️ Masih ada game *${activeGame}* aktif di sini!\nKetik *${p}nyerah* untuk mengakhirinya dulu.`);
        return true;
      }

      try {
        const axios = require('axios');
        await react('🖼️');

        const { data } = await axios.get(`${process.env.BASE_API}api/game/tebak-gambar`, {
          headers: { 'X-API-Key': process.env.KEY_API },
          timeout: 15000,
        });

        const index   = data?.results?.index;
        const gambar  = data?.results?.image;
        const jawaban = data?.results?.answer;
        if (!gambar || !jawaban) throw new Error('Format data soal tidak valid dari API');

        // Download + konversi JPEG, sama kaya tebakanime biar tampil di semua platform
        const imgResp   = await axios.get(gambar, { responseType: 'arraybuffer', timeout: 15000 });
        const sharp     = require('sharp');
        const imgBuffer = await sharp(Buffer.from(imgResp.data)).jpeg({ quality: 90 }).toBuffer();

        const caption =
          `🖼️ *TEBAK GAMBAR* _(soal #${index})_\n\n` +
          `_Tebak maksud gambar di atas — jawabannya bisa 1 kata atau 1 kalimat._\n\n` +
          `┌─────────────────\n` +
          `│ ⏱️ Timeout: *${TIMEOUT_MS / 1000} detik*\n` +
          `│ 💬 Ketik jawabannya langsung\n` +
          `│ 💡 Clue: ketik *${p}clue*\n` +
          `│ 🏳️ Skip: ketik *${p}nyerah*\n` +
          `└─────────────────`;

        await client.message.send(jid, {
          type:     'image',
          media:    imgBuffer,
          mimetype: 'image/jpeg',
          caption,
        });

        const timer = setTimeout(async () => {
          if (tebakGambarStore.has(jid)) {
            tebakGambarStore.delete(jid);
            try {
              await client.message.send(jid, `⏰ *Waktu habis!*\n\n🖼️ Jawabannya: *${jawaban}*`);
            } catch { /* non-critical */ }
          }
        }, TIMEOUT_MS);

        tebakGambarStore.set(jid, { index, gambar, jawaban, timer, starter: sender });

      } catch (e) {
        await react('❌');
        await reply(`❌ Gagal ambil soal: ${rapikanError(e)}`);
      }
      return true;
    }

    // ── nyerah — universal stop untuk semua game ─────────────────────────────
    case 'nyerah':
    case 'stopasotak': {
      if (!activeGame) {
        await reply(`❗ Tidak ada game aktif saat ini.`);
        return true;
      }

      const session   = sharedStore.get(jid);
      const isStarter = session?.starter === sender;
      if (!isStarter && !ctx.isOwner && !ctx.isAdmin) {
        await reply(`⛔ Hanya yang memulai game, owner, atau admin yang bisa menghentikan game.`);
        return true;
      }

      if (activeGame === 'asahotak') {
        const s = asahotakStore.get(jid);
        clearTimeout(s.timer);
        asahotakStore.delete(jid);
        await reply(
          `🏳️ *Menyerah!*\n\n` +
          `❓ Soal: _${s.soal}_\n` +
          `💡 Jawaban: *${s.jawaban}*`
        );
        return true;
      }

      if (activeGame === 'caklontong') {
        const s = clStore.get(jid);
        clearTimeout(s.timer);
        clStore.delete(jid);
        await rewardParticipants(botData.id, s.participants);
        const jumlah = s.participants.size;
        await reply(
          `🏳️ *Menyerah!*\n\n` +
          `❓ Soal: _${s.question}_\n` +
          `💡 Jawaban: *${s.answer}*\n\n` +
          `📖 _${s.detail}_\n\n` +
          (jumlah > 0
            ? `🎉 *${jumlah} orang* ikut tebak dan dapat reward partisipasi!`
            : `😅 Tidak ada yang tebak...`)
        );
        return true;
      }

      if (activeGame === 'family100') {
        const s     = f100Store.get(jid);
        const board = buildBoard(s.jawaban, s.found);
        clearTimeout(s.timer);
        f100Store.delete(jid);
        await reply(
          `🏳️ *Menyerah!*\n\n` +
          `❓ Soal: _${s.soal}_\n\n` +
          `${board}\n\n` +
          (s.sisa.length > 0
            ? `💡 Jawaban yang belum ditemukan:\n${s.sisa.map(j => `• ${j}`).join('\n')}`
            : `🎉 Semua jawaban sudah ditemukan!`)
        );
        return true;
      }

      if (activeGame === 'fisika') {
        const s = fisikaStore.get(jid);
        clearTimeout(s.timer);
        fisikaStore.delete(jid);
        await reply(
          `🏳️ *Menyerah!*\n\n` +
          `💡 Jawaban: *${s.jawabanHuruf}. ${s.jawaban}*\n\n` +
          `📖 _${s.deskripsi}_`
        );
        return true;
      }

      if (activeGame === 'kuisislami') {
        const s = islamiStore.get(jid);
        clearTimeout(s.timer);
        islamiStore.delete(jid);
        await reply(
          `🏳️ *Menyerah!*\n\n` +
          `💡 Jawaban: *${s.jawabanHuruf}. ${s.jawaban}*\n\n` +
          `📖 _${s.deskripsi}_`
        );
        return true;
      }

      if (activeGame === 'math') {
        const s = mathStore.get(jid);
        clearTimeout(s.timer);
        mathStore.delete(jid);
        await reply(
          `🏳️ *Menyerah!*\n\n` +
          `💡 Jawaban: *${s.jawabanHuruf}. ${s.jawaban}*\n\n` +
          `📖 _${s.deskripsi}_`
        );
        return true;
      }

      if (activeGame === 'siapakahaku') {
        const s = siapakahakuStore.get(jid);
        clearTimeout(s.timer);
        siapakahakuStore.delete(jid);
        await reply(
          `🏳️ *Menyerah!*\n\n` +
          `💡 Jawaban: *${s.jawaban}*`
        );
        return true;
      }

      if (activeGame === 'singkatan') {
        const s = singkatanStore.get(jid);
        clearTimeout(s.timer);
        singkatanStore.delete(jid);
        await reply(
          `🏳️ *Menyerah!*\n\n` +
          `💡 *${s.singkatan}* = *${s.kepanjangan}*\n\n` +
          `📖 _${s.deskripsi}_`
        );
        return true;
      }

      if (activeGame === 'susunkata') {
        const s = susunKataStore.get(jid);
        clearTimeout(s.timer);
        susunKataStore.delete(jid);
        await reply(
          `🏳️ *Menyerah!*\n\n` +
          `💡 *${s.soal}* → *${s.jawaban}*`
        );
        return true;
      }

      if (activeGame === 'tebakanime') {
        const s = tebakAnimeStore.get(jid);
        clearTimeout(s.timer);
        tebakAnimeStore.delete(jid);
        await reply(
          `🏳️ *Menyerah!*\n\n` +
          `🎌 Anime: *${s.jawaban}*\n` +
          `⭐ Score: *${s.score}* | 🎬 ${s.tipe} | 📅 ${s.tahunRilis}`
        );
        return true;
      }

      if (activeGame === 'tebakbendera') {
        const s = tebakBenderaStore.get(jid);
        clearTimeout(s.timer);
        tebakBenderaStore.delete(jid);
        await reply(
          `🏳️ *Menyerah!*\n\n` +
          `${s.bendera} Negaranya: *${s.nama}*`
        );
        return true;
      }

      if (activeGame === 'tebakchara') {
        const s = tebakCharaStore.get(jid);
        clearTimeout(s.timer);
        tebakCharaStore.delete(jid);
        await reply(
          `🏳️ *Menyerah!*\n\n` +
          `🎭 Karakternya: *${s.name}*\n` +
          `🎌 Anime: ${s.anime[0] || '-'}`
        );
        return true;
      }

      if (activeGame === 'tebakgambar') {
        const s = tebakGambarStore.get(jid);
        clearTimeout(s.timer);
        tebakGambarStore.delete(jid);
        await reply(
          `🏳️ *Menyerah!*\n\n` +
          `🖼️ Jawabannya: *${s.jawaban}* _(soal #${s.index})_`
        );
        return true;
      }

      return true;
    }

    default:
      return false;
  }
};

// Command yang kena limit untuk user biasa
module.exports.limitedCmds = new Set(['asahotak', 'clue', 'caklontong', 'family100', 'fisika', 'kuisislami', 'math', 'siapakahaku', 'singkatan', 'susunkata', 'tebakanime', 'tebakbendera', 'tebakchara', 'tebakgambar', 'nyerah']);
