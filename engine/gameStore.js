'use strict';

/**
 * engine/gameStore.js
 * Shared game session store — satu source of truth untuk semua game.
 * Mencegah 2 game aktif di satu grup/chat yang sama.
 *
 * key: jid
 * value: { game: 'asahotak'|'caklontong', ...sessionData }
 */

const store = new Map();

module.exports = {
  has:    (jid)         => store.has(jid),
  get:    (jid)         => store.get(jid),
  set:    (jid, data)   => store.set(jid, data),
  delete: (jid)         => store.delete(jid),
  // Cek apakah ada game aktif, return nama game atau null
  activeGame: (jid)     => store.has(jid) ? store.get(jid).game : null,
};
