'use strict';

/**
 * engine/jid.js
 * Pusat urusan JID WhatsApp: LID <-> nomor telepon (PN), angka polos, cek tipe.
 *
 * Konvensi JID:
 *   LID = `...@lid`            -> id internal WhatsApp (bukan nomor)
 *   PN  = `...@s.whatsapp.net` -> nomor telepon asli
 *
 * Kenapa dipusatkan: satu user jangan muncul sebagai `...@lid` di satu log dan
 * `6287...` di log lain — kalau cuma sebagian command yang resolve, DB/state
 * jadi tidak sinkron. Semua plugin panggil dari sini.
 */

// Cache dua arah, diisi dari group metadata (murah) atau contact store (fallback).
const lidToPhoneCache = new Map(); // '123@lid'              -> '6281@s.whatsapp.net'
const phoneToLidCache = new Map(); // '6281@s.whatsapp.net'  -> '123@lid'

/** Ambil angka polosnya: '62812:5@s.whatsapp.net' -> '62812' */
const bare = (jid) => String(jid || '').split('@')[0].split(':')[0];

const isLid = (jid) => String(jid || '').endsWith('@lid');
const isPn  = (jid) => String(jid || '').endsWith('@s.whatsapp.net');

/** '62812-3456' -> '628123456@s.whatsapp.net' */
const toPn  = (num) => `${String(num || '').replace(/\D/g, '')}@s.whatsapp.net`;
/** '62812-3456' -> '628123456@lid' */
const toLid = (num) => `${String(num || '').replace(/\D/g, '')}@lid`;

/**
 * Isi cache dari participants group metadata.
 * Bentuk yang diterima: { jid: '...@lid', phoneNumber: '6281' }
 */
function cacheLidFromMeta(participants) {
  for (const p of (participants || [])) {
    const lid = p?.jid;
    const pn  = p?.phoneNumber || p?.phone_number;
    if (!lid || !String(lid).endsWith('@lid') || !pn) continue;
    const phone = String(pn).replace(/\D/g, '');
    if (!phone) continue;
    lidToPhoneCache.set(String(lid), `${phone}@s.whatsapp.net`);
    phoneToLidCache.set(phone, String(lid));
  }
}

/**
 * Isi cache dari key pesan masuk. INI SUMBER UTAMANYA, bukan metadata grup.
 * Baileys v7 naruh PN-nya langsung di key (`participantAlt` / `remoteJidAlt`) dan
 * nyimpen mapping-nya sendiri ke session.db sebelum emit `messages.upsert`
 * (lib/Socket/messages-recv.js ~1277). Jadi pesan PERTAMA setelah restart udah
 * kebaca — nggak nunggu metadata grup, nggak ada network call.
 */
function cacheLidFromKey(key) {
  if (!key) return;
  for (const [a, b] of [[key.participantAlt, key.participant], [key.remoteJidAlt, key.remoteJid]]) {
    if (!a || !b || isLid(a) === isLid(b)) continue;
    const lid = isLid(a) ? String(a) : String(b);
    const pn  = isLid(a) ? String(b) : String(a);
    if (!isPn(pn)) continue;
    const norm = toPn(bare(pn)); // buang suffix device (`628xx:0@...`)
    lidToPhoneCache.set(lid, norm);
    phoneToLidCache.set(bare(norm), lid);
  }
}

// ─── LID -> nomor telepon ─────────────────────────────────────────────────────

/** Sync: pakai cache saja. Tidak ketemu -> balikin jid apa adanya. */
function lidToPn(jid) {
  if (!isLid(jid)) return jid;
  return lidToPhoneCache.get(String(jid)) || jid;
}

/** Async: cache dulu, lalu peta LID<->PN punya Baileys sendiri (persist di session.db). */
async function lidToPnAsync(client, jid) {
  if (!isLid(jid)) return jid;
  const cached = lidToPn(jid);
  if (cached !== jid) return cached;
  try {
    const raw = await client?.lid?.getPn?.(String(jid));
    if (raw && isPn(raw)) {
      const pn = toPn(bare(raw)); // `628xx:0@s.whatsapp.net` -> `628xx@s.whatsapp.net`
      lidToPhoneCache.set(String(jid), pn);
      phoneToLidCache.set(bare(pn), String(jid));
      return pn;
    }
  } catch { /* nggak ada -> biarkan LID */ }
  return jid;
}

// ─── nomor telepon -> LID ─────────────────────────────────────────────────────

/** Sync: pakai cache saja. Tidak ketemu -> balikin jid apa adanya. */
function pnToLid(jid) {
  if (!jid) return jid;
  const key = isPn(jid) ? bare(jid) : String(jid).replace(/\D/g, '');
  if (!key) return jid;
  return phoneToLidCache.get(key) || jid;
}

/** Async: cache dulu, lalu peta LID<->PN punya Baileys sendiri (persist di session.db). */
async function pnToLidAsync(client, jid) {
  if (!jid) return jid;
  const cached = pnToLid(jid);
  if (cached !== jid) return cached;
  try {
    const lid = await client?.lid?.getLid?.(toPn(bare(jid)));
    if (lid && isLid(lid)) {
      phoneToLidCache.set(bare(jid), String(lid));
      lidToPhoneCache.set(String(lid), toPn(bare(jid)));
      return String(lid);
    }
  } catch { /* nggak ada -> biarkan apa adanya */ }
  return jid;
}

// ─── mentionedJid buat grup ───────────────────────────────────────────────────

/**
 * Di grup yang di-address pakai LID, peserta dikenali sebagai `...@lid` —
 * tag biru cuma nempel kalau `mentionedJid` ikut nyertain bentuk LID-nya.
 * Teksnya tetap `@<nomor>` (WA yang nampilin nomornya). Non-grup: apa adanya.
 */
function mentionsForChat(chatJid, list) {
  if (!Array.isArray(list) || !list.length) return list;
  if (!String(chatJid || '').endsWith('@g.us')) return list;
  const out = [...list];
  for (const jid of list) {
    const lid = pnToLid(jid);
    if (lid !== jid && !out.includes(lid)) out.push(lid);
  }
  return out;
}

/**
 * Ada JID bentuk LID yang belum ke-map ke nomor? Engine pakai ini buat mutusin
 * perlu baca metadata grup atau nggak. Peta normalnya udah keisi dari key pesan
 * (cacheLidFromKey), jadi metadata cuma jaring pengaman terakhir.
 */
function needsLidResolve({ sender, quotedSender, mentioned } = {}) {
  return [sender, quotedSender, ...(mentioned || [])].some((j) => isLid(j));
}

module.exports = {
  bare, isLid, isPn, toPn, toLid,
  needsLidResolve,
  cacheLidFromMeta, cacheLidFromKey,
  lidToPn, lidToPnAsync,
  pnToLid, pnToLidAsync,
  mentionsForChat,
};
