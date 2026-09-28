'use strict';

/**
 * config/globalSettings.js
 * Per-bot global settings (nyimak, autoread) + state bisu per grup (mute).
 * Shared antara engine dan plugin.
 * File ini tidak depend pada module lain untuk menghindari circular dependency.
 *
 * `mute` = bot berhenti ngebalas DI GRUP ITU (grup tetap normal, member tetap
 * bisa ngobrol). Bukan setting grup WhatsApp — setting grup itu urusan
 * `.close`/`.open` (`announce`). Dulu `.mute` salah nyentuh `announce`, jadi
 * yang diem malah membernya, bukan botnya.
 */

const fs   = require('fs');
const path = require('path');

const GLOBAL_FILE = path.join(__dirname, '..', 'data', 'bot-global-settings.json');

let _store = {};
try {
  if (fs.existsSync(GLOBAL_FILE)) _store = JSON.parse(fs.readFileSync(GLOBAL_FILE, 'utf8'));
} catch { /* fresh start */ }

function _save() {
  try {
    fs.mkdirSync(path.dirname(GLOBAL_FILE), { recursive: true });
    fs.writeFileSync(GLOBAL_FILE, JSON.stringify(_store, null, 2));
  } catch { /* skip */ }
}

function getBotGlobalSetting(botId, key) {
  return !!_store[`${botId}:${key}`];
}

function setBotGlobalSetting(botId, key, value) {
  _store[`${botId}:${key}`] = !!value;
  _save();
}

// Kunci grup ditulis apa adanya — nggak ada jalur yang manggil ini pakai JID
// mentah maupun nomor polos, jadi dua bentuk nggak bisa saling kelewat.
const _kunciGrup = (botId, jid) => `${botId}:mute:${jid}`;

/** Grup ini dibisukan buat bot? (dipakai engine + `.mute`/`.listmute`) */
const getMuteGrup = (botId, jid) => !!_store[_kunciGrup(botId, jid)];

function setMuteGrup(botId, jid, value) {
  const k = _kunciGrup(botId, jid);
  if (value) _store[k] = true; else delete _store[k];
  _save();
}

/** Semua grup yang lagi dibisukan buat bot ini (buat `.listmute`). */
function daftarMuteGrup(botId) {
  const awalan = `${botId}:mute:`;
  return Object.keys(_store)
    .filter((k) => k.startsWith(awalan))
    .map((k) => k.slice(awalan.length));
}

module.exports = {
  getBotGlobalSetting, setBotGlobalSetting,
  getMuteGrup, setMuteGrup, daftarMuteGrup,
};
