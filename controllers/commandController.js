'use strict';

/**
 * controllers/commandController.js — daftar command bot untuk halaman /command.
 *
 * Sumbernya LANGSUNG dari registry bot (`plugins/01-info`), bukan tabel baru:
 * ALL_COMMANDS = yang beneran ada `case`-nya, CATS = pengelompokannya. Jadi
 * begitu ada command baru di plugin, halaman ini ikut tanpa diedit — yang perlu
 * ditambah manual cuma DESKRIPSI (config/commandInfo.js).
 *
 * Yang tampil = command PRIMER saja; alias nempel di command-nya (hasil parse
 * grup `case` di plugins/). Alias sengaja BUKAN baris sendiri biar nggak
 * kelihatan dobel — cuma `.youtube` yang tampil, `.yt`/`.ytdl` jadi aliasnya.
 *
 * Plugin itu nggak dipanggil jalan (nggak ada efek samping waktu di-require —
 * lihat `test/boot-kering.js`), jadi aman dibaca dari proses web.
 *
 * Kunci per-user (toggle / limit / owner-only / group-only) BELUM ada di DB.
 * Endpoint ini SENGAJA cuma baca: nol tabel, nol state palsu. Kalau nanti
 * memang dijual sebagai fitur, baru bikin tabel `bot_commands` + PATCH di sini.
 */

const info = require('../plugins/01-info');
const { DESKRIPSI, ALIAS } = require('../config/commandInfo');

const SEMUA = info.ALL_COMMANDS;
const KATEGORI = info.CATS;
const SEMUA_ALIAS = new Set(Object.values(ALIAS).flat());

// Satu command bisa muncul di >1 kategori; yang dipakai = kategori pertama
// menurut urutan menu, sama seperti `.menu` di bot.
const PETA_KATEGORI = new Map();
for (const k of info.CAT_KEYS) {
  for (const c of KATEGORI[k] || []) if (!PETA_KATEGORI.has(c)) PETA_KATEGORI.set(c, k);
}

const daftarKategori = () =>
  info.CAT_KEYS.filter((k) => (KATEGORI[k] || []).some((c) => SEMUA.includes(c) && !SEMUA_ALIAS.has(c)))
    .map((k) => ({
      kunci: k,
      label: info.catLabel(k),
      jumlah: (KATEGORI[k] || []).filter((c) => SEMUA.includes(c) && !SEMUA_ALIAS.has(c)).length,
    }));

/**
 * GET /api/command
 * Selalu balikin semua command (semua kategori) — 318 baris itu ~40 KB, jadi
 * nyaring di browser. Satu response = nol request tambahan waktu ganti filter.
 */
function daftarCommand(req, res) {
  try {
    const kategori = req.query.kategori || '';

    let daftar = SEMUA
      .filter((c) => !SEMUA_ALIAS.has(c))
      .map((c) => {
        const k = PETA_KATEGORI.get(c) || 'lain';
        return {
          nama: c,
          kategori: k,
          label: k === 'lain' ? 'LAIN' : info.catLabel(k),
          prefix: '.' + c,
          deskripsi: DESKRIPSI[c] || '',
          alias: ALIAS[c] || [],
        };
      });
    if (kategori) daftar = daftar.filter((c) => c.kategori === kategori);

    res.json({
      ok: true,
      total: daftar.length,      // yang beneran tampil (primer, sudah disaring)
      totalSemua: SEMUA.length,  // termasuk alias
      totalAlias: SEMUA_ALIAS.size,
      kategori: daftarKategori(),
      commands: daftar,
    });
  } catch (e) {
    console.error('[Command]', e.message);
    res.status(500).json({ ok: false, error: 'Gagal membaca daftar command' });
  }
}

module.exports = { daftarCommand };
