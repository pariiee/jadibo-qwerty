'use strict';

/**
 * Panel zapo & panel Baileys berbagi tabel `bots` di DB MySQL yang sama.
 * ENGINE_BOT_ID = id baris `bots` milik panel ini. Kalau di-set, panel ini hanya
 * melihat/menyentuh baris itu — tanpa ini, start/stop dari panel zapo bisa
 * menjalankan bot Baileys pakai engine zapo (dua bot rebutan nomor yang sama).
 * Kosong = tanpa batas (dev/lokal).
 */
const ENGINE_BOT_ID = process.env.ENGINE_BOT_ID
  ? parseInt(process.env.ENGINE_BOT_ID, 10)
  : null;

/** Potongan SQL + param pembatas, buat disisipkan ke query `bots`. */
function mine(col = 'id', sep = 'AND') {
  return ENGINE_BOT_ID !== null ? [` ${sep} ${col} = ?`, [ENGINE_BOT_ID]] : ['', []];
}

/** true kalau botId termasuk wilayah panel ini. */
function isMine(botId) {
  return ENGINE_BOT_ID === null || Number(botId) === ENGINE_BOT_ID;
}

module.exports = { ENGINE_BOT_ID, mine, isMine };
