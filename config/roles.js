'use strict';

/**
 * config/roles.js — satu sumber nama role admin panel.
 *
 * `kawula` = admin tertinggi. Namanya sengaja tidak umum (bukan admin/root/
 * superadmin) supaya menebak role dari luar tidak ada gunanya. Ini role yang
 * sama dipakai panel Baileys — dua panel berbagi tabel `users`, jadi nama role
 * WAJIB sepakat. Jangan tulis string role langsung di file lain.
 */
const ADMIN_ROLE = 'kawula';

module.exports = { ADMIN_ROLE };
