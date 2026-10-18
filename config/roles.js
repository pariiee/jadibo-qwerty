'use strict';

/**
 * config/roles.js — satu sumber nama role panel.
 *
 * `kawula` = Super Admin (tertinggi, full access).
 * `kontul` = Sub-admin (terbatas, pantau user & bot).
 */
const ADMIN_ROLE = 'kawula';
const SUBADMIN_ROLE = 'kontul';

module.exports = { ADMIN_ROLE, SUBADMIN_ROLE };
