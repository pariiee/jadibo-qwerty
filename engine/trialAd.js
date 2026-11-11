'use strict';

/**
 * engine/trialAd.js — Broadcast iklan berkala lewat bot milik akun Trial.
 * Dikontrol penuh oleh Super Admin dari /kountole/harga.
 */

const { pool } = require('../config/database');
const pricingStore = require('../config/pricingStore');
const { activeBots, activeGroupsPerBot } = require('../controllers/botController');

async function broadcastIklanTrial() {
  const ad = pricingStore.all().trial_ad;
  if (!ad || !ad.aktif || !String(ad.pesan || '').trim()) return;

  const intervalHours = Math.max(1, parseInt(ad.interval_hours, 10) || 6);

  try {
    // Ambil semua bot online milik akun ber-plan 'trial' yang belum kirim iklan selama `intervalHours`
    const [bots] = await pool.execute(
      `SELECT b.id, b.bot_name, b.platform, b.main_groups
         FROM bots b
         JOIN users u ON u.id = b.user_id
        WHERE u.plan = 'trial'
          AND b.is_running = 1
          AND b.status = 'connected'
          AND (b.last_ad_sent_at IS NULL OR b.last_ad_sent_at <= DATE_SUB(NOW(), INTERVAL ? HOUR))`,
      [intervalHours]
    );

    if (!bots.length) return;

    for (const bot of bots) {
      if (bot.platform !== 'whatsapp') continue;
      const client = activeBots.get(bot.id);
      if (!client || !client.message) continue;

      const grpMap = activeGroupsPerBot.get(bot.id);
      let targetJids = [];
      if (grpMap && grpMap.size > 0) {
        targetJids = Array.from(grpMap.keys());
      } else if (bot.main_groups) {
        targetJids = String(bot.main_groups).split(',').map((s) => s.trim()).filter(Boolean);
      }

      if (!targetJids.length) continue;

      // Kirim maks 5 grup per interval dengan delay aman
      let sent = 0;
      for (const jid of targetJids.slice(0, 5)) {
        try {
          await client.message.send(jid, { type: 'text', text: ad.pesan });
          sent++;
          await new Promise((r) => setTimeout(r, 1500));
        } catch {
          // Abaikan grup yang keluar/dikeluarkan
        }
      }

      if (sent > 0) {
        await pool.execute('UPDATE bots SET last_ad_sent_at = NOW() WHERE id = ?', [bot.id]);
        console.log(`[TrialAd] Iklan terkirim ke ${sent} grup via Bot #${bot.id} (${bot.bot_name})`);
      }
    }
  } catch (err) {
    console.error('[TrialAd] Error broadcast:', err.message);
  }
}

module.exports = { broadcastIklanTrial };
