'use strict';

/**
 * config/limitCost.js
 * Biaya limit per command. Tidak ada di sini = gratis (0).
 * Owner dan premium skip semua limit.
 */

const LIMIT_COST = {
  // ── Tools (berat) ────────────────────────────────────────────────────────
  sticker:      5,
  s:            5,
  wm:           5,
  tourl:        3,
  upload:       5,
  pay:          2,
  rvo:          2,
  readviewonce: 2,
  readvo:       2,
  liat:         2,

  // ── Fun & Social ─────────────────────────────────────────────────────────
  jodoh:        1,
  tembak:       1,
  terima:       1,
  tolak:        1,
  confess:      1,
  kapan:        1,
  suit:         2,
  suitpvp:      2,
  getpp:        2,

  // ── RPG ringan ───────────────────────────────────────────────────────────
  profil:       0,
  rpg:          0,
  store:        0,
  inventory:    0,
  job:          0,
  leaderboard:  0,
  lb:           0,
  bank:         0,
  atm:          0,
  topkoin:      0,

  // ── RPG sedang ───────────────────────────────────────────────────────────
  daily:        0,  // sudah ada cooldown sendiri
  hourly:       0,
  weekly:       0,
  dailymisi:    0,
  kerja:        2,
  gajian:       0,
  mancing:      2,
  coinflip:     1,
  cf:           1,
  tictactoe:    1,
  ttt:          1,
  gacha:        3,
  slot:         3,
  transfer:     1,
  tf:           1,
  beli:         1,
  pakai:        1,

  // ── RPG berat ────────────────────────────────────────────────────────────
  berburu:      3,
  hunt:         3,
  bertarung:    3,
  fight:        3,
  dungeon:      5,
  adventure:    3,
  koboy:        3,
  airdrop:      2,
  maling:       3,
  lamarkerja:   1,

  // ── Grup (admin) ─────────────────────────────────────────────────────────
  tagall:       2,
  tagadmin:     1,
  tagme:        1,
  hidetag:      1,
  ht:           1,
  totag:        2,
};

/**
 * Ambil biaya limit sebuah command.
 * @param {string} cmd - nama command tanpa prefix
 * @returns {number} biaya limit (0 = gratis)
 */
function getLimitCost(cmd) {
  return LIMIT_COST[cmd] ?? 0;
}

module.exports = { LIMIT_COST, getLimitCost };
