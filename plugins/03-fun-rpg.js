'use strict';

/**
 * plugins/03-fun-rpg.js
 * Commands: profil, jodoh, suitpvp,
 *           mulaigiveaway, ikut, rollgiveaway, cekgiveaway, cekmenang, hapusgiveaway,
 *           rpg, daily, store, beli, inventory, pakai, topkoin
 */

const { rapikanError } = require('../engine/pesanError');
const crypto = require('crypto');
const { pool } = require('../config/database');
const { isJlidUser } = require('../engine/jid');

// ─── In-memory stores ────────────────────────────────────────────────────────
const tembakStore    = new Map(); // sender -> target jid
const giveawayStore  = new Map(); // groupJid -> { title, prize, host, participants: Set }
const suitGames      = new Map(); // roomId -> room object
const tictactoeGames = new Map(); // roomId -> game object
const dungeonRooms   = new Map(); // roomId -> dungeon room object
const koboyStore     = new Map(); // sender -> { penjahat, botId, expires }
const airdropStore   = new Map(); // sender -> { angka, botId, expires }

const DAILY_COOLDOWN  = 86400 * 1000;
const DAILY_REWARD    = 500;
const KERJA_COOLDOWN  = 3600 * 1000;       // 1 jam
const MANCING_COOLDOWN = 30 * 60 * 1000;  // 30 menit

const IKAN_TABLE = [
  { nama: 'Ikan Mas',       tier: 'Kecil',  min: 30,   max: 80,   emoji: '🐟', xp: 3  },
  { nama: 'Ikan Lele',      tier: 'Kecil',  min: 40,   max: 100,  emoji: '🐟', xp: 3  },
  { nama: 'Ikan Nila',      tier: 'Sedang', min: 100,  max: 200,  emoji: '🐠', xp: 6  },
  { nama: 'Ikan Gurame',    tier: 'Sedang', min: 150,  max: 280,  emoji: '🐠', xp: 7  },
  { nama: 'Ikan Tuna',      tier: 'Besar',  min: 300,  max: 500,  emoji: '🐡', xp: 12 },
  { nama: 'Ikan Salmon',    tier: 'Besar',  min: 350,  max: 600,  emoji: '🐡', xp: 13 },
  { nama: 'Ikan Arwana',    tier: 'Langka', min: 800,  max: 1500, emoji: '🦈', xp: 25 },
  { nama: 'Ikan Duyung',    tier: 'Langka', min: 1000, max: 2000, emoji: '🧜', xp: 30 },
  { nama: 'Sampah Plastik', tier: 'Sampah', min: 0,    max: 5,    emoji: '🗑️', xp: 0  },
];

// Bobot kemunculan berdasarkan tier
const IKAN_WEIGHTS = { Kecil: 40, Sedang: 30, Besar: 15, Langka: 5, Sampah: 10 };

const SUIT_WIN_MAP  = { batu: 'gunting', gunting: 'kertas', kertas: 'batu' };

const STORE_ITEMS = [
  { id: 1,  name: 'Pedang Kayu',   price: 200,   type: 'weapon', lv: 1, effect: '+5 ATK' },
  { id: 2,  name: 'Tameng Besi',   price: 350,   type: 'armor',  lv: 1, effect: '+4 DEF' },
  { id: 3,  name: 'Ramuan Health', price: 150,   type: 'potion', effect: '+50 Health' },
  { id: 4,  name: 'Buku Sihir',    price: 500,   type: 'magic',  effect: '+20 MP' },
  { id: 5,  name: 'Kunci Emas',    price: 1000,  type: 'special',effect: 'Buka kotak misteri' },
  { id: 6,  name: 'Pedang Besi',   price: 2500,  type: 'weapon', lv: 2, effect: '+10 ATK' },
  { id: 7,  name: 'Tameng Baja',   price: 3000,  type: 'armor',  lv: 2, effect: '+8 DEF' },
  { id: 8,  name: 'Pedang Baja',   price: 12000, type: 'weapon', lv: 3, effect: '+15 ATK' },
  { id: 9,  name: 'Tameng Titan',  price: 15000, type: 'armor',  lv: 3, effect: '+12 DEF' },
  { id: 10, name: 'Pedang Naga',   price: 60000, type: 'weapon', lv: 4, effect: '+20 ATK' },
  { id: 11, name: 'Tameng Naga',   price: 75000, type: 'armor',  lv: 4, effect: '+16 DEF' },
];

// ─── Energi ──────────────────────────────────────────────────────────────────
// Energi = ongkos aktivitas grind. Regen otomatis, jadi nggak butuh `.tidur`.
const ENERGI_MAKS       = 100;
const ENERGI_REGEN_MENIT = 2;   // 1 poin / 2 menit

// ponytail: regen cuma jalan saat ada command. Kalau nanti butuh energi "live",
// panggil energiSekarang() juga di `.profil`/`.rpg` (udah aman, cuma baca).
/** Nilai energi terkini (udah dihitung regen-nya) — TANPA nulis DB. */
function energiSekarang(member) {
  const menit = Math.max(0, (Date.now() - toEpochMs(member.last_energi)) / 60000);
  const naik  = Math.floor(menit / ENERGI_REGEN_MENIT);
  // Belum pernah ada jam regen (user lama) → anggap full, jangan hukum user lama.
  if (!member.last_energi) return ENERGI_MAKS;
  return Math.min(ENERGI_MAKS, (Number(member.energi) || 0) + naik);
}

/**
 * Gerbang energi: regen dulu, cek cukup, baru tulis DB sekali.
 * Return { ok, energi } — kalau ok:false, DB nggak disentuh.
 */
async function pakaiEnergi(botId, jid, member, biaya) {
  const energi = energiSekarang(member);
  if (energi < biaya) return { ok: false, energi, biaya };
  await updateMember(botId, jid, {
    energi: energi - biaya,
    last_energi: new Date().toISOString().slice(0, 19).replace('T', ' '),
    // ponytail: read-modify-write, bukan `energi = energi - ?`. Dua command
    // barengan bisa bikin 1 poin hilang — nggak masalah buat RPG chat.
  });
  return { ok: true, energi: energi - biaya, biaya };
}

/** Pesan seragam kalau energi kurang. */
function pesanEnergiKurang(energi, biaya) {
  const kurang = biaya - energi;
  const menit  = Math.ceil(kurang * ENERGI_REGEN_MENIT);
  return (
    `😴 *Energi kamu cuma ${energi}/${ENERGI_MAKS}* — butuh *${biaya}*.\n\n` +
    `Istirahat *${menit} menit* biar pulih ${kurang} poin.`
  );
}

/** Bar energi buat profil. */
function barEnergi(energi) {
  const isi = Math.round((energi / ENERGI_MAKS) * 10);
  return `${'█'.repeat(isi)}${'░'.repeat(10 - isi)} ${energi}/${ENERGI_MAKS}`;
}

// ─── Gear ────────────────────────────────────────────────────────────────────
const DUR_MAKS   = 100;
const BIAYA_REPAIR = 0.10;   // 10% harga item

/** Harga item store dengan type & lv tertentu — buat hitung biaya repair. */
function hargaGear(type, lv) {
  const item = STORE_ITEMS.find(i => i.type === type && i.lv === Number(lv));
  return item ? item.price : 0;
}

/** Biaya repair gear di level tertentu. 0 = nggak ada gear / level nggak dikenal. */
function biayaRepair(type, lv) {
  return Math.ceil(hargaGear(type, lv) * BIAYA_REPAIR);
}

/**
 * Baca argumen `.atm` / `.bank` jadi satu aksi. Pure — nggak nyentuh DB.
 *   []                    → { aksi: 'info' }
 *   ['100']               → { aksi: 'setor', jumlah: 100 }      (angka polos)
 *   ['all'] / ['semua']   → { aksi: 'setor', semua: true }
 *   ['simpan','100']      → { aksi: 'setor', jumlah: 100 }
 *   ['pull','100']        → { aksi: 'tarik', jumlah: 100 }
 *   ['pull','all']        → { aksi: 'tarik', semua: true }
 *   ngawur                → { aksi: 'bantuan' }
 */
function bacaAtm(args) {
  const a = (args[0] || '').toLowerCase();
  const b = (args[1] || '').toLowerCase();
  const semuaKata = w => w === 'all' || w === 'semua';

  if (!a || a === 'info' || a === 'saldo') return { aksi: 'info' };
  if (a === 'pull' || a === 'tarik' || a === 'ambil') {
    return semuaKata(b) ? { aksi: 'tarik', semua: true }
                        : { aksi: 'tarik', jumlah: parseInt(b, 10) };
  }
  // angka polos = setor. `.atm 100`
  if (/^\d+$/.test(a)) return { aksi: 'setor', jumlah: parseInt(a, 10) };
  if (semuaKata(a)) return { aksi: 'setor', semua: true };
  if (a === 'simpan' || a === 'setor' || a === 'taro') {
    return semuaKata(b) ? { aksi: 'setor', semua: true }
                        : { aksi: 'setor', jumlah: parseInt(b, 10) };
  }
  return { aksi: 'bantuan' };
}

// ─── Gear terpasang ──────────────────────────────────────────────────────────
// Level + durability disimpan di hewan_json.gear, bukan kolom baru.
// ponytail: kalau nanti gear perlu query lintas-user (mis. "siapa paling banyak
// pedang naga"), pindah ke tabel `rpg_gear` (bot_id, jid, slot, lv, dur).

/** Level gear terpasang. 0 = belum punya. */
function gearLevel(member, slot) {
  const g = bacaGear(member)[slot];
  return g ? (Number(g.lv) || 0) : 0;
}

/** Durability gear terpasang. */
function gearDur(member, slot) {
  const g = bacaGear(member)[slot];
  return g ? (Number(g.dur) || 0) : 0;
}

/** Gear cuma nambah ATK/DEF kalau ada level DAN durability-nya belum habis. */
function gearAktif(member, slot) {
  return gearLevel(member, slot) > 0 && gearDur(member, slot) > 0;
}

/** Pasang/naikkan gear — mutasi objek `data` (hasil bacaJson). */
function pasangGear(data, slot, lv, dur) {
  const d = Math.min(DUR_MAKS, Math.max(0, Number(dur) || 0));
  data[KEY_GEAR] = { ...(data[KEY_GEAR] || {}), [slot]: { lv: Number(lv) || 0, dur: d } };
}

/** Kurangi durability gear. Return dur baru (0 kalau udah habis/nggak ada gear). */
function kurangiDur(data, slot, kurang) {
  const g = (data[KEY_GEAR] || {})[slot];
  if (!g) return 0;
  const dur = Math.max(0, (Number(g.dur) || 0) - kurang);
  pasangGear(data, slot, g.lv, dur);
  return dur;
}

/** Teks gear buat profil/inventory. */
function statGear(member, slot) {
  const lv = gearLevel(member, slot);
  if (lv < 1) return 'Belum punya';
  const dur = gearDur(member, slot);
  return dur > 0 ? `Lv.${lv} (dur ${dur}%)` : `Lv.${lv} — 💥 RUSAK`;
}

/** Baris gear yang baru berubah, buat ditempel ke pesan hasil pertarungan. */
function barisDur(data, slot, ikon, label) {
  const g = (data[KEY_GEAR] || {})[slot];
  if (!g) return '';
  return (Number(g.dur) || 0) > 0
    ? `\n${ikon} ${label} Lv.${g.lv} — dur *${g.dur}%*`
    : `\n💥 *${label} Lv.${g.lv} RUSAK!* Perbaiki: \`.repair\``;
}

// ─── Inventory item (disimpan di hewan_json, schema sengaja ga diubah) ───────
// ponytail: 1 kolom JSON, bukan tabel `inventory` baru. Pisah ke tabel kalau
// item udah perlu query lintas-user (mis. leaderboard pemilik item).
const KEY_ITEM = 'item';
const KEY_GEAR = 'gear';

/** Parse hewan_json → objek. Rusak/kosong → {}. */
function bacaJson(member) {
  try {
    const raw = member.hewan_json;
    if (!raw) return {};
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return (obj && typeof obj === 'object' && !Array.isArray(obj))
      ? JSON.parse(JSON.stringify(obj))
      : {};
  } catch { return {}; }
}

/** Map item (id → jumlah) dari hewan_json. */
function bacaItem(member) {
  const inv = bacaJson(member)[KEY_ITEM];
  return (inv && typeof inv === 'object' && !Array.isArray(inv)) ? inv : {};
}

/** Map gear terpasang (weapon/armor → {lv, dur}) dari hewan_json. */
function bacaGear(member) {
  const g = bacaJson(member)[KEY_GEAR];
  return (g && typeof g === 'object' && !Array.isArray(g)) ? g : {};
}

/** Level gear yang beneran dipakai di pertarungan: ada lv DAN durability > 0. */
function gearDipakai(member, slot) {
  return gearAktif(member, slot) ? gearLevel(member, slot) : 0;
}

// ─── XP threshold per level ───────────────────────────────────────────────────
function xpForLevel(level) {
  return level <= 0 ? 1 : level * 100;
}

