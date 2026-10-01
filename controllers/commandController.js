'use strict';

/**
 * controllers/commandController.js — daftar command bot untuk halaman /command.
 *
 * Sumbernya LANGSUNG dari registry bot (`plugins/01-info`), bukan tabel baru:
 * ALL_COMMANDS = yang beneran ada `case`-nya, CATS = pengelompokannya. Jadi
 * begitu ada command baru di plugin, halaman ini ikut tanpa diedit.
 *
 * Plugin itu nggak dipanggil jalan (nggak ada efek samping waktu di-require —
 * lihat `test/boot-kering.js`), jadi aman dibaca dari proses web.
 *
 * Kunci per-user (toggle / limit / owner-only / group-only) BELUM ada di DB.
 * Endpoint ini SENGAJA cuma baca: nol tabel, nol state palsu. Kalau nanti
 * memang dijual sebagai fitur, baru bikin tabel `bot_commands` + PATCH di sini.
 */

const info = require('../plugins/01-info');
const { buildLimitedCmds } = require('../engine/limitedCmds');

const SEMUA = info.ALL_COMMANDS;
const KATEGORI = info.CATS;
const PAKSA_TERBUKA = new Set(['menu', 'ping', 'limit', 'me', 'owner']); // = SELALU_TERBUKA di config/plan.js

// Satu command bisa muncul di >1 kategori; yang dipakai = kategori pertama
// menurut urutan menu, sama seperti `.menu` di bot.
const PETA_KATEGORI = new Map();
for (const k of info.CAT_KEYS) {
  for (const c of KATEGORI[k] || []) if (!PETA_KATEGORI.has(c)) PETA_KATEGORI.set(c, k);
}

const daftarKategori = () =>
  info.CAT_KEYS.filter((k) => (KATEGORI[k] || []).some((c) => SEMUA.includes(c)))
    .map((k) => ({ kunci: k, label: info.catLabel(k), jumlah: (KATEGORI[k] || []).filter((c) => SEMUA.includes(c)).length }));

/**
 * GET /api/command
 * Selalu balikin SEMUA command (semua kategori) — 440 baris itu ~30 KB, jadi
 * nyaring di browser. Satu response = nol request tambahan waktu ganti filter.
 */
function daftarCommand(req, res) {
  try {
    const pakaiLimit = buildLimitedCmds();
    const hanyaLimit = req.query.limit === '1';
    const kategori = req.query.kategori || '';

    let daftar = SEMUA
      .filter((c) => !hanyaLimit || pakaiLimit.has(c))
      .map((c) => {
        const k = PETA_KATEGORI.get(c) || 'lain';
        return {
          nama: c,
          kategori: k,
          label: k === 'lain' ? 'LAIN' : info.catLabel(k),
          prefix: '.' + c,
          limit: pakaiLimit.has(c),
          bebas: PAKSA_TERBUKA.has(c),
        };
      });
    if (kategori) daftar = daftar.filter((c) => c.kategori === kategori);

    res.json({
      ok: true,
      total: SEMUA.length,
      totalLimit: SEMUA.filter((c) => pakaiLimit.has(c)).length,
      kategori: daftarKategori(),
      commands: daftar,
    });
  } catch (e) {
    console.error('[Command]', e.message);
    res.status(500).json({ ok: false, error: 'Gagal membaca daftar command' });
  }
}

module.exports = { daftarCommand };
