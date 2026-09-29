'use strict';

/**
 * config/pricingStore.js — harga & benefit paket + QRIS manual, bisa diubah admin.
 *
 * Satu tabel `settings(key, value)` (value = JSON) buat semuanya. Cache di memori;
 * `refresh()` sekali saat boot, `set()` saat admin menyimpan.
 */
const { pool } = require('./database');
const { DEFAULT_PLANS, TRIAL, ADMIN_ROLE } = require('./plan');

const DEFAULTS = {
  plans: DEFAULT_PLANS,
  trial_days: TRIAL.days,
  qris_static_url: '',   // opsi bayar MANUAL: gambar QRIS statis buat discan user
  pay_mode: 'both',      // manual | gateway | both
  gateway_enabled: true,
};

let _cache = null;

const all = () => _cache || DEFAULTS;

async function refresh() {
  try {
    const [rows] = await pool.execute('SELECT `key`, value FROM settings');
    const out = { ...DEFAULTS };
    for (const r of rows) {
      try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
    }
    _cache = out;
  } catch { /* tabel belum ada → pakai default */ }
  return all();
}

async function set(key, value) {
  await pool.execute(
    'INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
    [key, JSON.stringify(value)]
  );
  _cache = { ...all(), [key]: value };
  return all();
}

/** Daftar paket (dari DB kalau sudah diubah admin). */
const plans = () => all().plans || DEFAULT_PLANS;
const getPlan = (id) => plans().find((p) => p.id === id) || DEFAULT_PLANS[0];

module.exports = { all, refresh, set, plans, getPlan, DEFAULTS };