// ─── Role berdasarkan level ───────────────────────────────────────────────────
function getRankByLevel(level) {
  if (level >= 50) return 'Legenda';
  if (level >= 40) return 'Master';
  if (level >= 30) return 'Expert';
  if (level >= 20) return 'Veteran';
  if (level >= 10) return 'Warrior';
  if (level >= 5)  return 'Fighter';
  if (level >= 1)  return 'Adventurer';
  return 'Newbie';
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

/**
 * Konversi timestamp (ms) ke string DATETIME MySQL yang valid.
 * Kolom last_* di DB bertipe DATETIME — mysql2 akan nolak/rusak angka ms mentah.
 */
function toDbTime(ms) {
  if (ms === undefined || ms === null || ms === 0) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Baca nilai last_* dari MySQL (bisa string DATETIME, Date, atau ms number legacy)
 * → return epoch ms. Kalau nggak bisa di-parse → 0.
 */
function toEpochMs(raw) {
  if (!raw) return 0;
  if (typeof raw === 'number') return raw > 1e12 ? raw : raw * 1000; // ms atau detik
  if (raw instanceof Date) return raw.getTime();
  const t = Date.parse(String(raw).replace(' ', 'T'));
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Sisa cooldown dalam ms. lastRaw bisa string DATETIME / Date / ms.
 * Return <= 0 kalau udah boleh claim.
 */
function cdRemain(lastRaw, cooldownMs) {
  const last = toEpochMs(lastRaw);
  if (!last) return 0;
  return cooldownMs - (Date.now() - last);
}

/** Ambil atau buat row RPG member di DB */
async function getOrCreateMember(botId, jid, name) {
  if (!isJlidUser(jid)) return undefined;   // grup/newsletter/LID: nggak punya baris RPG
  const serial = crypto.createHash('md5').update(`${botId}:${jid}`).digest('hex');
  await pool.execute(
    `INSERT INTO rpg_members (bot_id, jid, name, serial)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE name = IF(name IS NULL, VALUES(name), name)`,
    [botId, jid, name || null, serial]
  );
  return findMember(botId, jid);
}

/** Ambil row RPG member — TANPA auto-create. Return undefined kalau belum ada. */
async function findMember(botId, jid) {
  const [rows] = await pool.execute(
    'SELECT * FROM rpg_members WHERE bot_id = ? AND jid = ? LIMIT 1',
    [botId, jid]
  );
  return rows[0];
}

/** Update field RPG member. Value number utk kolom last_* otomatis dikonversi ke DATETIME string. */
async function updateMember(botId, jid, fields) {
  const keys   = Object.keys(fields);
  if (keys.length === 0) return;
  const values = keys.map(k => {
    let v = fields[k];
    // Kolom timestamp: konversi ms → DATETIME string biar MySQL simpen bener
    if (k.startsWith('last_') && typeof v === 'number') v = toDbTime(v);
    return v;
  });
  const set = keys.map(k => `\`${k}\` = ?`).join(', ');
  await pool.execute(
    `UPDATE rpg_members SET ${set} WHERE bot_id = ? AND jid = ?`,
    [...values, botId, jid]
  );
}

function formatNum(n) {
  return Number(n).toLocaleString('id-ID');
}

/**
 * Tambah XP + hitung level-up berantai (satu-satunya jalur nambah XP biar
 * konsisten). Balikin { member, newLevel, leveledUp, levelsGained }.
 */
// Satu-satunya rumus XP→level. Semua command yang nambah XP WAJIB lewat sini,
// supaya level-up berantai konsisten dan tidak ada user stranded (XP > threshold
// tapi level rendah) — bug yang pernah terjadi saat gacha nambah XP mentah.
function calcXpLevel(xp, level, gain) {
  xp    = (Number(xp) || 0) + gain;
  level = Number(level) || 1;
  while (xp >= xpForLevel(level)) {
    xp -= xpForLevel(level);
    level++;
  }
  return { xp, level };
}

async function applyXpGain(botId, jid, amount, extraFields = {}) {
  const m = await getOrCreateMember(botId, jid, null);
  const startLevel = Number(m.level) || 1;
  const { xp, level } = calcXpLevel(m.xp, startLevel, amount);
  await updateMember(botId, jid, { xp, level, ...extraFields });
  return { member: { ...m, xp, level }, newLevel: level, leveledUp: level > startLevel, levelsGained: level - startLevel };
}

// ─── Helper: weighted random ikan ────────────────────────────────────────────
function pickIkan() {
  const total = Object.values(IKAN_WEIGHTS).reduce((a, b) => a + b, 0);
  let rand = Math.random() * total;
  for (const [tier, weight] of Object.entries(IKAN_WEIGHTS)) {
    rand -= weight;
    if (rand <= 0) {
      const pool = IKAN_TABLE.filter(i => i.tier === tier);
      return pool[Math.floor(Math.random() * pool.length)];
    }
  }
  return IKAN_TABLE[0];
}
function renderTTTBoard(board) {
  const nums = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'];
  const cells = board.map((c, i) => c === '⬜' ? nums[i] : c);
  return `${cells[0]}${cells[1]}${cells[2]}\n${cells[3]}${cells[4]}${cells[5]}\n${cells[6]}${cells[7]}${cells[8]}`;
}

function checkTTTWinner(board) {
  const wins = [
    [0,1,2],[3,4,5],[6,7,8], // baris
    [0,3,6],[1,4,7],[2,5,8], // kolom
    [0,4,8],[2,4,6],         // diagonal
  ];
  for (const [a,b,c] of wins) {
    if (board[a] !== '⬜' && board[a] === board[b] && board[b] === board[c]) return board[a];
  }
  return board.includes('⬜') ? null : 'draw';
}

function getMentioned(ctx) {
  return ctx.msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
}

// ─── Helper: resolve mention jid (support LID) ───────────────────────────────
function resolveMentionNum(jid) {
  return jid.split('@')[0];
}

module.exports = async function funRpgHandler(ctx) {
  const { command, args, reply, client, jid, sender, pushName, botData, isGroup, isCmd, body, msg, mentioned } = ctx;
  const p = botData.prefix;

  // ── Dungeon gass listener (non-command) ──────────────────────────────────
  if (!isCmd && isGroup) {
    const bodyLower = (body || '').toLowerCase().trim();
    if (bodyLower === 'gass') {
      const room = [...dungeonRooms.values()].find(r =>
        r.jid === jid && r.p1 === sender && r.state === 'WAITING'
      );
      if (room) {
        const botId  = botData.id;
        const players = [room.p1, room.p2, room.p3, room.p4].filter(Boolean);
        room.state = 'PLAYING';

        // Kirim pesan mulai
        const playerMentions = players.map(p => `@${resolveMentionNum(p)}`).join(', ');
        await client.message.send(jid,
          `⚔️ *DUNGEON DIMULAI!*\n\n🏰 Room: *${room.name}*\nPlayer: ${playerMentions}\n\nSedang berperang di dungeon...`,
          { mentions: players }
        );

        // Hitung battle setelah 5 detik
        setTimeout(async () => {
          try {
            const MONSTER_LIST = [
              { nama: 'Goblin',    hp: 50,  reward: { min: 200,  max: 500  }, xp: 10 },
              { nama: 'Orc',      hp: 80,  reward: { min: 400,  max: 800  }, xp: 18 },
              { nama: 'Troll',    hp: 120, reward: { min: 600,  max: 1200 }, xp: 28 },
              { nama: 'Dragon',   hp: 200, reward: { min: 1000, max: 2500 }, xp: 50 },
              { nama: 'Demon',    hp: 150, reward: { min: 800,  max: 2000 }, xp: 40 },
              { nama: 'Skeleton', hp: 60,  reward: { min: 250,  max: 600  }, xp: 12 },
            ];
            const monster  = MONSTER_LIST[Math.floor(Math.random() * MONSTER_LIST.length)];
            const menang   = Math.random() >= 0.35; // 65% chance menang
            const rewardKoin = menang
              ? Math.floor(Math.random() * (monster.reward.max - monster.reward.min + 1)) + monster.reward.min
              : 0;
            const rewardXp = menang ? monster.xp : Math.floor(monster.xp * 0.3);

            // Update semua player
            for (const pJid of players) {
              try {
                const pm = await getOrCreateMember(botId, pJid, resolveMentionNum(pJid));
                const { xp: newXp, level: newLevel } = calcXpLevel(pm.xp, pm.level || 1, rewardXp);
                await updateMember(botId, pJid, {
                  money:        (Number(pm.money) || 0) + rewardKoin,
                  xp:           newXp,
                  level:        newLevel,
                  last_dungeon: new Date().toISOString().slice(0, 19).replace('T', ' '),
                });
              } catch {}
            }

            dungeonRooms.delete(room.id);

            const resultTxt = menang
              ? `🏆 *MENANG!* Berhasil mengalahkan *${monster.nama}*!\n\n💰 Reward : *+${formatNum(rewardKoin)} koin* per player\n✨ XP     : *+${rewardXp} XP* per player`
              : `💀 *KALAH!* *${monster.nama}* terlalu kuat!\n\n✨ XP     : *+${rewardXp} XP* (hiburan) per player`;

            await client.message.send(jid,
              `⚔️ *HASIL DUNGEON — ${room.name}*\n\n👹 Monster: *${monster.nama}* (HP: ${monster.hp})\n\n${resultTxt}\n\nPlayer: ${playerMentions}`,
              { mentions: players }
            );
          } catch {}
        }, 5000);
        return true;
      }
    }
  }

  // ── Tictactoe move listener (non-command) ────────────────────────────────
  if (!isCmd && isGroup) {
    const moveNum = parseInt((body || '').trim(), 10);
    if (moveNum >= 1 && moveNum <= 9) {
      const room = [...tictactoeGames.values()].find(r =>
        r.jid === jid && (r.p1 === sender || r.p2 === sender) && r.status === 'playing'
      );
      if (room) {
        if (room.turn !== sender) {
          // Bukan gilirannya — abaikan diam-diam
        } else {
          const idx = moveNum - 1;
          if (room.board[idx] !== '⬜') {
            await reply('❌ Kotak itu sudah diisi! Pilih kotak lain.');
          } else {
            const symbol = room.p1 === sender ? '❌' : '⭕';
            room.board[idx] = symbol;

            const winner = checkTTTWinner(room.board);
            if (winner) {
              tictactoeGames.delete(room.roomId);
              const m1 = resolveMentionNum(room.p1);
              const m2 = resolveMentionNum(room.p2);
              if (winner === 'draw') {
                await client.message.send(jid,
                  `❌⭕ *TICTACTOE — HASIL*\n\n${renderTTTBoard(room.board)}\n\n🤝 *SERI!* Permainan berakhir imbang!`,
                  { mentions: [room.p1, room.p2] }
                );
              } else {
                const winnerJid  = winner === '❌' ? room.p1 : room.p2;
                const winnerMention = resolveMentionNum(winnerJid);
                await client.message.send(jid,
                  `❌⭕ *TICTACTOE — HASIL*\n\n${renderTTTBoard(room.board)}\n\n🏆 *@${winnerMention} MENANG!* Selamat!`,
                  { mentions: [room.p1, room.p2] }
                );
              }
            } else {
              const nextTurn   = room.turn === room.p1 ? room.p2 : room.p1;
              room.turn        = nextTurn;
              const nextSymbol = room.p1 === nextTurn ? '❌' : '⭕';
              const nextMention = resolveMentionNum(nextTurn);
              await client.message.send(jid,
                `❌⭕ *TICTACTOE*\n\n${renderTTTBoard(room.board)}\n\nGiliran: @${nextMention} (${nextSymbol})`,
                { mentions: [nextTurn] }
              );
            }
          }
        }
        return true;
      }
    }
  }

  // ── Suit jawaban listener (non-command) ──────────────────────────────────
  if (!isCmd && isGroup) {
    const bodyLower = (body || '').toLowerCase().trim();
    if (['batu', 'gunting', 'kertas'].includes(bodyLower)) {
      const EMOJI_MAP = { batu: '✊', gunting: '✌️', kertas: '✋' };
      const SUIT_WIN_MAP2 = { batu: 'gunting', gunting: 'kertas', kertas: 'batu' };

      // Cari room yang relevan di grup ini
      const room = [...suitGames.values()].find(r =>
        r.jid === jid && (r.p === sender || r.p2 === sender) && r.status === 'waiting'
      );
      if (room) {
        const isP1 = room.p === sender;
        if (isP1 && !room.pilih) {
          room.pilih = bodyLower;
          await reply(`✅ Pilihanmu *${bodyLower}* ${EMOJI_MAP[bodyLower]} sudah dicatat! Menunggu lawan...`);
        } else if (!isP1 && !room.pilih2) {
          room.pilih2 = bodyLower;
          await reply(`✅ Pilihanmu *${bodyLower}* ${EMOJI_MAP[bodyLower]} sudah dicatat! Menunggu lawan...`);
        }

        // Kalau keduanya sudah pilih, tentukan pemenang
        if (room.pilih && room.pilih2) {
          clearTimeout(room.timeoutId);
          suitGames.delete(room.roomId);

          const m1 = resolveMentionNum(room.p);
          const m2 = resolveMentionNum(room.p2);
          let resultTxt = `✊✌️✋ *HASIL SUIT*\n\n`;
          resultTxt += `@${m1} ${EMOJI_MAP[room.pilih]} ${room.pilih}\n`;
          resultTxt += `@${m2} ${EMOJI_MAP[room.pilih2]} ${room.pilih2}\n\n`;

          if (room.pilih === room.pilih2) {
            resultTxt += `🤝 *SERI!* Tidak ada yang menang.`;
          } else if (SUIT_WIN_MAP2[room.pilih] === room.pilih2) {
            resultTxt += `🏆 @${m1} *MENANG!*`;
          } else {
            resultTxt += `🏆 @${m2} *MENANG!*`;
          }

          await client.message.send(jid, resultTxt,
            { mentions: [room.p, room.p2] }
          );
        }
        return true;
      }
    }
  }

  // ── Koboy jawaban listener (non-command) ────────────────────────────────
  if (!isCmd) {
    const bodyLower = (body || '').toLowerCase().trim();
    if (['kiri', 'kanan'].includes(bodyLower)) {
      const session = koboyStore.get(sender);
      if (session && Date.now() < session.expires) {
        koboyStore.delete(sender);
        const { penjahat, botId } = session;
        const now = Date.now();

        if (bodyLower === penjahat.sisi) {
          // Tembakan tepat sasaran — menang
          const member   = await getOrCreateMember(botId, sender, pushName);
          const newMoney = (Number(member.money) || 0) + penjahat.reward;
          await updateMember(botId, sender, { money: newMoney, last_koboy: now });
          await reply(
            `🤠 *KOBOY — TEMBAKAN TEPAT!*\n\n` +
            `🎯 Kamu menembak ke *${bodyLower}* — BENAR!\n` +
            `${penjahat.emoji} *${penjahat.nama}* berhasil ditangkap!\n\n` +
            `💰 Reward: *+${formatNum(penjahat.reward)} koin*\n` +
            `Total koin: *${formatNum(newMoney)}*\n\n` +
            `_Koboy kembali patroli dalam 3 jam_`
          );
        } else {
          // Tembakan meleset — tidak dapat reward, cooldown tetap jalan
          const member = await getOrCreateMember(botId, sender, pushName);
          await updateMember(botId, sender, { last_koboy: now });
          await reply(
            `🤠 *KOBOY — MELESET!*\n\n` +
            `💨 Kamu menembak ke *${bodyLower}* — SALAH!\n` +
            `${penjahat.emoji} *${penjahat.nama}* berhasil kabur!\n\n` +
            `_Tidak ada reward. Koboy kembali patroli dalam 3 jam_`
          );
        }
        return true;
      }
    }

    // ── Airdrop jawaban listener ─────────────────────────────────────────
    const angkaInput = parseInt((body || '').trim(), 10);
    if (!isNaN(angkaInput) && angkaInput >= 1 && angkaInput <= 10) {
      const session = airdropStore.get(sender);
      if (session && Date.now() < session.expires) {
        airdropStore.delete(sender);
        const { angka, botId } = session;
        const now    = Date.now();
        const member = await getOrCreateMember(botId, sender, pushName);

        if (angkaInput === angka) {
          // Tepat — reward besar
          const koinGet  = Math.floor(Math.random() * 1001) + 500; // 500–1500
          const newMoney = (Number(member.money) || 0) + koinGet;
          await updateMember(botId, sender, { money: newMoney, last_airdrop: now });
          await reply(
            `📦 *AIRDROP — TEPAT!*\n\n` +
            `🎯 Angka rahasia: *${angka}* — kamu benar!\n\n` +
            `💰 Reward: *+${formatNum(koinGet)} koin*\n` +
            `Total koin: *${formatNum(newMoney)}*\n\n` +
            `_Airdrop berikutnya dalam 2 jam_`
          );
        } else {
          // Salah — reward kecil hiburan
          const koinGet  = Math.floor(Math.random() * 51) + 10; // 10–60
          const newMoney = (Number(member.money) || 0) + koinGet;
          const selisih  = Math.abs(angkaInput - angka);
          const hint     = selisih <= 2 ? '🔥 Hampir!' : selisih <= 4 ? '😅 Lumayan dekat' : '❄️ Jauh sekali';
          await updateMember(botId, sender, { money: newMoney, last_airdrop: now });
          await reply(
            `📦 *AIRDROP — SALAH!*\n\n` +
            `Kamu tebak *${angkaInput}*, angka rahasia: *${angka}*\n` +
            `${hint}\n\n` +
            `💰 Hiburan: *+${formatNum(koinGet)} koin*\n` +
            `Total koin: *${formatNum(newMoney)}*\n\n` +
            `_Airdrop berikutnya dalam 2 jam_`
          );
        }
        return true;
      }
    }
  }

  if (!isCmd) return false;

  switch (command) {

    // ── jodoh ──────────────────────────────────────────────────────────────
    case 'jodoh': {
      if (!isGroup) { await reply('Command ini hanya untuk grup'); return true; }
      try {
        const meta    = await client.group.queryGroupMetadata(jid);
        const others  = meta.participants.filter(m => {
          const num = m.phoneNumber || m.jid || '';
          return !num.includes(sender.split('@')[0]);
        });
        if (others.length === 0) { await reply('Tidak ada member lain di grup'); return true; }
        const partnerP  = others[Math.floor(Math.random() * others.length)];
        const partnerJid = partnerP.phoneNumber || partnerP.jid;
        const compat    = Math.floor(Math.random() * 51) + 50;
        const emoji     = compat >= 90 ? '🔥 Pasangan sempurna!' : compat >= 70 ? '😊 Cocok banget!' : '🙈 Lumayan cocok~';
        await client.message.send(jid,
          `💕 *Jodoh Hari Ini*\n\n@${resolveMentionNum(sender)} ❤️ @${resolveMentionNum(partnerJid)}\n\nKompatibilitas: *${compat}%*\n\n${emoji}`,
          { mentions: [sender, partnerJid] }
        );
      } catch (e) { await reply(`Gagal mencari jodoh: ${rapikanError(e)}`); }
      return true;
    }

    // ── tembak ────────────────────────────────────────────────────────────
    case 'tembak': {
      const mentioned = getMentioned(ctx);
      if (!mentioned[0]) { await reply(`Penggunaan: ${p}tembak @target`); return true; }
      const target = mentioned[0];
      tembakStore.set(sender, target);
      await client.message.send(jid,
        `🎯 *${pushName}* menembak hati @${resolveMentionNum(target)}!\n\nApa kamu mau menerima? Ketik ${p}terima atau ${p}tolak`,
        { mentions: [target] }
      );
      return true;
    }

    // ── terima ────────────────────────────────────────────────────────────
    case 'terima': {
      const shooter = [...tembakStore.entries()].find(([, t]) => t === sender)?.[0];
      if (!shooter) { await reply('Tidak ada yang menembak kamu'); return true; }
      tembakStore.delete(shooter);
      await client.message.send(jid,
        `💘 *${pushName}* menerima tembakan dari @${resolveMentionNum(shooter)}!\n\nSelamat, kalian resmi jadian! 🎉`,
        { mentions: [shooter, sender] }
      );
      return true;
    }

    // ── tolak ─────────────────────────────────────────────────────────────
    case 'tolak': {
      const shooter = [...tembakStore.entries()].find(([, t]) => t === sender)?.[0];
      if (!shooter) { await reply('Tidak ada yang menembak kamu'); return true; }
      tembakStore.delete(shooter);
      await client.message.send(jid,
        `💔 *${pushName}* menolak tembakan dari @${resolveMentionNum(shooter)}.\n\nMaaf ya... 😢`,
        { mentions: [shooter, sender] }
      );
      return true;
    }

    // ── confess ───────────────────────────────────────────────────────────
    case 'confess': {
      const mentioned = getMentioned(ctx);
      const msg       = args.filter(a => !a.startsWith('@')).join(' ');
      if (!mentioned[0] || !msg) { await reply(`Penggunaan: ${p}confess @target <pesan>`); return true; }
      const target = mentioned[0];
      await client.message.send(jid,
        `💌 *Confess Anonim*\n\nUntuk @${resolveMentionNum(target)}:\n\n"${msg}"`,
        { mentions: [target] }
      );
      return true;
    }

    // ── kapan ─────────────────────────────────────────────────────────────
    case 'kapan': {
      const things  = ['nikah', 'wisuda', 'dapat kerja', 'beli rumah', 'dapat jodoh', 'sukses'];
      const answers = ['Minggu depan InsyaAllah', 'Bulan depan', 'Tahun ini', '3 tahun lagi', 'Segera', 'Rahasia Allah'];
      const thing   = args.join(' ') || things[Math.floor(Math.random() * things.length)];
      const ans     = answers[Math.floor(Math.random() * answers.length)];
      await reply(`🔮 *Kapan ${thing}?*\n\nJawaban: *${ans}*`);
      return true;
    }

    // ─────────────────────────────────────────────────────────────────────
    // GIVEAWAY
    // ─────────────────────────────────────────────────────────────────────

    case 'mulaigiveaway': {
      if (!isGroup) { await reply('Hanya untuk grup'); return true; }
      if (giveawayStore.has(jid)) { await reply('Sudah ada giveaway aktif'); return true; }
      const [prize, ...titleParts] = args;
      const title = titleParts.join(' ') || 'Hadiah Spesial';
      if (!prize) { await reply(`Penggunaan: ${p}mulaigiveaway <hadiah> <judul>`); return true; }
      giveawayStore.set(jid, { title, prize, host: sender, participants: new Set() });
      await client.message.send(jid,
        `🎁 *GIVEAWAY DIMULAI!*\n\nJudul  : ${title}\nHadiah : ${prize}\nHost   : @${resolveMentionNum(sender)}\n\nKetik ${p}ikut untuk ikutan!`,
        { mentions: [sender] }
      );
      return true;
    }

    case 'ikut': {
      if (!giveawayStore.has(jid)) { await reply(`Belum ada giveaway aktif. Tunggu admin ketik ${p}mulaigiveaway`); return true; }
      const gw = giveawayStore.get(jid);
      if (gw.participants.has(sender)) { await reply('Kamu sudah terdaftar!'); return true; }
      gw.participants.add(sender);
      await reply(`✅ *${pushName}* berhasil ikut giveaway!\nTotal peserta: ${gw.participants.size}`);
      return true;
    }

    case 'rollgiveaway': {
      const gw = giveawayStore.get(jid);
      if (!gw) { await reply('Tidak ada giveaway aktif'); return true; }
      const participants = [...gw.participants];
      if (participants.length === 0) { await reply('Tidak ada peserta giveaway'); return true; }
      const winner = participants[Math.floor(Math.random() * participants.length)];
      gw.winner = winner;
      await client.message.send(jid,
        `🎊 *PEMENANG GIVEAWAY*\n\nJudul  : ${gw.title}\nHadiah : ${gw.prize}\n\n🏆 Pemenang: @${resolveMentionNum(winner)}\n\nSelamat! Hubungi host untuk klaim hadiah.`,
        { mentions: [winner, gw.host] }
      );
      return true;
    }

    case 'cekgiveaway': {
      const gw = giveawayStore.get(jid);
      if (!gw) { await reply('Tidak ada giveaway aktif'); return true; }
      await reply(
        `🎁 *Info Giveaway*\n\nJudul    : ${gw.title}\nHadiah   : ${gw.prize}\nPeserta  : ${gw.participants.size}\nPemenang : ${gw.winner ? `@${resolveMentionNum(gw.winner)}` : 'Belum diroll'}`
      );
      return true;
    }

    case 'cekmenang': {
      const gw = giveawayStore.get(jid);
      if (!gw || !gw.winner) { await reply('Belum ada pemenang'); return true; }
      await client.message.send(jid,
        `🏆 Pemenang giveaway *${gw.title}* adalah @${resolveMentionNum(gw.winner)}`,
        { mentions: [gw.winner] }
      );
      return true;
    }

    case 'hapusgiveaway': {
      if (!giveawayStore.has(jid)) { await reply('Tidak ada giveaway aktif'); return true; }
      giveawayStore.delete(jid);
      await reply('🗑️ Giveaway dihapus');
      return true;
    }

    // ─────────────────────────────────────────────────────────────────────
    // PROFIL
    // ─────────────────────────────────────────────────────────────────────

    case 'profil':
    case 'profile':
    case 'me': {
      try {
        // Target: reply pesan → sender pesan itu; mention → yang di-tag; default → diri sendiri
        let target = sender;
        const quotedP = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const quotedSenderP = msg.message?.extendedTextMessage?.contextInfo?.participant;
        if (quotedSenderP) target = quotedSenderP;
        else if (mentioned?.[0]) target = mentioned[0];

        const isSelf = target === sender;
        // Kalau yang di-reply/di-tag adalah bot-nya sendiri → bukan member
        const botPhone = (botData.bot_number || '').replace(/\D/g, '');
        if (!isSelf && target.split('@')[0] === botPhone) {
          await reply('Itu akun bot-nya sendiri 😄 bukan member.\nReply/tag *orang* buat liat profil mereka.');
          return true;
        }
        let m;
        if (isSelf) {
          m = await getOrCreateMember(botData.id, target, pushName);
        } else {
          m = await findMember(botData.id, target);
        }
        // Satu guard buat dua jalur: LID yang belum ke-petakan ke nomor juga
        // balik `undefined` dari getOrCreateMember.
        if (!m) {
          await reply(isSelf
            ? 'Profil lu belum kebaca nih — coba ketik command lain dulu, terus ulang *.me*.'
            : `User @${resolveMentionNum(target)} belum terdaftar.\n_Orangnya belum pernah chat bot — suruh dia ketik command apa aja dulu._`);
          return true;
        }
        // Auto-repair: kalau XP numpuk > threshold (bug lama gacha), langsung
        // level-up & sisakan XP yang bener
        let xp    = Number(m.xp) || 0;
        let level = Number(m.level) || 1;
        let leveledUp = false;
        while (xp >= xpForLevel(level)) {
          xp -= xpForLevel(level);
          level++;
          leveledUp = true;
        }
        if (leveledUp) {
          await updateMember(botData.id, target, { xp, level });
          m.xp = xp; m.level = level;
        }
        const phone   = target.split('@')[0];
        const numFmt  = phone.replace(/^62/, '+62 ').replace(/(\d{3})(\d{4})(\d{4})$/, '$1-$2-$3');
        const xpNeeded = xpForLevel(Number(m.level));
        const rank    = getRankByLevel(Number(m.level));

        // Format tanggal
        const fmtDate = (d) => {
          if (!d) return '-';
          const dt = new Date(d);
          return `${dt.getDate().toString().padStart(2,'0')}/${(dt.getMonth()+1).toString().padStart(2,'0')}/${dt.getFullYear()}`;
        };

        const txt =
          `┌─⊷ PROFILE${isSelf ? '' : ` — @${resolveMentionNum(target)}`}\n` +
          `┃👤 • Name: ${m.name || (isSelf ? pushName : resolveMentionNum(target))}\n` +
          `┃📞 • Number: ${numFmt}\n` +
          `┃🔗 • Link: https://wa.me/${phone}\n` +
          `└──────────────\n\n` +
          `┌─⊷ RPG INFO\n` +
          `┃📊 • Level: ${m.level}\n` +
          `┃🔰 • Rank: ${rank}\n` +
          `┃✨ • XP: ${formatNum(m.xp)} / ${formatNum(xpNeeded)}\n` +
          `┃💰 • Money: ${formatNum(m.money)}\n` +
          `┃💎 • Limit: ${m.lim}\n` +
          `└──────────────\n\n` +
          `┌─⊷ STAT & GEAR\n` +
          `┃❤️ • Health: ${Number(m.healt) || 0}/100\n` +
          `┃⚡ • Energi: ${barEnergi(energiSekarang(m))}\n` +
          `┃🗡️ • Sword: ${statGear(m, 'weapon')}\n` +
          `┃🛡️ • Armor: ${statGear(m, 'armor')}\n` +
          `┃🏦 • Bank: ${formatNum(m.bank_money || 0)}\n` +
          `┃💼 • Kerja: ${m.job ? `${m.job} (${Number(m.jobexp) || 0}%)` : 'Belum melamar'}\n` +
          `└──────────────\n\n` +
          `┌─⊷ STATUS\n` +
          `┃📌 • Registered: ${m.registered ? 'Yes' : 'No'}\n` +
          `┃⭐ • Premium: ${m.premium ? 'Yes' : 'No'}\n` +
          `┃⏳ • Premium Expired: ${fmtDate(m.premium_expired)}\n` +
          `┃🕐 • Last Claim: ${fmtDate(m.last_claim)}\n` +
          `└──────────────`;

        if (isSelf) {
          await reply(txt);
        } else {
          await client.message.send(jid, txt, { mentions: [target] });
        }
      } catch (e) {
        await reply(`Gagal load profil: ${rapikanError(e)}`);
      }
      return true;
    }

    // ─────────────────────────────────────────────────────────────────────
    // RPG
    // ─────────────────────────────────────────────────────────────────────

    case 'rpg': {
      try {
        const m    = await getOrCreateMember(botData.id, sender, pushName);
        const rank = getRankByLevel(Number(m.level));
        await reply(
          `⚔️ *Profil RPG*\n\n` +
          `Nama   : ${pushName}\n` +
          `Level  : ${m.level} (${rank})\n` +
          `XP     : ${formatNum(m.xp)}/${formatNum(xpForLevel(Number(m.level)))}\n` +
          `Koin   : ${formatNum(m.money)} 🪙\n` +
          `Limit  : ${m.lim}\n` +
          `─── STAT ───\n` +
          `❤️ Health : ${Number(m.healt) || 0}/100\n` +
          `⚡ Energi : ${barEnergi(energiSekarang(m))}\n` +
          `🗡️ Sword  : ${statGear(m, 'weapon')}\n` +
          `🛡️ Armor  : ${statGear(m, 'armor')}\n` +
          `🏦 Bank   : ${formatNum(m.bank_money || 0)}\n` +
          `💼 Kerja  : ${m.job ? `${m.job} (${Number(m.jobexp) || 0}%)` : 'Belum melamar'}`
        );
      } catch (e) { await reply(`Gagal: ${rapikanError(e)}`); }
      return true;
    }

    case 'claim':
    case 'daily': {
      try {
        const m   = await getOrCreateMember(botData.id, sender, pushName);
        const now = new Date();
        if (m.last_claim) {
          const diff = now - new Date(m.last_claim);
          if (diff < DAILY_COOLDOWN) {
            const remaining = Math.ceil((DAILY_COOLDOWN - diff) / 3600000);
            await reply(`⏳ Kamu sudah klaim hari ini. Coba lagi dalam *${remaining} jam*`);
            return true;
          }
        }
        // Premium tier: reward 2x + bonus lebih besar + limit +50
        const isPrem   = ctx.isPremium || false;
        const base     = isPrem ? DAILY_REWARD * 2 : DAILY_REWARD;
        const bonus    = isPrem
          ? Math.floor(Math.random() * 500) + 200
          : Math.floor(Math.random() * 200);
        const total    = base + bonus;
        const newMoney = Number(m.money) + total;
        const newLim   = isPrem ? Number(m.lim) + 50 : Number(m.lim);
        await updateMember(botData.id, sender, { money: newMoney, lim: newLim, last_claim: now });
        const premTag  = isPrem ? '\n⭐ *Bonus Premium aktif!*' : '';
        await reply(
          `🎁 *Daily Claim*${premTag}\n\n` +
          `+${base} koin base\n` +
          `+${bonus} koin bonus\n` +
          (isPrem ? `+50 limit\n` : '') +
          `\nTotal koin: ${formatNum(newMoney)} 🪙\nLimit: ${newLim}`
        );
      } catch (e) { await reply(`Gagal: ${rapikanError(e)}`); }
      return true;
    }

    case 'store': {
      const list = STORE_ITEMS.map(item =>
        `${item.id}. *${item.name}* — ${formatNum(item.price)} 🪙\n   ${item.effect}${item.lv ? ` _(gear Lv.${item.lv})_` : ''}`
      ).join('\n');
      await reply(
        `🏪 *Toko RPG*\n\n${list}\n\n` +
        `Beli  : ${p}beli <nomor>\n` +
        `Pakai : ${p}pakai <nomor>  _(potion)_\n` +
        `Gear rusak diperbaiki dengan ${p}repair`
      );
      return true;
    }

    case 'beli': {
      try {
        const id = parseInt((args[0] || '').trim(), 10);
        const item = STORE_ITEMS.find(i => i.id === id);
        if (!item) { await reply(`❌ Item nomor *${args[0] || '-'}* tidak ada di toko.\n\nLiat daftar: ${p}store`); return true; }

        const member = await getOrCreateMember(botData.id, sender, pushName);
        if ((Number(member.money) || 0) < item.price) {
          await reply(`❌ Koin tidak cukup!\n\nHarga: *${formatNum(item.price)}*\nKoinmu: *${formatNum(member.money || 0)}*`);
          return true;
        }

        const data = bacaJson(member);
        const inv  = bacaItem(member);
        inv[String(item.id)] = (Number(inv[String(item.id)]) || 0) + 1;

        const fields = { money: (Number(member.money) || 0) - item.price };
        let info = '';

        // Gear: langsung dipakai kalau lebih bagus ATAU gear lama udah rusak.
        // ponytail: gear lama tetap dihitung walau dur 0 — kalau nggak, beli
        // Lv.1 pas rusak bikin "turun pangkat" dari Lv.3.
        if (item.type === 'weapon' || item.type === 'armor') {
          const slot   = item.type;
          const lvLama = gearLevel(member, slot);
          const rusak  = lvLama >= 1 && !gearAktif(member, slot);
          if (item.lv > lvLama || rusak) {
            pasangGear(data, slot, item.lv, DUR_MAKS);
            info = `\n\n🗡️ *${item.name} langsung dipakai* (Lv.${item.lv}, dur ${DUR_MAKS}%).`;
          } else {
            info = `\n\n📦 Disimpan di inventory — gear Lv.${item.lv} nggak lebih bagus dari Lv.${lvLama} yang kamu pakai.`;
          }
        } else if (item.type === 'potion') {
          info = `\n\n🧪 Pakai dengan: ${p}pakai ${item.id}`;
        }

        data[KEY_ITEM] = inv;
        fields.hewan_json = JSON.stringify(data);
        await updateMember(botData.id, sender, fields);

        await reply(
          `✅ *${item.name}* dibeli!\n\n` +
          `💸 Bayar : *${formatNum(item.price)}* 🪙\n` +
          `💰 Koin  : *${formatNum(fields.money)}*` + info
        );
      } catch (e) { await reply(`Gagal beli: ${rapikanError(e)}`); }
      return true;
    }

    case 'inventory': {
      try {
        const m    = await getOrCreateMember(botData.id, sender, pushName);
        const inv  = bacaItem(m);
        const rows = Object.entries(inv)
          .map(([id, n]) => {
            const item = STORE_ITEMS.find(i => String(i.id) === String(id));
            return { nama: item ? item.name : `Item #${id}`, n: Number(n) || 0, id };
          })
          .filter(r => r.n > 0)
          .sort((a, b) => a.nama.localeCompare(b.nama));

        const daftar = rows.length
          ? rows.map(r => `• *${r.nama}* ×${r.n}`).join('\n')
          : '_Kosong. Belanja dulu di ' + p + 'store_';

        await reply(
          `🎒 *Inventory*\n\n${daftar}\n\n` +
          `🗡️ Sword : ${statGear(m, 'weapon')}\n` +
          `🛡️ Armor : ${statGear(m, 'armor')}\n` +
          `⚡ Energi : ${barEnergi(energiSekarang(m))}`
        );
      } catch (e) { await reply(`Gagal: ${rapikanError(e)}`); }
      return true;
    }

    case 'pakai': {
      try {
        const id = parseInt((args[0] || '').trim(), 10);
        const item = STORE_ITEMS.find(i => i.id === id);
        if (!item || item.type === 'magic' || item.type === 'special') {
          await reply(`❓ ${item ? `*${item.name}* belum bisa dipakai` : `Item nomor *${args[0] || '-'}* nggak ada`}.\n\nLiat daftar: ${p}store`);
          return true;
        }

        const m   = await getOrCreateMember(botData.id, sender, pushName);
        const inv = bacaItem(m);
        const punya = Number(inv[String(item.id)]) || 0;
        if (punya < 1) { await reply(`❌ Kamu nggak punya *${item.name}*.\n\nBeli dulu: ${p}beli ${item.id}`); return true; }

        const data = bacaJson(m);
        const fields = {};
        let txt;

        if (item.type === 'weapon' || item.type === 'armor') {
          const slot   = item.type;
          const lvLama = gearLevel(m, slot);
          if (item.lv <= lvLama) {
            await reply(`❌ ${slot === 'weapon' ? 'Pedang' : 'Armor'} kamu udah *Lv.${lvLama}* — lebih bagus dari *${item.name}* (Lv.${item.lv}).`);
            return true;
          }
          pasangGear(data, slot, item.lv, DUR_MAKS);
          txt = `🗡️ *${item.name}* dipasang — Lv.${item.lv}, dur *${DUR_MAKS}%*`;
        } else {
          const hpBaru = Math.min(100, (Number(m.healt) || 0) + 50);
          fields.healt = hpBaru;
          txt = `🧪 *${item.name}* diminum!\n❤️ Health: *${hpBaru}/100*`;
        }

        inv[String(item.id)] = punya - 1;
        if (inv[String(item.id)] < 1) delete inv[String(item.id)];
        data[KEY_ITEM] = inv;
        fields.hewan_json = JSON.stringify(data);
        await updateMember(botData.id, sender, fields);

        await reply(`${txt}\n🎒 Sisa : *${punya - 1}*`);
      } catch (e) { await reply(`Gagal: ${rapikanError(e)}`); }
      return true;
    }

    case 'repair': {
      try {
        const m = await getOrCreateMember(botData.id, sender, pushName);
        const data = bacaJson(m);

        const perlu = ['weapon', 'armor'].filter(slot => {
          const lv = gearLevel(m, slot);
          return lv > 0 && gearDur(m, slot) < DUR_MAKS;
        });

        if (!perlu.length) {
          const punya = ['weapon', 'armor'].filter(slot => gearLevel(m, slot) > 0);
          await reply(punya.length
            ? `✅ Gear kamu masih utuh semua — nggak ada yang perlu diperbaiki.`
            : `❌ Kamu belum punya gear.\n\nBeli dulu di ${p}store`);
          return true;
        }

        const rincian = perlu.map(slot => {
          const lv  = gearLevel(m, slot);
          const dur = gearDur(m, slot);
          return { slot, lv, dur, biaya: biayaRepair(slot, lv) };
        });
        const total = rincian.reduce((s, r) => s + r.biaya, 0);

        if ((Number(m.money) || 0) < total) {
          const list = rincian.map(r => `• ${r.slot === 'weapon' ? '🗡️ Sword' : '🛡️ Armor'} Lv.${r.lv} (dur ${r.dur}%) — *${formatNum(r.biaya)}* 🪙`).join('\n');
          await reply(
            `❌ Koin kamu nggak cukup buat benerin semua gear.\n\n${list}\n\n` +
            `Total butuh: *${formatNum(total)}* 🪙\nKoinmu: *${formatNum(m.money || 0)}*`
          );
          return true;
        }

        const list = rincian.map(r => {
          const nama = r.slot === 'weapon' ? '🗡️ Sword' : '🛡️ Armor';
          pasangGear(data, r.slot, r.lv, DUR_MAKS);
          return `• ${nama} Lv.${r.lv} → dur *${DUR_MAKS}%* (_-${formatNum(r.biaya)}_ 🪙)`;
        }).join('\n');

        data[KEY_ITEM] = bacaItem(m);
        await updateMember(botData.id, sender, {
          money: (Number(m.money) || 0) - total,
          hewan_json: JSON.stringify(data),
        });

        await reply(
          `🔧 *Gear diperbaiki!*\n\n${list}\n\n` +
          `💸 Total : *${formatNum(total)}* 🪙\n` +
          `💰 Koin  : *${formatNum((Number(m.money) || 0) - total)}*`
        );
      } catch (e) { await reply(`Gagal repair: ${rapikanError(e)}`); }
      return true;
    }

    case 'topkoin': {
      // Khusus premium
      if (!ctx.isPremium) {
        await reply(`⭐ Command ini khusus untuk member *Premium*!\n\nHubungi owner untuk upgrade premium.`);
        return true;
      }
      try {
        const [rows] = await pool.execute(
          'SELECT jid, name, money FROM rpg_members WHERE bot_id = ? ORDER BY money DESC LIMIT 10',
          [botData.id]
        );
        if (rows.length === 0) { await reply('Belum ada data RPG'); return true; }
        const list     = rows.map((r, i) => `${i + 1}. @${resolveMentionNum(r.jid)} — ${formatNum(r.money)} 🪙`).join('\n');
        const mentions = rows.map(r => r.jid);
        await client.message.send(jid, `🏆 *Top Koin*\n\n${list}`, { mentions: mentions });
      } catch (e) { await reply(`Gagal: ${rapikanError(e)}`); }
      return true;
    }

    // ── suitpvp ───────────────────────────────────────────────────────────────
    case 'suitpvp':
    case 'suit': {
      if (!isGroup) { await reply('Command ini hanya untuk grup'); return true; }

      const SUIT_TIMEOUT = 90000;
      const SUIT_WIN_REWARD = 500;
      const EMOJI_MAP = { batu: '✊', gunting: '✌️', kertas: '✋' };

      const mentioned = getMentioned(ctx);
      const target = mentioned[0];

      if (!target) {
        await reply(`✊✌️✋ *SUIT PvP*\n\n> Tag orang yang mau kamu tantang!\n\nContoh: ${p}suitpvp @628xxx`);
        return true;
      }
      if (target === sender) {
        await reply('❌ Tidak bisa menantang diri sendiri!');
        return true;
      }

      // Cek apakah sender sudah dalam game
      const senderInGame = [...suitGames.values()].find(r => r.jid === jid && [r.p, r.p2].includes(sender));
      if (senderInGame) {
        await reply('❌ Kamu masih dalam game suit! Selesaikan dulu.');
        return true;
      }

      // Cek apakah target sudah dalam game
      const targetInGame = [...suitGames.values()].find(r => r.jid === jid && [r.p, r.p2].includes(target));
      if (targetInGame) {
        await reply('❌ Orang itu sedang bermain suit dengan orang lain!');
        return true;
      }

      const roomId = `suit_${jid}_${Date.now()}`;
      const mentionP  = resolveMentionNum(sender);
      const mentionP2 = resolveMentionNum(target);

      const timeoutId = setTimeout(async () => {
        if (suitGames.has(roomId)) {
          suitGames.delete(roomId);
          await client.message.send(jid,
            `⏱️ *TIMEOUT!*\n\n@${mentionP2} tidak merespon dalam 90 detik!\nSuit dibatalkan.`,
            { mentions: [target] }
          );
        }
      }, SUIT_TIMEOUT);

      suitGames.set(roomId, {
        roomId, jid,
        p: sender, p2: target,
        pilih: null, pilih2: null,
        status: 'waiting',
        timeoutId,
      });

      await client.message.send(jid,
        `✊✌️✋ *SUIT PvP*\n\n@${mentionP} menantang @${mentionP2} untuk bermain suit!\n\nBalas dengan: *batu*, *gunting*, atau *kertas*\n⏱️ Waktu: 90 detik`,
        { mentions: [sender, target] }
      );
      return true;
    }

    // ── berburu / hunt ────────────────────────────────────────────────────────
    case 'berburu':
    case 'hunt': {
      const botId  = botData.id;
      const member = await getOrCreateMember(botId, sender, pushName);

      // Cek cooldown 1 jam
      const sisaCd = cdRemain(member.last_berburu, 3600000);
      const now    = Date.now();
      if (sisaCd > 0) {
        const h = Math.floor(sisaCd / 3600000);
        const m = Math.floor((sisaCd % 3600000) / 60000);
        const s = Math.floor((sisaCd % 60000) / 1000);
        await reply(`Sepertinya kamu sudah kecapean!\nIstirahat dulu sekitar *${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}* untuk bisa melanjutkan berburu.`);
        return true;
      }

      const cukupEnergi = await pakaiEnergi(botId, sender, member, 20);
      if (!cukupEnergi.ok) { await reply(pesanEnergiKurang(cukupEnergi.energi, 20)); return true; }

      // 12 hewan, random 0-9 masing-masing
      const HEWAN = ['🐂','🐅','🐘','🐐','🐼','🐊','🐃','🐮','🐒','🐗','🐖','🐓'];
      const NAMA  = ['banteng','harimau','gajah','kambing','panda','buaya','kerbau','sapi','monyet','babi_hutan','babi','ayam'];
      const hasil = HEWAN.map(() => Math.floor(Math.random() * 10));

      // Hitung nilai koin: tiap hewan punya harga berbeda
      const HARGA = [500,800,700,300,600,900,400,350,250,450,200,150];
      const totalKoin = hasil.reduce((acc, jml, i) => acc + jml * HARGA[i], 0);

      // Update hewan_json di DB (merge dengan existing)
      // ponytail: ditulis sebagai kolom terpisah, JANGAN JSON.stringify(map hasil
      // `member.hewan_json` — nilainya bisa string kalau driver balikin JSON mentah,
      // dan JSON.stringify(string) = string ber-quote dobel = data rusak.
      const hewanData = bacaJson(member);
      NAMA.forEach((n, i) => { hewanData[n] = (Number(hewanData[n]) || 0) + hasil[i]; });
      const newMoney = (Number(member.money) || 0) + totalKoin;

      await updateMember(botId, sender, {
        money:        newMoney,
        hewan_json:   JSON.stringify(hewanData),
        last_berburu: new Date().toISOString().slice(0, 19).replace('T', ' '),
      });

      // Kirim animasi 3 pesan dengan setTimeout
      await reply('🏹 Sedang mencari mangsa...');
      setTimeout(async () => {
        try { await client.message.send(jid, 'Mendapatkan sasaran! 🎯'); } catch {}
      }, 3000);
      setTimeout(async () => {
        try {
          const baris1 = `${HEWAN[0]} = [ ${hasil[0]} ]         ${HEWAN[6]} = [ ${hasil[6]} ]`;
          const baris2 = `${HEWAN[1]} = [ ${hasil[1]} ]         ${HEWAN[7]} = [ ${hasil[7]} ]`;
          const baris3 = `${HEWAN[2]} = [ ${hasil[2]} ]         ${HEWAN[8]} = [ ${hasil[8]} ]`;
          const baris4 = `${HEWAN[3]} = [ ${hasil[3]} ]         ${HEWAN[9]} = [ ${hasil[9]} ]`;
          const baris5 = `${HEWAN[4]} = [ ${hasil[4]} ]         ${HEWAN[10]} = [ ${hasil[10]} ]`;
          const baris6 = `${HEWAN[5]} = [ ${hasil[5]} ]         ${HEWAN[11]} = [ ${hasil[11]} ]`;
          await client.message.send(jid,
            `• *Hasil Berburu*\n\n*${baris1}*\n*${baris2}*\n*${baris3}*\n*${baris4}*\n*${baris5}*\n*${baris6}*\n\n💰 Nilai: *+${formatNum(totalKoin)} koin*\nTotal koin: *${formatNum(newMoney)}*\n⚡ Energi sisa: *${cukupEnergi.energi}*`
          );
        } catch {}
      }, 6000);
      return true;
    }

    // ── bertarung / fight ─────────────────────────────────────────────────────
    case 'bertarung':
    case 'fight': {
      if (!isGroup) { await reply('Bertarung hanya bisa dilakukan di grup!'); return true; }
      const botId    = botData.id;
      const mentioned = getMentioned(ctx);
      const opponent = mentioned[0];
      if (!opponent) { await reply(`Penggunaan: ${p}bertarung @user`); return true; }
      if (opponent === sender) { await reply('❌ Tidak bisa bertarung dengan diri sendiri!'); return true; }

      const member = await getOrCreateMember(botId, sender, pushName);
      const oppRow = await getOrCreateMember(botId, opponent, resolveMentionNum(opponent));

      // Cooldown 10 detik
      const cdSisa = cdRemain(member.last_bertarung, 10000);
      if (cdSisa > 0) {
        await reply(`Tunggu *${Math.ceil(cdSisa / 1000)} detik* sebelum bertarung lagi!`);
        return true;
      }

      // Bet random 10.000 – 500.000 koin
      const bet = Math.floor(Math.random() * 490001) + 10000;
      if ((Number(member.money) || 0) < bet) {
        await reply(`❌ Koin tidak cukup untuk bertarung!\nDibutuhkan: *${formatNum(bet)} koin*\nKoinmu: *${formatNum(member.money || 0)} koin*`);
        return true;
      }

      const ALASAN_MENANG = [
        'berhasil menggunakan kekuatan elemental untuk menghancurkan pertahanan lawan',
        'melancarkan serangan mematikan dengan gerakan akrobatik yang membingungkan lawan',
        'bermain cerdas dan memanfaatkan kelengahan lawan',
        'bot merasa kasihan dan memberikan kemenangan',
        'melawan orang yang kurang beruntung hari ini',
      ];
      const ALASAN_KALAH = [
        'lengah di saat kritis dan terkena serangan telak',
        'kurang latihan sehingga kewalahan menghadapi lawan',
        'terlalu percaya diri dan akhirnya keok',
        'kesialan menghampiri di momen genting',
        'kalah strategi dari lawan yang lebih berpengalaman',
      ];

      const senderMention  = resolveMentionNum(sender);
      const opponentMention = resolveMentionNum(opponent);

      await react('⚔️');
      await reply('Mempersiapkan arena...');

      setTimeout(async () => {
        try { await client.message.send(jid, 'Bertarung... ⚔️'); } catch {}
      }, 2000);

      setTimeout(async () => {
        try {
          const menang  = Math.random() >= 0.5;
          const alasan  = menang
            ? ALASAN_MENANG[Math.floor(Math.random() * ALASAN_MENANG.length)]
            : ALASAN_KALAH[Math.floor(Math.random() * ALASAN_KALAH.length)];

          const winnerMoney = (Number(menang ? member.money : oppRow.money) || 0) + bet;
          const loserMoney  = Math.max(0, (Number(menang ? oppRow.money : member.money) || 0) - bet);

          if (menang) {
            await updateMember(botId, sender,   { money: winnerMoney, last_bertarung: new Date().toISOString().slice(0,19).replace('T',' ') });
            await updateMember(botId, opponent, { money: loserMoney });
          } else {
            await updateMember(botId, opponent, { money: winnerMoney });
            await updateMember(botId, sender,   { money: loserMoney, last_bertarung: new Date().toISOString().slice(0,19).replace('T',' ') });
          }

          const winnerJid  = menang ? sender : opponent;
          const winnerName = menang ? pushName : resolveMentionNum(opponent);

          let txt = `⚔️ *HASIL BERTARUNG*\n\n`;
          txt += `@${senderMention} vs @${opponentMention}\n\n`;
          txt += menang
            ? `🏆 *@${senderMention} MENANG!*\n${alasan}\n\n+${formatNum(bet)} koin\nKoin kamu: *${formatNum(winnerMoney)}*`
            : `💀 *@${senderMention} KALAH!*\n${alasan}\n\n-${formatNum(bet)} koin\nKoin kamu: *${formatNum(loserMoney)}*`;

          await client.message.send(jid, txt, { mentions: [sender, opponent] });
        } catch {}
      }, 4000);
      return true;
    }

    // ── lamarkerja ────────────────────────────────────────────────────────────
    case 'lamarkerja': {
      const botId = botData.id;
      const member = await getOrCreateMember(botId, sender, pushName);

      const JOB_LIST = {
        'gojek':               { minLevel: 1,  gaji: { min: 50000,  max: 100000  } },
        'kurir':               { minLevel: 1,  gaji: { min: 60000,  max: 200000  } },
        'sopir':               { minLevel: 1,  gaji: { min: 60000,  max: 200000  } },
        'karyawan indomaret':  { minLevel: 5,  gaji: { min: 100000, max: 300000  } },
        'kantoran':            { minLevel: 10, gaji: { min: 150000, max: 400000  } },
        'dokter':              { minLevel: 20, gaji: { min: 200000, max: 600000  } },
        'frontend developer':  { minLevel: 15, gaji: { min: 180000, max: 600000  } },
        'web developer':       { minLevel: 15, gaji: { min: 180000, max: 600000  } },
        'backend developer':   { minLevel: 15, gaji: { min: 180000, max: 600000  } },
        'fullstack developer': { minLevel: 20, gaji: { min: 250000, max: 700000  } },
        'game developer':      { minLevel: 15, gaji: { min: 180000, max: 600000  } },
        'pemain sepak bola':   { minLevel: 10, gaji: { min: 150000, max: 500000  } },
        'trader':              { minLevel: 10, gaji: { min: 100000, max: 800000  } },
        'hunter':              { minLevel: 5,  gaji: { min: 80000,  max: 300000  } },
        'polisi':              { minLevel: 30, gaji: { min: 300000, max: 500000  } },
      };

      const jobInput = args.join(' ').toLowerCase().trim();
      if (!jobInput || !JOB_LIST[jobInput]) {
        const list = Object.keys(JOB_LIST).map((j, i) =>
          `${i+1}. ${j.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')} (min level ${JOB_LIST[j].minLevel})`
        ).join('\n');
        await reply(`乂 *LIST JOB*\n\n${list}\n\nContoh: ${p}lamarkerja gojek`);
        return true;
      }

      const jobData = JOB_LIST[jobInput];
      if ((member.level || 1) < jobData.minLevel) {
        await reply(`❌ Level kamu belum cukup!\n\nDibutuhkan level *${jobData.minLevel}*, kamu baru level *${member.level || 1}*`);
        return true;
      }

      const kapital = jobInput.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
      await updateMember(botId, sender, { job: jobInput, jobexp: 0 });
      await reply('Sedang memproses lamaran...');
      setTimeout(async () => {
        try {
          await client.message.send(jid,
            `🎉 *Selamat, lamaran kerja kamu diterima!*\n\n` +
            `💼 Pekerjaan: *${kapital}*\n` +
            `⭐ Level min : ${jobData.minLevel}\n` +
            `💰 Gaji     : ${formatNum(jobData.gaji.min)}–${formatNum(jobData.gaji.max)} koin/hari\n\n` +
            `Ketik ${p}job untuk melihat detail pekerjaan.\nKetik ${p}gajian untuk ambil gaji harian.`
          );
        } catch {}
      }, 3000);
      return true;
    }

    // ── job ───────────────────────────────────────────────────────────────────
    case 'job': {
      const botId  = botData.id;
      const member = await getOrCreateMember(botId, sender, pushName);

      if (!member.job || member.job === 'Pengangguran') {
        await reply(`❌ Kamu belum punya pekerjaan!\n\nKetik ${p}lamarkerja untuk melamar pekerjaan.`);
        return true;
      }

      const kapital = member.job.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
      await reply(
        `💼 *JOB INFO*\n\n` +
        `👤 Nama       : *${member.name || pushName}*\n` +
        `💼 Pekerjaan  : *${kapital}*\n` +
        `📊 Job EXP    : *${member.jobexp || 0}%* / 500%\n\n` +
        `Job EXP meningkat setiap kamu mengambil gaji.\nKetik ${p}gajian untuk ambil gaji harian.`
      );
      return true;
    }

    // ── gajian ────────────────────────────────────────────────────────────────
    case 'gajian': {
      const botId  = botData.id;
      const member = await getOrCreateMember(botId, sender, pushName);

      if (!member.job || member.job === 'Pengangguran') {
        await reply(`❌ Kamu belum punya pekerjaan!\n\nKetik ${p}lamarkerja untuk melamar pekerjaan.`);
        return true;
      }

      // Cooldown 24 jam
      const sisaCd = cdRemain(member.last_gajian, 86400000);
      const now    = Date.now();

      if (sisaCd > 0) {
        const h = Math.floor(sisaCd / 3600000);
        const m = Math.floor((sisaCd % 3600000) / 60000);
        const s = Math.floor((sisaCd % 60000) / 1000);
        await reply(`Kamu sudah ambil gaji hari ini!\nTunggu *${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}* lagi.`);
        return true;
      }

      const JOB_GAJI = {
        'gojek': {min:50000,max:100000}, 'kurir': {min:60000,max:200000},
        'sopir': {min:60000,max:200000}, 'karyawan indomaret': {min:100000,max:300000},
        'kantoran': {min:150000,max:400000}, 'dokter': {min:200000,max:600000},
        'frontend developer': {min:180000,max:600000}, 'web developer': {min:180000,max:600000},
        'backend developer': {min:180000,max:600000}, 'fullstack developer': {min:250000,max:700000},
        'game developer': {min:180000,max:600000}, 'pemain sepak bola': {min:150000,max:500000},
        'trader': {min:100000,max:800000}, 'hunter': {min:80000,max:300000},
        'polisi': {min:300000,max:500000},
      };

      const gData   = JOB_GAJI[member.job] || { min: 50000, max: 100000 };
      const gaji    = Math.floor(Math.random() * (gData.max - gData.min + 1)) + gData.min;
      const jobexp  = Math.min(500, (member.jobexp || 0) + 1);
      const newMoney = (Number(member.money) || 0) + gaji;
      const kapital = member.job.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

      await updateMember(botId, sender, {
        money:       newMoney,
        jobexp,
        last_gajian: new Date().toISOString().slice(0, 19).replace('T', ' '),
      });

      await reply(
        `💼 *GAJIAN*\n\n` +
        `👤 ${member.name || pushName}\n` +
        `💼 Pekerjaan : *${kapital}*\n` +
        `💰 Gaji      : *+${formatNum(gaji)} koin*\n` +
        `📊 Job EXP   : *${jobexp}%* / 500%\n\n` +
        `Total koin: *${formatNum(newMoney)}*\n` +
        `⚡ Energi sisa: *${energiSekarang(member)}*`
      );
      return true;
    }

    // ── dungeon ───────────────────────────────────────────────────────────────
    case 'dungeon': {
      if (!isGroup) { await reply('Dungeon hanya bisa dimainkan di grup!'); return true; }
      const botId  = botData.id;
      const member = await getOrCreateMember(botId, sender, pushName);
      const roomName = args.join(' ').trim() || null;

      // Cek syarat: gear Lv >= 1 & durability masih ada, healt >= 90
      // ponytail: pakai gearDipakai(), BUKAN gearLevel() — gear rusak (dur 0)
      // levelnya masih > 0, jadi gate-nya bocor kalau pakai level doang.
      const sword = gearDipakai(member, 'weapon');
      const armor = gearDipakai(member, 'armor');
      const healt = Number(member.healt) || 100;

      if (sword < 1) {
        await reply(
          gearLevel(member, 'weapon') >= 1
            ? `💥 *Pedangmu rusak!* Perbaiki dulu: ${p}repair`
            : `⚔️ Kamu butuh *pedang* untuk masuk dungeon!\n\nBeli dulu di ${p}store`
        );
        return true;
      }
      if (armor < 1) {
        await reply(
          gearLevel(member, 'armor') >= 1
            ? `💥 *Armormu rusak!* Perbaiki dulu: ${p}repair`
            : `🛡️ Kamu butuh *armor* untuk masuk dungeon!\n\nBeli dulu di ${p}store`
        );
        return true;
      }
      if (healt < 90) {
        await reply(`❤️ Health kamu terlalu rendah (*${healt}/100*)!\n\nMinum *Ramuan Health* (${p}beli 3 → ${p}pakai 3)`);
        return true;
      }

      // Cek cooldown
      const cdSisa = cdRemain(member.last_dungeon, 300000); // 5 menit cooldown
      if (cdSisa > 0) {
        const m = Math.floor(cdSisa / 60000);
        const s = Math.floor((cdSisa % 60000) / 1000);
        await reply(`Tunggu *${m}m ${s}d* sebelum masuk dungeon lagi!`);
        return true;
      }

      // Cek apakah sender sudah di dungeon
      const alreadyIn = [...dungeonRooms.values()].find(r =>
        [r.p1, r.p2, r.p3, r.p4].includes(sender)
      );
      if (alreadyIn) { await reply('Kamu masih di dalam Dungeon!'); return true; }

      // Energi dipotong TERAKHIR, setelah semua syarat lolos
      const cukupEnergi = await pakaiEnergi(botId, sender, member, 30);
      if (!cukupEnergi.ok) { await reply(pesanEnergiKurang(cukupEnergi.energi, 30)); return true; }

      // Cari room WAITING yang cocok
      const existingRoom = [...dungeonRooms.values()].find(r =>
        r.state === 'WAITING' && r.jid === jid && (roomName ? r.name === roomName : true)
      );

      if (existingRoom) {
        // Join room existing
        if (!existingRoom.p2) {
          existingRoom.p2 = sender;
        } else if (!existingRoom.p3) {
          existingRoom.p3 = sender;
        } else if (!existingRoom.p4) {
          existingRoom.p4 = sender;
        } else {
          await reply('Room dungeon sudah penuh (4 player)!');
          return true;
        }

        const players = [existingRoom.p1, existingRoom.p2, existingRoom.p3, existingRoom.p4].filter(Boolean);
        const playerMentions = players.map(p => `@${resolveMentionNum(p)}`).join(', ');
        await client.message.send(jid,
          `⚔️ *DUNGEON — ${existingRoom.name}*\n\n@${resolveMentionNum(sender)} bergabung!\n\nPlayer (${players.length}/4): ${playerMentions}\n\nKetik *gass* untuk mulai dungeon!`,
          { mentions: players }
        );
      } else {
        // Buat room baru
        const rName  = roomName || `Dungeon-${Date.now()}`;
        const roomId = `dungeon-${Date.now()}`;
        dungeonRooms.set(roomId, {
          id: roomId, jid, name: rName,
          p1: sender, p2: null, p3: null, p4: null,
          state: 'WAITING',
        });

        await client.message.send(jid,
          `⚔️ *DUNGEON DIBUKA!*\n\n` +
          `🏰 Room  : *${rName}*\n` +
          `👤 Host  : @${resolveMentionNum(sender)}\n\n` +
          `Ketik *${p}dungeon ${rName}* untuk bergabung (max 4 player)\n` +
          `Ketik *gass* untuk mulai solo atau setelah ada teman bergabung!`,
          { mentions: [sender] }
        );
      }
      return true;
    }

    // ── leaderboard / lb ─────────────────────────────────────────────────────
    case 'leaderboard':
    case 'lb': {
      const botId = botData.id;
      const mode  = (args[0] || '').toLowerCase();
      const isLevel = mode === 'level' || mode === 'lvl';

      if (isLevel) {
        const [rows] = await pool.execute(
          `SELECT name, level, xp FROM rpg_members WHERE bot_id = ? ORDER BY level DESC, xp DESC LIMIT 10`,
          [botId]
        );
        if (!rows.length) { await reply('Belum ada data RPG.'); return true; }
        let txt = `🏆 *TOP LEVEL*\n\n`;
        rows.forEach((r, i) => {
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
          txt += `${medal} *${r.name || 'Unknown'}*\n   Level ${r.level} — ${formatNum(r.xp)} XP\n`;
        });
        txt += `\nKetik ${p}lb untuk top koin`;
        await reply(txt);
      } else {
        const [rows] = await pool.execute(
          `SELECT name, money, bank_money FROM rpg_members WHERE bot_id = ? ORDER BY (money + bank_money) DESC LIMIT 10`,
          [botId]
        );
        if (!rows.length) { await reply('Belum ada data RPG.'); return true; }
        let txt = `💰 *TOP KOIN*\n\n`;
        rows.forEach((r, i) => {
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
          const total = (Number(r.money) || 0) + (Number(r.bank_money) || 0);
          txt += `${medal} *${r.name || 'Unknown'}*\n   ${formatNum(total)} koin\n`;
        });
        txt += `\nKetik ${p}lb level untuk top level`;
        await reply(txt);
      }
      return true;
    }

    // ── bank / atm ────────────────────────────────────────────────────────────
    case 'bank':
    case 'atm': {
      const botId  = botData.id;
      const { aksi, jumlah: minta, semua } = bacaAtm(args);
      const member = await getOrCreateMember(botId, sender, pushName);
      const dompet = Number(member.money) || 0;
      const bank   = Number(member.bank_money) || 0;

      if (aksi === 'info') {
        await reply(
          `🏦 *BANK*\n\n` +
          `👤 ${member.name || pushName}\n\n` +
          `💵 Dompet : *${formatNum(dompet)} koin*\n` +
          `🏦 Bank   : *${formatNum(bank)} koin*\n` +
          `📊 Total  : *${formatNum(dompet + bank)} koin*\n\n` +
          `${p}atm <jumlah> — setor (contoh: ${p}atm 100)\n` +
          `${p}atm all — setor semua uang di kantong\n` +
          `${p}atm pull <jumlah> — tarik dari bank\n` +
          `${p}atm pull all — tarik semua dari bank`
        );
        return true;
      }

      if (aksi === 'setor') {
        const n = semua ? dompet : minta;
        if (!n || isNaN(n) || n <= 0) {
          await reply(semua
            ? `❌ Kantong kamu kosong, nggak ada yang bisa disetor.`
            : `Penggunaan: ${p}atm <jumlah>\natau: ${p}atm all — setor semua uang di kantong`);
          return true;
        }
        if (!semua && n < 10) { await reply('❌ Minimal simpan 10 koin!'); return true; }
        if (dompet < n) {
          await reply(`❌ Koin di dompet tidak cukup!\n\nDompet: *${formatNum(dompet)}*`);
          return true;
        }
        await updateMember(botId, sender, { money: dompet - n, bank_money: bank + n });
        await reply(
          `🏦 *SETOR BANK*${semua ? ' (SEMUA)' : ''}\n\n` +
          `✅ *${formatNum(n)} koin* berhasil disimpan!\n\n` +
          `💵 Dompet : *${formatNum(dompet - n)} koin*\n` +
          `🏦 Bank   : *${formatNum(bank + n)} koin*`
        );
        return true;
      }

      if (aksi === 'tarik') {
        const n = semua ? bank : minta;
        if (!n || isNaN(n) || n <= 0) {
          await reply(semua
            ? `❌ Bank kamu kosong, nggak ada yang bisa ditarik.`
            : `Penggunaan: ${p}atm pull <jumlah>\natau: ${p}atm pull all`);
          return true;
        }
        if (!semua && n < 10) { await reply('❌ Minimal tarik 10 koin!'); return true; }
        if (bank < n) {
          await reply(`❌ Saldo bank tidak cukup!\n\nBank: *${formatNum(bank)}*`);
          return true;
        }
        await updateMember(botId, sender, { money: dompet + n, bank_money: bank - n });
        await reply(
          `🏦 *TARIK BANK*${semua ? ' (SEMUA)' : ''}\n\n` +
          `✅ *${formatNum(n)} koin* berhasil ditarik!\n\n` +
          `💵 Dompet : *${formatNum(dompet + n)} koin*\n` +
          `🏦 Bank   : *${formatNum(bank - n)} koin*`
        );
        return true;
      }

      await reply(
        `🏦 *BANK — Perintah*\n\n` +
        `${p}atm — lihat saldo\n` +
        `${p}atm <jumlah> — setor ke bank (contoh: ${p}atm 100)\n` +
        `${p}atm all — setor SEMUA uang di kantong\n` +
        `${p}atm pull <jumlah> — tarik dari bank\n` +
        `${p}atm pull all — tarik semua dari bank\n` +
        `${p}bank simpan/tarik <jumlah> — sama aja`
      );
      return true;
    }

    // ── mancing ───────────────────────────────────────────────────────────────
    case 'mancing': {
      const botId  = botData.id;
      const member = await getOrCreateMember(botId, sender, pushName);

      // Cek cooldown
      const sisaCd = cdRemain(member.last_mancing, MANCING_COOLDOWN);
      const now    = Date.now();

      if (sisaCd > 0) {
        const mnt = Math.floor(sisaCd / 60000);
        const dtk = Math.floor((sisaCd % 60000) / 1000);
        await reply(`🎣 Joran masih basah!\n\nCoba lagi dalam *${mnt}m ${dtk}d*`);
        return true;
      }

      const cukupEnergi = await pakaiEnergi(botId, sender, member, 15);
      if (!cukupEnergi.ok) { await reply(pesanEnergiKurang(cukupEnergi.energi, 15)); return true; }

      // Animasi mancing (single message langsung)
      const ikan   = pickIkan();
      const reward = ikan.tier === 'Sampah' ? 0
        : Math.floor(Math.random() * (ikan.max - ikan.min + 1)) + ikan.min;
      const xpGet  = ikan.xp + (ctx.isPremium ? 2 : 0);

      // Hitung level up
      const { xp: newXp, level: newLevel } = calcXpLevel(member.xp, member.level || 1, xpGet);
      const newMoney = (Number(member.money) || 0) + reward;

      await updateMember(botId, sender, {
        money:        newMoney,
        xp:           newXp,
        level:        newLevel,
        last_mancing: new Date().toISOString().slice(0, 19).replace('T', ' '),
      });

      const TIER_LABELS = { Kecil: '🟢 Kecil', Sedang: '🟡 Sedang', Besar: '🟠 Besar', Langka: '🔴 Langka', Sampah: '⚫ Sampah' };

      let txt =
        `🎣 *MANCING*\n\n` +
        `${ikan.emoji} Dapat: *${ikan.nama}*\n` +
        `📦 Tier : ${TIER_LABELS[ikan.tier]}\n`;

      if (ikan.tier === 'Sampah') {
        txt += `\n😅 Wah, dapat sampah! Lebih beruntung next time~`;
      } else {
        txt +=
          `💰 Nilai: *+${formatNum(reward)} koin*\n` +
          `✨ XP   : *+${xpGet} XP*`;
        if (newLevel > (member.level || 1)) {
          txt += `\n\n🎉 *LEVEL UP!* Naik ke level *${newLevel}* (${getRankByLevel(newLevel)})`;
        }
        if (ctx.isPremium) txt += `\n⭐ Bonus XP premium diterapkan!`;
        txt += `\n\nTotal koin: *${formatNum(newMoney)}*\n⚡ Energi sisa: *${cukupEnergi.energi}*`;
      }

      await reply(txt);
      return true;
    }

    // ── uptname — ganti nama user (auto-register friendly) ──────────────────
    case 'uptname': {
      const botId = botData.id;

      // Owner bisa ganti nama orang lain via mention/reply
      let targetJid  = sender;
      let targetLabel = 'dirimu';
      if (ctx.isOwner) {
        const mentioned = ctx.mentions?.[0];
        const quotedJid = ctx.quoted?.sender;
        if (mentioned) {
          targetJid    = mentioned;
          targetLabel  = `@${mentioned.split('@')[0]}`;
        } else if (quotedJid) {
          targetJid    = quotedJid;
          targetLabel  = `@${quotedJid.split('@')[0]}`;
        }
      }

      let nama = args.join(' ').trim();
      // Tanpa argumen → pakai pushName si target (sinkron sama nama WA sekarang)
      if (!nama) {
        const isSelf = targetJid === sender;
        const srcName = isSelf ? (pushName || 'User') : (ctx.pushName || 'User');
        const baseName = srcName.replace(/[^a-zA-Z0-9 ]/g, '').trim().slice(0, 20);
        nama = baseName || 'User';
      }

      if (nama.length < 3 || nama.length > 30) { await reply('❌ Nama harus 3–30 karakter!'); return true; }

      // Auto-buat row kalau belum ada, lalu set nama
      await getOrCreateMember(botId, targetJid, nama);
      await pool.execute(
        'UPDATE rpg_members SET name = ? WHERE bot_id = ? AND jid = ?',
        [nama, botId, targetJid]
      );

      await reply(
        `✅ *Nama berhasil diubah!*\n\n` +
        `👤 ${targetLabel === 'dirimu' ? 'Namamu sekarang' : `Nama ${targetLabel} sekarang`}: *${nama}*`
      );
      return true;
    }

    // ── unreg ─────────────────────────────────────────────────────────────────
    case 'unreg': {
      const botId = botData.id;

      // Owner bisa unreg target via mention/reply, user biasa unreg diri sendiri
      let targetJid  = sender;
      let targetLabel = 'dirimu sendiri';

      if (ctx.isOwner) {
        const mentioned = ctx.mentions?.[0];
        const quotedJid = ctx.quoted?.sender;
        if (mentioned) {
          targetJid   = mentioned;
          targetLabel = `@${mentioned.split('@')[0]}`;
        } else if (quotedJid) {
          targetJid   = quotedJid;
          targetLabel = `@${quotedJid.split('@')[0]}`;
        }
      }

      const [checkRows] = await pool.execute(
        'SELECT name, registered FROM rpg_members WHERE bot_id = ? AND jid = ? LIMIT 1',
        [botId, targetJid]
      );

      if (!checkRows[0] || !checkRows[0].registered) {
        await reply(`❌ ${targetJid === sender ? 'Kamu' : targetLabel} belum terdaftar!`);
        return true;
      }

      const namaTarget = checkRows[0].name || targetLabel;

      // Reset data — hapus registered dan nama, reset semua stat
      await pool.execute(
        `UPDATE rpg_members SET
          name = NULL, registered = 0,
          level = 0, xp = 0, money = 0, lim = 0, healt = 0,
          koin = 0, bank = 0, job = 'Pengangguran',
          last_daily = NULL, last_kerja = 0, last_hourly = 0, last_weekly = 0,
          last_dailymisi = 0, last_adventure = 0, last_koboy = 0,
          last_airdrop = 0, last_maling = 0
        WHERE bot_id = ? AND jid = ?`,
        [botId, targetJid]
      );

      if (targetJid === sender) {
        await reply(`✅ Akunmu (*${namaTarget}*) telah dihapus dari bot ini.\n\nKamu akan terdaftar otomatis lagi saat kirim command apa pun.`);
      } else {
        await reply(`✅ Akun *${namaTarget}* berhasil di-unreg oleh owner.`);
      }
      return true;
    }

    // ── kerja ─────────────────────────────────────────────────────────────────
    case 'kerja': {
      const botId = botData.id;
      const member = await getOrCreateMember(botId, sender, pushName);

      // Cek cooldown
      const sisaCd = cdRemain(member.last_kerja, KERJA_COOLDOWN);
      const now    = Date.now();

      if (sisaCd > 0) {
        const jam  = Math.floor(sisaCd / 3600000);
        const mnt  = Math.floor((sisaCd % 3600000) / 60000);
        const dtk  = Math.floor((sisaCd % 60000) / 1000);
        await reply(`⏳ Kamu masih lelah!\n\nIstirahat dulu: *${jam}j ${mnt}m ${dtk}d*`);
        return true;
      }

      // Energi dipotong setelah cooldown lolos
      const cukupEnergi = await pakaiEnergi(botId, sender, member, 25);
      if (!cukupEnergi.ok) { await reply(pesanEnergiKurang(cukupEnergi.energi, 25)); return true; }

      const JOBS = [
        { nama: 'Petani',    min: 80,  max: 200, xp: 5  },
        { nama: 'Nelayan',   min: 100, max: 250, xp: 7  },
        { nama: 'Pedagang',  min: 150, max: 350, xp: 10 },
        { nama: 'Penjaga',   min: 120, max: 280, xp: 8  },
        { nama: 'Pengrajin', min: 130, max: 300, xp: 9  },
        { nama: 'Pemburu',   min: 200, max: 450, xp: 12 },
      ];
      const job    = JOBS[Math.floor(Math.random() * JOBS.length)];
      const reward = Math.floor(Math.random() * (job.max - job.min + 1)) + job.min;
      const xpGet  = job.xp + (ctx.isPremium ? 3 : 0);

      // Hitung level up
      const { xp: newXp, level: newLevel } = calcXpLevel(member.xp, member.level || 1, xpGet);
      const newMoney = (Number(member.money) || 0) + reward;

      await updateMember(botId, sender, {
        money:      newMoney,
        xp:         newXp,
        level:      newLevel,
        last_kerja: new Date().toISOString().slice(0, 19).replace('T', ' '),
      });

      let txt =
        `💼 *KERJA — ${job.nama}*\n\n` +
        `💰 Dapat: *+${formatNum(reward)} koin*\n` +
        `✨ XP   : *+${xpGet} XP*`;
      if (newLevel > (member.level || 1)) {
        txt += `\n\n🎉 *LEVEL UP!* Kamu naik ke level *${newLevel}* (${getRankByLevel(newLevel)})`;
      }
      if (ctx.isPremium) txt += `\n⭐ Bonus XP premium sudah diterapkan!`;
      txt += `\n\nTotal koin: *${formatNum(newMoney)}*\n⚡ Energi sisa: *${cukupEnergi.energi}*`;
      await reply(txt);
      return true;
    }

    // ── transfer / tf ─────────────────────────────────────────────────────────
    case 'transfer':
    case 'tf': {
      if (!isGroup) { await reply('Transfer hanya bisa dilakukan di grup.'); return true; }
      const botId    = botData.id;
      const mentioned = getMentioned(ctx);
      const target   = mentioned[0];
      const nominal  = parseInt(args.filter(a => !a.startsWith('@')).join(''), 10);

      if (!target || !nominal) {
        await reply(`Penggunaan: ${p}transfer @user <jumlah>\n\nContoh: ${p}transfer @John 500`);
        return true;
      }
      if (target === sender) { await reply('❌ Tidak bisa transfer ke diri sendiri!'); return true; }
      if (nominal <= 0 || isNaN(nominal)) { await reply('❌ Jumlah tidak valid!'); return true; }
      if (nominal < 10) { await reply('❌ Minimal transfer 10 koin!'); return true; }

      const pengirim  = await getOrCreateMember(botId, sender, pushName);
      if ((pengirim.money || 0) < nominal) {
        await reply(`❌ Koin tidak cukup!\n\nKoinmu: *${formatNum(pengirim.money || 0)}*\nDibutuhkan: *${formatNum(nominal)}*`);
        return true;
      }

      // Ambil nama penerima
      const [tRows] = await pool.execute(
        'SELECT name, money FROM rpg_members WHERE bot_id = ? AND jid = ? LIMIT 1',
        [botId, target]
      );
      const penerima = tRows[0];
      if (!penerima) {
        // Auto-create penerima
        await getOrCreateMember(botId, target, resolveMentionNum(target));
      }
      const penerimaMoney = penerima ? (penerima.money || 0) : 0;
      const penerimaNama  = penerima?.name || resolveMentionNum(target);

      // Potong tax 2%
      const tax      = Math.floor(nominal * 0.02);
      const diterima = nominal - tax;

      await updateMember(botId, sender, { money: (pengirim.money || 0) - nominal });
      await updateMember(botId, target, { money: penerimaMoney + diterima });

      await client.message.send(jid,
        `💸 *TRANSFER BERHASIL*\n\n` +
        `Dari  : @${resolveMentionNum(sender)}\n` +
        `Ke    : @${resolveMentionNum(target)}\n` +
        `Jumlah: *${formatNum(nominal)} koin*\n` +
        `Pajak : *${formatNum(tax)} koin* (2%)\n` +
        `Diterima: *${formatNum(diterima)} koin*\n\n` +
        `Sisa koinmu: *${formatNum((pengirim.money || 0) - nominal)}*`,
        { mentions: [sender, target] }
      );
      return true;
    }

    // ── coinflip ──────────────────────────────────────────────────────────────
    case 'coinflip':
    case 'cf': {
      const botId  = botData.id;
      const pilihan = (args[0] || '').toLowerCase();
      const nominal = parseInt(args[1] || args[0], 10);

      if (!['heads', 'tails', 'h', 't', 'angka', 'gambar'].includes(pilihan) || !nominal || isNaN(nominal)) {
        await reply(
          `🪙 *COIN FLIP*\n\n` +
          `Penggunaan: ${p}coinflip <heads/tails> <jumlah>\n\n` +
          `Contoh: ${p}coinflip heads 200\n` +
          `Alias: h = heads, t = tails, angka = heads, gambar = tails`
        );
        return true;
      }
      if (nominal < 10) { await reply('❌ Minimal taruhan 10 koin!'); return true; }
      if (nominal > 50000) { await reply('❌ Maksimal taruhan 50.000 koin!'); return true; }

      const member = await getOrCreateMember(botId, sender, pushName);
      if ((member.money || 0) < nominal) {
        await reply(`❌ Koin tidak cukup!\n\nKoinmu: *${formatNum(member.money || 0)}*`);
        return true;
      }

      const isHeads  = ['heads', 'h', 'angka'].includes(pilihan);
      const result   = Math.random() < 0.5 ? 'heads' : 'tails';
      const menang   = isHeads === (result === 'heads');
      const newMoney = menang
        ? (member.money || 0) + nominal
        : (member.money || 0) - nominal;

      await updateMember(botId, sender, { money: newMoney });

      await reply(
        `🪙 *COIN FLIP*\n\n` +
        `Pilihanmu : *${isHeads ? 'Heads (Angka)' : 'Tails (Gambar)'}*\n` +
        `Hasil     : *${result === 'heads' ? '🔵 Heads (Angka)' : '🟡 Tails (Gambar)'}*\n\n` +
        (menang
          ? `🎉 *MENANG!* +${formatNum(nominal)} koin`
          : `😢 *KALAH!* -${formatNum(nominal)} koin`) +
        `\n\nSisa koin: *${formatNum(newMoney)}*`
      );
      return true;
    }

    // ── tictactoe ─────────────────────────────────────────────────────────────
    case 'tictactoe':
    case 'ttt': {
      if (!isGroup) { await reply('Tictactoe hanya bisa dimainkan di grup!'); return true; }
      const mentioned = getMentioned(ctx);
      const target    = mentioned[0];
      if (!target) { await reply(`Penggunaan: ${p}tictactoe @lawan\n\nContoh: ${p}ttt @John`); return true; }
      if (target === sender) { await reply('❌ Tidak bisa main melawan diri sendiri!'); return true; }

      const roomId = `ttt:${jid}:${sender}:${target}`;
      // Cek apakah sudah ada game aktif di grup ini
      const activeRoom = [...tictactoeGames.values()].find(r => r.jid === jid);
      if (activeRoom) { await reply('❌ Masih ada game Tictactoe aktif di grup ini! Selesaikan dulu.'); return true; }

      const board = Array(9).fill('⬜');
      tictactoeGames.set(roomId, {
        roomId, jid,
        p1: sender, p2: target,
        board,
        turn: sender, // p1 mulai
        status: 'playing',
      });

      const mentionP1 = resolveMentionNum(sender);
      const mentionP2 = resolveMentionNum(target);

      await client.message.send(jid,
        `❌⭕ *TICTACTOE*\n\n` +
        `@${mentionP1} (❌) vs @${mentionP2} (⭕)\n\n` +
        `${renderTTTBoard(board)}\n\n` +
        `Giliran: @${mentionP1} (❌)\n\n` +
        `Cara main: ketik angka 1–9 sesuai posisi:\n` +
        `1️⃣2️⃣3️⃣\n4️⃣5️⃣6️⃣\n7️⃣8️⃣9️⃣`,
        { mentions: [sender, target] }
      );
      return true;
    }

    // ── .gacha ────────────────────────────────────────────────────────────────
    case 'gacha': {
      const botId = botData.id;
      const member = await getOrCreateMember(botId, sender, pushName);

      const GACHA_COST = 300;
      const GACHA_TABLE = [
        // [ nama, rarity, koin_min, koin_max, xp, emoji, weight ]
        { nama: 'Batu Biasa',      rarity: 'Common',    koin: [0,   0],    xp: 0,  emoji: '🪨', weight: 35 },
        { nama: 'Koin Receh',      rarity: 'Common',    koin: [50,  150],  xp: 2,  emoji: '🪙', weight: 30 },
        { nama: 'Ramuan Kecil',    rarity: 'Common',    koin: [100, 200],  xp: 5,  emoji: '🧪', weight: 15 },
        { nama: 'Pedang Rusak',    rarity: 'Uncommon',  koin: [200, 400],  xp: 10, emoji: '⚔️', weight: 10 },
        { nama: 'Tameng Retak',    rarity: 'Uncommon',  koin: [200, 400],  xp: 10, emoji: '🛡️', weight: 7  },
        { nama: 'Jimat Keberuntungan', rarity: 'Rare',  koin: [500, 900],  xp: 25, emoji: '🍀', weight: 2  },
        { nama: 'Kristal Langka',  rarity: 'Rare',      koin: [800, 1500], xp: 40, emoji: '💎', weight: 1  },
      ];

      if ((member.money || 0) < GACHA_COST) {
        await reply(`❌ Koin tidak cukup!\nBiaya gacha: *${formatNum(GACHA_COST)} koin*\nKoin kamu: *${formatNum(member.money || 0)} koin*`);
        return true;
      }

      // Weighted random pick
      const totalW = GACHA_TABLE.reduce((a, b) => a + b.weight, 0);
      let rand = Math.random() * totalW;
      let hasil = GACHA_TABLE[0];
      for (const item of GACHA_TABLE) {
        rand -= item.weight;
        if (rand <= 0) { hasil = item; break; }
      }

      const koinDapat = hasil.koin[0] === 0 ? 0 : Math.floor(Math.random() * (hasil.koin[1] - hasil.koin[0] + 1)) + hasil.koin[0];
      const newMoney  = (member.money || 0) - GACHA_COST + koinDapat;
      const res       = await applyXpGain(botData.id, sender, hasil.xp, { money: newMoney });

      const rarityEmoji = { Common: '⚪', Uncommon: '🟢', Rare: '🔵', Epic: '🟣', Legendary: '🟡' };
      await reply(
        `🎰 *GACHA*\n\n` +
        `Biaya: -${formatNum(GACHA_COST)} koin\n\n` +
        `╔══════════════╗\n` +
        `║  ${hasil.emoji} ${hasil.nama.padEnd(12)}\n` +
        `║  ${rarityEmoji[hasil.rarity] || '⚪'} ${hasil.rarity}\n` +
        `╚══════════════╝\n\n` +
        `💰 Dapat: +${formatNum(koinDapat)} koin\n` +
        `⭐ XP: +${hasil.xp}\n` +
        (res.leveledUp ? `\n🎉 *LEVEL UP!* Naik ke level *${res.newLevel}* (${getRankByLevel(res.newLevel)})` : '') +
        `\n\nSisa koin: *${formatNum(newMoney)}*`
      );
      return true;
    }

    // ── .slot ─────────────────────────────────────────────────────────────────
    case 'slot': {
      const botId = botData.id;
      const member = await getOrCreateMember(botId, sender, pushName);

      const SLOT_COST = 100;
      const SLOT_SYMBOLS = ['🍒', '🍋', '🍇', '⭐', '💎', '🔔', '🍀'];
      // Bobot: simbol mahal lebih jarang
      const SLOT_WEIGHTS = [30, 25, 20, 12, 5, 5, 3];

      if ((member.money || 0) < SLOT_COST) {
        await reply(`❌ Koin tidak cukup!\nBiaya slot: *${formatNum(SLOT_COST)} koin*\nKoin kamu: *${formatNum(member.money || 0)} koin*`);
        return true;
      }

      function pickSlotSymbol() {
        const total = SLOT_WEIGHTS.reduce((a, b) => a + b, 0);
        let r = Math.random() * total;
        for (let i = 0; i < SLOT_SYMBOLS.length; i++) {
          r -= SLOT_WEIGHTS[i];
          if (r <= 0) return SLOT_SYMBOLS[i];
        }
        return SLOT_SYMBOLS[0];
      }

      const reels = [pickSlotSymbol(), pickSlotSymbol(), pickSlotSymbol()];
      const [a, b, c] = reels;

      // Hitung kemenangan
      let multiplier = 0;
      let resultText = '😢 Tidak menang';
      if (a === b && b === c) {
        // Jackpot — tiga sama
        const jackpots = { '💎': 50, '🍀': 30, '⭐': 20, '🔔': 15, '🍇': 10, '🍒': 8, '🍋': 6 };
        multiplier = jackpots[a] || 5;
        resultText = `🎉 *JACKPOT! ${a}${b}${c}*`;
      } else if (a === b || b === c || a === c) {
        // Dua sama
        multiplier = 2;
        resultText = '✨ Dua sama! x2';
      } else if (reels.includes('💎')) {
        // Ada diamond = kembali modal
        multiplier = 1;
        resultText = '💎 Ada diamond, balik modal!';
      }

      const menang   = Math.floor(SLOT_COST * multiplier);
      const newMoney = (member.money || 0) - SLOT_COST + menang;
      await updateMember(botData.id, sender, { money: newMoney });

      await reply(
        `🎰 *SLOT MACHINE*\n\n` +
        `╔═══════════╗\n` +
        `║ ${a}  ${b}  ${c} ║\n` +
        `╚═══════════╝\n\n` +
        `${resultText}\n` +
        `Bayar: -${formatNum(SLOT_COST)} koin\n` +
        `Dapat: +${formatNum(menang)} koin\n\n` +
        `Sisa koin: *${formatNum(newMoney)}*\n\n` +
        `_Jackpot 💎x50 🍀x30 ⭐x20 🔔x15_`
      );
      return true;
    }

    // ── hourly ────────────────────────────────────────────────────────────────
    case 'hourly': {
      const botId  = botData.id;
      const member = await getOrCreateMember(botId, sender, pushName);

      const HOURLY_COOLDOWN = 3600 * 1000; // 1 jam
      const sisaCd = cdRemain(member.last_hourly, HOURLY_COOLDOWN);
      const now    = Date.now();

      if (sisaCd > 0) {
        const mnt = Math.floor(sisaCd / 60000);
        const dtk = Math.floor((sisaCd % 60000) / 1000);
        await reply(`⏳ *HOURLY* masih cooldown!\n\nCoba lagi dalam *${mnt}m ${dtk}d*`);
        return true;
      }

      const koinGet = Math.floor(Math.random() * 151) + 100; // 100–250
      const xpGet   = Math.floor(Math.random() * 6) + 5 + (ctx.isPremium ? 3 : 0); // 5–10 (+3 premium)

      const { xp: newXp, level: newLevel } = calcXpLevel(member.xp, member.level || 1, xpGet);
      const newMoney = (Number(member.money) || 0) + koinGet;

      await updateMember(botId, sender, {
        money:        newMoney,
        xp:           newXp,
        level:        newLevel,
        last_hourly:  now,
      });

      let txt =
        `⏰ *HOURLY CLAIM*\n\n` +
        `💰 Koin : *+${formatNum(koinGet)}*\n` +
        `✨ XP   : *+${xpGet}*`;
      if (newLevel > (member.level || 1)) txt += `\n\n🎉 *LEVEL UP!* → Level *${newLevel}* (${getRankByLevel(newLevel)})`;
      if (ctx.isPremium) txt += `\n⭐ Bonus XP premium!`;
      txt += `\n\nTotal koin: *${formatNum(newMoney)}*\nKlaim lagi dalam *1 jam*`;
      await reply(txt);
      return true;
    }

    // ── weekly ────────────────────────────────────────────────────────────────
    case 'weekly': {
      const botId  = botData.id;
      const member = await getOrCreateMember(botId, sender, pushName);

      const WEEKLY_COOLDOWN = 7 * 86400 * 1000; // 7 hari
      const sisaCd = cdRemain(member.last_weekly, WEEKLY_COOLDOWN);
      const now    = Date.now();

      if (sisaCd > 0) {
        const hari = Math.floor(sisaCd / 86400000);
        const jam  = Math.floor((sisaCd % 86400000) / 3600000);
        const mnt  = Math.floor((sisaCd % 3600000) / 60000);
        await reply(`⏳ *WEEKLY* masih cooldown!\n\nCoba lagi dalam *${hari}h ${jam}j ${mnt}m*`);
        return true;
      }

      const koinGet  = Math.floor(Math.random() * 1001) + 2000; // 2000–3000
      const xpGet    = Math.floor(Math.random() * 51) + 50 + (ctx.isPremium ? 20 : 0); // 50–100 (+20 premium)
      const limGet   = 10; // +10 limit

      const { xp: newXp, level: newLevel } = calcXpLevel(member.xp, member.level || 1, xpGet);
      const newMoney = (Number(member.money) || 0) + koinGet;
      const newLim   = (Number(member.lim) || 0) + limGet;

      await updateMember(botId, sender, {
        money:       newMoney,
        xp:          newXp,
        level:       newLevel,
        lim:         newLim,
        last_weekly: now,
      });

      let txt =
        `📅 *WEEKLY CLAIM*\n\n` +
        `💰 Koin  : *+${formatNum(koinGet)}*\n` +
        `✨ XP    : *+${xpGet}*\n` +
        `🔋 Limit : *+${limGet}*`;
      if (newLevel > (member.level || 1)) txt += `\n\n🎉 *LEVEL UP!* → Level *${newLevel}* (${getRankByLevel(newLevel)})`;
      if (ctx.isPremium) txt += `\n⭐ Bonus XP premium!`;
      txt += `\n\nTotal koin: *${formatNum(newMoney)}*\nKlaim lagi dalam *7 hari*`;
      await reply(txt);
      return true;
    }

    // ── dailymisi ─────────────────────────────────────────────────────────────
    case 'dailymisi': {
      const botId  = botData.id;
      const member = await getOrCreateMember(botId, sender, pushName);

      const MISI_COOLDOWN = 86400 * 1000; // 24 jam
      const sisaCd = cdRemain(member.last_dailymisi, 86400000);
      const now    = Date.now();

      if (sisaCd > 0) {
        const jam = Math.floor(sisaCd / 3600000);
        const mnt = Math.floor((sisaCd % 3600000) / 60000);
        await reply(`⏳ Misi harian sudah selesai!\n\nKembali dalam *${jam}j ${mnt}m*`);
        return true;
      }

      // Random misi dari pool
      const MISI_POOL = [
        { nama: 'Kalahkan 5 monster hutan',     koin: [800,  1200], xp: 30, emoji: '🌲' },
        { nama: 'Kumpulkan 10 material langka',  koin: [1000, 1500], xp: 40, emoji: '💎' },
        { nama: 'Jelajahi gua misterius',        koin: [900,  1300], xp: 35, emoji: '🕳️' },
        { nama: 'Antar pesan ke desa terpencil', koin: [700,  1100], xp: 25, emoji: '📜' },
        { nama: 'Selamatkan penduduk desa',      koin: [1200, 2000], xp: 50, emoji: '🏘️' },
        { nama: 'Bunuh bos dungeon mini',        koin: [1500, 2500], xp: 60, emoji: '👹' },
        { nama: 'Cari harta karun terpendam',    koin: [1100, 1800], xp: 45, emoji: '🗺️' },
      ];
      const misi     = MISI_POOL[Math.floor(Math.random() * MISI_POOL.length)];
      const koinGet  = Math.floor(Math.random() * (misi.koin[1] - misi.koin[0] + 1)) + misi.koin[0];
      const xpGet    = misi.xp + (ctx.isPremium ? 15 : 0);

      // Bonus random
      const bonusRoll = Math.random();
      let bonusTxt = '';
      let bonusKoin = 0;
      if (bonusRoll < 0.15) {
        bonusKoin = Math.floor(koinGet * 0.5);
        bonusTxt  = `\n🍀 *BONUS LUCKY!* +${formatNum(bonusKoin)} koin ekstra!`;
      }

      const { xp: newXp, level: newLevel } = calcXpLevel(member.xp, member.level || 1, xpGet);
      const newMoney = (Number(member.money) || 0) + koinGet + bonusKoin;

      await updateMember(botId, sender, {
        money:          newMoney,
        xp:             newXp,
        level:          newLevel,
        last_dailymisi: now,
      });

      let txt =
        `📋 *MISI HARIAN*\n\n` +
        `${misi.emoji} Misi: *${misi.nama}*\n\n` +
        `💰 Reward : *+${formatNum(koinGet)} koin*\n` +
        `✨ XP     : *+${xpGet}*` +
        bonusTxt;
      if (newLevel > (member.level || 1)) txt += `\n\n🎉 *LEVEL UP!* → Level *${newLevel}* (${getRankByLevel(newLevel)})`;
      if (ctx.isPremium) txt += `\n⭐ Bonus XP premium!`;
      txt += `\n\nTotal koin: *${formatNum(newMoney)}*\nMisi baru tersedia dalam *24 jam*`;
      await reply(txt);
      return true;
    }

    // ── adventure ─────────────────────────────────────────────────────────────
    case 'adventure': {
      const botId  = botData.id;
      const member = await getOrCreateMember(botId, sender, pushName);

      const ADV_COOLDOWN = 2 * 3600 * 1000; // 2 jam
      const sisaCd = cdRemain(member.last_adventure, ADV_COOLDOWN);
      const now    = Date.now();

      if (sisaCd > 0) {
        const jam = Math.floor(sisaCd / 3600000);
        const mnt = Math.floor((sisaCd % 3600000) / 60000);
        await reply(`⚔️ Kamu masih lelah setelah petualangan!\n\nIstirahat dulu: *${jam}j ${mnt}m*`);
        return true;
      }

      // Cek equipment — level gear ada di hewan_json.gear, durability menentukan
      // apakah bonusnya masih berlaku
      const sword = gearDipakai(member, 'weapon');
      const armor = gearDipakai(member, 'armor');
      const level = member.level || 1;
      const data  = bacaJson(member);

      if (sword < 1 || armor < 1) {
        await reply(
          `⚔️ *Kamu belum siap bertualang!*\n\n` +
          `Butuh pedang *dan* tameng yang masih bisa dipakai (durability > 0).\n\n` +
          `🗡️ Sword: ${statGear(member, 'weapon')}\n` +
          `🛡️ Armor: ${statGear(member, 'armor')}\n\n` +
          `Beli di: ${p}store  •  benerin: ${p}repair`
        );
        return true;
      }

      // Energi dipotong TERAKHIR, setelah semua syarat lolos — biar pemain
      // nggak kehilangan energi buat aktivitas yang tetep ditolak.
      const cukupEnergi = await pakaiEnergi(botId, sender, member, 40);
      if (!cukupEnergi.ok) { await reply(pesanEnergiKurang(cukupEnergi.energi, 40)); return true; }

      // Monster berdasarkan level
      const MONSTERS = [
        { nama: 'Tikus Hutan',    hp: 30,  atk: 5,  reward: [100, 200],   xp: 10, emoji: '🐀', minLv: 1  },
        { nama: 'Goblin Kecil',   hp: 50,  atk: 10, reward: [200, 400],   xp: 18, emoji: '👺', minLv: 2  },
        { nama: 'Serigala Lapar', hp: 80,  atk: 15, reward: [350, 600],   xp: 28, emoji: '🐺', minLv: 3  },
        { nama: 'Ork Berzirah',   hp: 120, atk: 22, reward: [600, 1000],  xp: 40, emoji: '🧌', minLv: 5  },
        { nama: 'Naga Muda',      hp: 200, atk: 35, reward: [1200, 2000], xp: 70, emoji: '🐉', minLv: 8  },
        { nama: 'Iblis Hutan',    hp: 300, atk: 50, reward: [2500, 4000], xp: 110, emoji: '😈', minLv: 12 },
      ];

      // Filter monster yang sesuai level, ambil yang terberat bisa dilawan
      const eligible = MONSTERS.filter(m => m.minLv <= level);
      const monster  = eligible[Math.floor(Math.random() * eligible.length)];

      // Hitung ATK & DEF player
      const playerAtk = 10 + (level * 3) + (sword * 5);
      const playerDef = 5  + (level * 2) + (armor * 4);
      const playerHp  = Number(member.healt) || (50 + level * 10);

      // Simulasi pertarungan (max 10 ronde)
      let pHp = playerHp;
      let mHp = monster.hp;
      let ronde = 0;
      let log = [];

      while (pHp > 0 && mHp > 0 && ronde < 10) {
        ronde++;
        // Player serang monster
        const dmgToM = Math.max(1, playerAtk - Math.floor(Math.random() * 5));
        mHp -= dmgToM;
        // Monster serang player
        const dmgToP = Math.max(1, monster.atk - playerDef + Math.floor(Math.random() * 5));
        pHp -= dmgToP;
        if (ronde <= 3) log.push(`Ronde ${ronde}: Kamu -${dmgToM} Health monster | Monster -${dmgToP} Health kamu`);
      }

      const menang = mHp <= 0;
      const now2   = Date.now();

      if (menang) {
        const koinGet = Math.floor(Math.random() * (monster.reward[1] - monster.reward[0] + 1)) + monster.reward[0];
        const xpGet   = monster.xp + (ctx.isPremium ? 10 : 0);
        const { xp: newXp, level: newLevel } = calcXpLevel(member.xp, level, xpGet);
        const newMoney = (Number(member.money) || 0) + koinGet;
        const newHp    = Math.max(10, Math.floor(pHp)); // HP sisa

        // Gear aus dipakai: -3 durability (menang), -5 kalau kalah
        kurangiDur(data, 'weapon', 3);
        kurangiDur(data, 'armor',  3);

        await updateMember(botId, sender, {
          money:         newMoney,
          xp:            newXp,
          level:         newLevel,
          healt:         newHp,
          hewan_json:    JSON.stringify(data),
          last_adventure: now2,
        });

        let txt =
          `⚔️ *ADVENTURE — MENANG!*\n\n` +
          `${monster.emoji} Musuh: *${monster.nama}*\n` +
          `🗡️ Sword: Lv.${sword} | 🛡️ Armor: Lv.${armor}\n\n` +
          log.join('\n') + (log.length ? '\n...\n' : '') +
          `\n✅ *${monster.nama} dikalahkan dalam ${ronde} ronde!*\n\n` +
          `💰 Reward : *+${formatNum(koinGet)} koin*\n` +
          `✨ XP     : *+${xpGet}*\n` +
          `❤️ Health sisa: *${newHp}*` +
          barisDur(data, 'weapon', '🗡️', 'Sword') +
          barisDur(data, 'armor',  '🛡️', 'Armor');
        if (newLevel > level) txt += `\n\n🎉 *LEVEL UP!* → Level *${newLevel}* (${getRankByLevel(newLevel)})`;
        if (ctx.isPremium) txt += `\n⭐ Bonus XP premium!`;
        txt += `\n\nTotal koin: *${formatNum(newMoney)}*\n⚡ Energi sisa: *${cukupEnergi.energi}*\nAdventure lagi dalam *2 jam*`;
        await reply(txt);
      } else {
        // Kalah — HP turun drastis, tidak dapat reward, gear lebih aus
        const newHp = Math.max(5, Math.floor(playerHp * 0.2));
        kurangiDur(data, 'weapon', 5);
        kurangiDur(data, 'armor',  5);
        await updateMember(botId, sender, {
          healt:          newHp,
          hewan_json:     JSON.stringify(data),
          last_adventure: now2,
        });
        await reply(
          `⚔️ *ADVENTURE — KALAH!*\n\n` +
          `${monster.emoji} Musuh: *${monster.nama}*\n` +
          `🗡️ Sword: Lv.${sword} | 🛡️ Armor: Lv.${armor}\n\n` +
          log.join('\n') + (log.length ? '\n...\n' : '') +
          `\n💀 Kamu tidak mampu mengalahkan *${monster.nama}*!\n\n` +
          `❤️ Health tersisa: *${newHp}* (kamu melarikan diri)` +
          barisDur(data, 'weapon', '🗡️', 'Sword') +
          barisDur(data, 'armor',  '🛡️', 'Armor') +
          `\n\n_Upgrade sword & armor di ${p}store, atau naikkan level dulu!_\n` +
          `Adventure lagi dalam *2 jam*`
        );
      }
      return true;
    }

    // ── koboy ─────────────────────────────────────────────────────────────────
    case 'koboy': {
      const botId  = botData.id;
      const member = await getOrCreateMember(botId, sender, pushName);

      const KOBOY_COOLDOWN = 3 * 3600 * 1000; // 3 jam
      const sisaCd = cdRemain(member.last_koboy, KOBOY_COOLDOWN);
      const now    = Date.now();

      if (sisaCd > 0) {
        const jam = Math.floor(sisaCd / 3600000);
        const mnt = Math.floor((sisaCd % 3600000) / 60000);
        await reply(`🤠 Kamu masih dalam perjalanan!\n\nKoboy kembali dalam *${jam}j ${mnt}m*`);
        return true;
      }

      // Cek apakah sudah ada game koboy aktif dari sender ini
      const PENJAHAT = [
        { nama: 'Billy the Bandit',   sisi: null, reward: 800000,  emoji: '🔫' },
        { nama: 'El Diablo',          sisi: null, reward: 1000000, emoji: '😈' },
        { nama: 'Black Jake',         sisi: null, reward: 1200000, emoji: '🖤' },
        { nama: 'The Outlaw',         sisi: null, reward: 950000,  emoji: '🤠' },
        { nama: 'Rattlesnake Rex',    sisi: null, reward: 1100000, emoji: '🐍' },
      ];
      const penjahat = PENJAHAT[Math.floor(Math.random() * PENJAHAT.length)];
      // Penjahat sembunyi di kiri atau kanan (acak)
      penjahat.sisi = Math.random() < 0.5 ? 'kiri' : 'kanan';

      // Simpan ke store sementara
      koboyStore.set(sender, {
        penjahat,
        botId,
        expires: Date.now() + 60000, // 60 detik untuk jawab
      });

      await reply(
        `🤠 *KOBOY — TANGKAP PENJAHAT!*\n\n` +
        `${penjahat.emoji} *${penjahat.nama}* terlihat bersembunyi!\n\n` +
        `👀 Dia ada di mana...?\n\n` +
        `Ketik *kiri* atau *kanan* untuk menembak!\n` +
        `⏳ Kamu punya waktu *60 detik*\n\n` +
        `🏆 Reward: *${formatNum(penjahat.reward)} koin*`
      );
      return true;
    }

    // ── airdrop ───────────────────────────────────────────────────────────────
    case 'airdrop': {
      const botId  = botData.id;
      const member = await getOrCreateMember(botId, sender, pushName);

      const AIRDROP_COOLDOWN = 2 * 3600 * 1000; // 2 jam
      const sisaCd = cdRemain(member.last_airdrop, AIRDROP_COOLDOWN);
      const now    = Date.now();

      if (sisaCd > 0) {
        const jam = Math.floor(sisaCd / 3600000);
        const mnt = Math.floor((sisaCd % 3600000) / 60000);
        await reply(`📦 Airdrop belum tersedia!\n\nCoba lagi dalam *${jam}j ${mnt}m*`);
        return true;
      }

      // Simpan angka rahasia ke store
      const angkaRahasia = Math.floor(Math.random() * 10) + 1; // 1–10
      airdropStore.set(sender, {
        angka:   angkaRahasia,
        botId,
        expires: Date.now() + 60000, // 60 detik
      });

      await reply(
        `📦 *AIRDROP TURUN!*\n\n` +
        `Sebuah kargo misterius jatuh dari langit!\n\n` +
        `🎯 Tebak angka *1–10* untuk membukanya!\n` +
        `⏳ Waktumu *60 detik*\n\n` +
        `Ketik saja angkanya langsung (contoh: *7*)`
      );
      return true;
    }

    // ── maling ────────────────────────────────────────────────────────────────
    case 'maling': {
      const botId  = botData.id;
      const member = await getOrCreateMember(botId, sender, pushName);

      const MALING_COOLDOWN = 7 * 86400 * 1000; // 7 hari
      const sisaCd = cdRemain(member.last_maling, MALING_COOLDOWN);
      const now    = Date.now();

      if (sisaCd > 0) {
        const hari = Math.floor(sisaCd / 86400000);
        const jam  = Math.floor((sisaCd % 86400000) / 3600000);
        await reply(`🥷 Kamu masih dalam daftar pencarian!\n\nAman keluar lagi dalam *${hari}h ${jam}j*`);
        return true;
      }

      // 60% berhasil, 40% ketangkep
      const berhasil  = Math.random() < 0.60;
      const now2      = Date.now();

      if (berhasil) {
        const LOKASI = [
          { nama: 'Toko Kelontong',  min: 50,  max: 200  },
          { nama: 'Pasar Malam',     min: 80,  max: 300  },
          { nama: 'Rumah Kosong',    min: 100, max: 400  },
          { nama: 'Gudang Tua',      min: 150, max: 500  },
          { nama: 'Brankas Karatan', min: 200, max: 600  },
        ];
        const lokasi   = LOKASI[Math.floor(Math.random() * LOKASI.length)];
        const koinGet  = Math.floor(Math.random() * (lokasi.max - lokasi.min + 1)) + lokasi.min;
        const newMoney = (Number(member.money) || 0) + koinGet;

        await updateMember(botId, sender, {
          money:       newMoney,
          last_maling: now2,
        });

        await reply(
          `🥷 *MALING — BERHASIL!*\n\n` +
          `🏠 Lokasi: *${lokasi.nama}*\n\n` +
          `💰 Curi: *+${formatNum(koinGet)} koin*\n\n` +
          `Selamat! Tapi hati-hati, polisi bisa datang kapan saja...\n` +
          `Total koin: *${formatNum(newMoney)}*\n\n` +
          `_Cooldown 7 hari — biarkan suasana mereda_`
        );
      } else {
        // Ketangkep — denda 10% koin
        const denda    = Math.floor((Number(member.money) || 0) * 0.10);
        const newMoney = Math.max(0, (Number(member.money) || 0) - denda);

        await updateMember(botId, sender, {
          money:       newMoney,
          last_maling: now2,
        });

        await reply(
          `🥷 *MALING — KETANGKEP!*\n\n` +
          `🚔 Polisi berhasil menangkapmu!\n\n` +
          `💸 Denda: *-${formatNum(denda)} koin* (10%)\n\n` +
          `Kamu dibebaskan setelah bayar denda...\n` +
          `Total koin: *${formatNum(newMoney)}*\n\n` +
          `_Cooldown 7 hari — jangan coba-coba lagi dulu!_`
        );
      }
      return true;
    }

    default:
      return false;
  }
};

// Rank dari level — satu sumber kebenaran (dipakai juga 05-owner .cekprofil)
module.exports.getRankByLevel = getRankByLevel;

// Helper murni buat unit test (test/rpg-energi.js). Jangan dipakai dari plugin lain.
module.exports._uji = {
  energiSekarang, pesanEnergiKurang, barEnergi, biayaRepair, statGear, barisDur,
  gearDipakai, gearLevel, gearDur, gearAktif, pasangGear, kurangiDur, bacaAtm,
  bacaJson, bacaItem, KEY_ITEM, KEY_GEAR,
  ENERGI_MAKS, ENERGI_REGEN_MENIT, DUR_MAKS, STORE_ITEMS,
};

// Command yang kena limit untuk user biasa
module.exports.limitedCmds = new Set([
  'jodoh','tembak','terima','tolak','confess','kapan',
  'mulaigiveaway','ikut','rollgiveaway','cekgiveaway','cekmenang','hapusgiveaway',
  'profil','rpg','daily','claim','store','beli','inventory','pakai','topkoin',
  'suitpvp','suit','berburu','hunt','bertarung','fight',
  'lamarkerja','job','gajian','dungeon',
  'leaderboard','lb','bank','atm','mancing',
  'kerja','transfer','tf','coinflip','cf','tictactoe','ttt',
  'gacha','slot','hourly','weekly','dailymisi',
  'adventure','koboy','airdrop','maling','repair',
]);
