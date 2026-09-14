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

// ─── LID -> nomor telepon ─────────────────────────────────────────────────────

/** Sync: pakai cache saja. Tidak ketemu -> balikin jid apa adanya. */
function lidToPn(jid) {
  if (!isLid(jid)) return jid;
  return lidToPhoneCache.get(String(jid)) || jid;
}

/** Async: cache dulu, lalu contact store (session.db). */
async function lidToPnAsync(client, jid) {
  if (!isLid(jid)) return jid;
  const cached = lidToPn(jid);
  if (cached !== jid) return cached;
  try {
    const rec = await client?.stores?.contacts?.getByJid?.(String(jid));
    if (rec?.phoneNumber) {
      const pn = String(rec.phoneNumber);
      lidToPhoneCache.set(String(jid), pn);
      const phone = bare(pn);
      if (phone) phoneToLidCache.set(phone, String(jid));
      return pn;
    }
  } catch { /* store tidak ada -> biarkan LID */ }
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

/** Async: cache dulu, lalu contact store (kolom `lid`, fallback `jid` kalau LID). */
async function pnToLidAsync(client, jid) {
  if (!jid) return jid;
  const cached = pnToLid(jid);
  if (cached !== jid) return cached;
  try {
    const rec = await client?.stores?.contacts?.getByPhoneNumber?.(bare(jid));
    const lid = rec?.lid || (isLid(rec?.jid) ? rec.jid : null);
    if (lid) {
      phoneToLidCache.set(bare(jid), String(lid));
      lidToPhoneCache.set(String(lid), isPn(jid) ? String(jid) : toPn(jid));
      return String(lid);
    }
  } catch { /* store tidak ada -> biarkan apa adanya */ }
  return jid;
}

module.exports = {
  bare, isLid, isPn, toPn, toLid,
  cacheLidFromMeta,
  lidToPn, lidToPnAsync,
  pnToLid, pnToLidAsync,
};
