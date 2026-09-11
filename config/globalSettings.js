'use strict';

/**
 * config/globalSettings.js
 * Per-bot global settings (nyimak, autoread) — shared antara engine dan plugin.
 * File ini tidak depend pada module lain untuk menghindari circular dependency.
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

module.exports = { getBotGlobalSetting, setBotGlobalSetting };
