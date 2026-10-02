'use strict';

/**
 * engine/notify.js — kabar ke owner bot lewat WhatsApp.
 *
 * Dipakai billingController setelah pembayaran masuk: user bayar, paket aktif,
 * tapi sebelumnya TIDAK ADA kabar apa pun — baik ke user maupun ke pemilik.
 * Kalau webhook telat, satu-satunya cara tahu cuma muter-muter di /billing.
 *
 * Yang dikirim cuma pesan teks lewat bot yang SEDANG online milik user itu.
 * Nggak ada tabel baru, nggak ada antrean: kalau nggak ada bot online, fungsi
 * ini balikin false dan pemanggilnya jalan terus. Notifikasi itu bonus —
 * JANGAN sampai bikin pembayaran gagal.
 */

const { pool } = require('../config/database');

/**
 * Kirim teks ke nomor owner milik `userId`, lewat bot-nya sendiri yang online.
 * @returns {Promise<boolean>} true kalau ada satu pesan yang benar-benar terkirim
 */
async function kirimKeOwner(userId, teks) {
  if (!userId || !teks) return false;

  // owner_number boleh berisi beberapa nomor dipisah koma — ambil yang pertama.
  const [rows] = await pool.execute(
    `SELECT id, owner_number FROM bots
      WHERE user_id = ? AND owner_number IS NOT NULL AND owner_number <> ''
      ORDER BY id`,
    [userId]
  );

  for (const b of rows) {
    const nomor = String(b.owner_number).split(',')[0].replace(/\D/g, '');
    if (!nomor) continue;
    if (await kirimLewatBot(b.id, nomor, teks)) return true;
  }

  // JALUR KEDUA — nomor HP user sendiri. Nomor bot bisa sedang putus tepat
  // waktu user bayar, dan itu justru momen dia paling butuh kabar.
  //
  // Tetap lewat bot MILIK USER, cuma sasarannya nomor HP-nya. Sengaja TIDAK
  // memakai bot online milik orang lain: penerimanya bakal dapat pesan dari
  // nomor yang nggak dia kenal, dan itu kelihatan seperti spam.
  const hp = await nomorHpUser(userId);
  if (hp) {
    for (const b of rows) {
      if (await kirimLewatBot(b.id, hp, teks)) return true;
    }
  }
  return false;
}

/** Kirim satu pesan lewat bot tertentu. false = bot itu tidak bisa dipakai. */
async function kirimLewatBot(botId, nomor, teks) {
  // engine/runtime.js pemilik aslinya; botController cuma re-export Map yang
  // sama, tapi arah impornya jadi engine -> controller kalau lewat sana.
  const { activeBots } = require('./runtime');
  const client = activeBots.get(botId) || activeBots.get(String(botId));
  if (!client) {
    // JANGAN senyap. Notifikasi yang gagal tanpa jejak itu cara paling mahal
    // kehilangan pelanggan: user bayar, tidak dapat kabar, dan tidak ada satu
    // baris pun di log yang bisa dipakai buat menelusuri kenapa.
    console.warn(`[Notif] bot ${botId} tidak ada di activeBots (isi: [${[...activeBots.keys()].join(',')}]) — notif ke ${nomor} TIDAK terkirim`);
    return false;
  }
  if (typeof client?.message?.send !== 'function') {
    console.warn(`[Notif] bot ${botId} tidak punya client.message.send — notif ke ${nomor} TIDAK terkirim`);
    return false;
  }
  try {
    // `{ type: 'text' }` WAJIB, bukan `{ text }`.
    //
    // `activeBots` menyimpan client MENTAH zapo (`whatsappEngine.js` baris ~322
    // `activeBots.set(botId, client)`), sedangkan plugin menerima ADAPTER
    // (`engine/zapo/client.js`) yang menerjemahkan bahasa Baileys -> zapo.
    // Client mentah menolak `{ text }`: encoder zapo hanya menganggap pesan teks
    // kalau `content.type === 'text'` (`isSendTextMessage`), dan kalau tidak
    // cocok sama sekali dia jatuh ke `default:` yang melempar
    // "unsupported media message type: undefined".
    //
    // Dicek langsung di mesin dev:
    //   isSendTextMessage({ text:'hai' })              -> false
    //   isSendTextMessage({ type:'text', text:'hai' }) -> true
    //
    // Ini yang bikin notif pembayaran tidak pernah sampai padahal log bilang
    // "terkirim": `send()` resolve dengan WAMessage-like SEBELUM stanza-nya
    // benar-benar dikirim, jadi sukses palsu.
    await client.message.send(nomor + '@s.whatsapp.net', { type: 'text', text: teks });
    console.log(`[Notif] terkirim lewat bot ${botId} ke ${nomor}`);
    return true;
  } catch (e) {
    // Socket mati / nomor tidak valid — coba bot berikutnya, tapi tinggalkan jejak.
    console.warn(`[Notif] gagal kirim lewat bot ${botId} ke ${nomor}: ${e.message}`);
    return false;
  }
}

/** Nomor HP user (buat jalur kedua). '' kalau belum diisi. */
async function nomorHpUser(userId) {
  try {
    const [r] = await pool.execute('SELECT phone FROM users WHERE id = ? LIMIT 1', [userId]);
    return String(r[0]?.phone || '').replace(/\D/g, '');
  } catch {
    return ''; // kolomnya belum ada (DB lama) — notif WA tetap jalan
  }
}

// Kirim ke nomor TERTENTU lewat bot mana pun yang online — TIDAK butuh DB.
// Dipakai alarm kesehatan: kalau yang rusak justru databasenya, jalur yang
// butuh `SELECT` dari DB tidak akan bisa dipakai buat melaporkan kerusakannya.
async function kirimKeNomor(nomor, teks) {
  const bersih = String(nomor || '').replace(/\D/g, '');
  if (!bersih || !teks) return false;
  const { activeBots } = require('./runtime');
  for (const botId of activeBots.keys()) {
    if (await kirimLewatBot(botId, bersih, teks)) return true;
  }
  console.warn(`[Notif] tidak ada bot online — pesan ke ${bersih} TIDAK terkirim`);
  return false;
}

module.exports = { kirimKeOwner, kirimKeNomor, nomorHpUser };
