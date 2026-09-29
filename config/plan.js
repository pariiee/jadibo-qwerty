'use strict';

/**
 * config/plan.js — aturan role & paket (murni, tanpa DB).
 *
 * Role internal: `user` | `premium` | `kawula`
 *   - `kawula` = admin tertinggi. Namanya sengaja tidak umum (bukan admin/root/
 *     superadmin) supaya menebak role dari luar tidak ada gunanya.
 *   - `premium` bukan kolom terpisah: dia turunan dari langganan yang masih
 *     berlaku. Langganan lewat = otomatis balik `user`, tanpa cron pembersih.
 *
 * Akun gratis TIDAK dapat slot bot. Slot cuma datang dari Trial atau paket
 * berbayar — karena itu `slotsOf` mengembalikan 0 kalau langganan tidak aktif.
 *
 * Yang membedakan paket BUKAN jumlah slot: semua paket berbayar dapat 1 slot
 * bot. Yang dijual adalah MASA AKTIF (`days`) dan KUOTA PESAN per bot
 * (`daily_limit`). Bayar lebih mahal = bot hidup lebih lama, kuota lebih besar.
 *
 * Harga & benefit tiap paket tinggal di pricingStore (bisa diubah admin).
 */

const ADMIN_ROLE = 'kawula';

// Trial sekali per akun. Bukan paket berbayar — cuma `plan_expired_at` yang
// digeser ke depan, lalu tidak bisa diulang (lihat `trial_used_at`).
// Trial juga dapat jatah fitur — kalau cuma perintah inti, orang nggak akan
// tahu botnya bisa apa dan nggak ada alasan lanjut bayar.
const TRIAL = {
  id: 'trial', name: 'Trial', days: 5, slots: 1, daily_limit: 20, once: true,
  max_fitur: 100, owner_max: 1, receive_limit: 5000,
};

// `user` = paket Gratis: 0 slot, tidak bisa bikin bot. `days: 0` karena masa
// aktifnya memang tidak ada — bukan 30 hari gratis.
const DEFAULT_PLANS = [
  { id: 'user',    name: 'Gratis',  price: 0,     slots: 0, days: 0,   daily_limit: 10,  max_fitur: 0,   owner_max: 0,      receive_limit: 0 },
  { id: 'basic',   name: 'Basic',   price: 25000, slots: 1, days: 30,  daily_limit: 30,  max_fitur: 100, owner_max: 1,      receive_limit: 10000 },
  { id: 'premium', name: 'Premium', price: 50000, slots: 1, days: 30,  daily_limit: 50,  max_fitur: 250, owner_max: 3,      receive_limit: 50000 },
  { id: 'ultra',   name: 'Ultra',   price: 85000, slots: 1, days: 30,  daily_limit: 100, max_fitur: 400, owner_max: 5,      receive_limit: 100000 },
];

// Fitur dikelompokkan per kategori (plugins/01-info.js → CATS). Paket membuka
// kategori dari awal sampai `max_fitur` terkumpul. Potongannya dihitung saat
// dipakai, bukan disimpan di sini, supaya nambah/ubah command tidak perlu
// nyentuh angka di file ini. `kawula` dapat semua.
// Urutan kategori dari yang paling murah ke paling mahal — paket kecil dapat
// potongan dari depan. WAJIB memuat semua key CATS; kalau ada yang ketinggalan,
// fiturnya tidak pernah masuk paket mana pun.
const KATEGORI_URUT = ['info', 'grup', 'satset', 'random', 'game', 'tools', 'maker', 'downloader', 'rpg', 'owner'];

// Perintah inti yang TIDAK dijual — selalu terbuka, termasuk akun gratis dan
// langganan habis, supaya user tahu botnya kenapa. Nama harus persis sama
// dengan command di CATS.
const SELALU_TERBUKA = new Set(['menu', 'ping', 'limit', 'me', 'owner']);

// Dipakai kalau paket dari tabel `settings` tidak ketemu (mis. id paket lama).
const SLOT_DEFAULT = { user: 0, basic: 1, premium: 1, ultra: 1, trial: 1 };
const LIMIT_DEFAULT = 20;

/** Langganan user masih berlaku? */
const aktif = (u) => !!u?.plan_expired_at && new Date(u.plan_expired_at) > new Date();

/** Cari paket berdasarkan id, termasuk Trial. `plans` dari pricingStore. */
function paketOf(planId, plans) {
  return [...(plans || DEFAULT_PLANS), TRIAL].find((p) => p.id === planId) || null;
}

/**
 * Slot maksimum user. Admin tanpa batas; langganan lewat/habis = 0.
 * Paket datang dari pricingStore (tabel `settings`) — di-pass sebagai argumen
 * supaya file ini tetap tanpa DB dan tidak ada lingkaran require.
 */
function slotsOf(user, plans) {
  if (!user) return 0;
  if (user.role === ADMIN_ROLE) return 999;
  // Langganan habis = 0 slot, titik. Dicek DULU sebelum `plan_slots`, karena
  // sisa nilai trial/paket lama masih nempel di kolom itu — kalau urutannya
  // kebalik, slot gratis jalan terus walau masa aktifnya sudah lewat.
  if (!aktif(user)) return 0;
  // `plan_slots` = jatah khusus yang diisi admin, menang atas jatah paket.
  if (user.plan_slots != null) return Number(user.plan_slots);
  const p = paketOf(user.plan, plans);
  return p ? p.slots : (SLOT_DEFAULT[user.plan] ?? 0);
}

/**
 * Kuota pesan bot = kuota paket PEMILIK, dan `bots.daily_limit` cuma bisa
 * menurunkannya, tidak menaikkan. Kalau kolom bot menang, kuota paket bisa
 * dilewati sendiri oleh pemilik — benefit yang dijual jadi tidak ada artinya.
 */
function kuotaBot(pemilik, bot, plans) {
  if (pemilik && pemilik.role === ADMIN_ROLE) return 99999;
  if (!pemilik || !aktif(pemilik)) return 0;
  const p = paketOf(pemilik.plan, plans);
  const langit = p?.daily_limit || LIMIT_DEFAULT;
  const sendiri = Number(bot?.daily_limit);
  return sendiri > 0 ? Math.min(sendiri, langit) : langit;
}

/** Fitur (command) yang boleh dipakai bot ini, urut sesuai KATEGORI_URUT. */
function fiturBot(pemilik, plans) {
  if (pemilik && pemilik.role === ADMIN_ROLE) return null; // null = semua
  const cats = require('../plugins/01-info').CATS; // lazy: 01-info butuh ctx runtime
  // Perintah inti (menu, kelola bot sendiri, status) TIDAK dijual — selalu
  // terbuka, termasuk akun gratis dan langganan habis. Kalau ikut dikunci, user
  // yang masa aktifnya lewat cuma dapat bot bisu tanpa tahu sebabnya.
  const out = [...SELALU_TERBUKA];
  if (!pemilik || !aktif(pemilik)) return out;
  const jatah = Number(paketOf(pemilik.plan, plans)?.max_fitur) || 0;
  for (const k of KATEGORI_URUT) {
    for (const c of cats[k] || []) {
      if (out.includes(c)) continue;
      if (out.length >= jatah) return out;
      out.push(c);
    }
  }
  return out;
}

/** Batas jumlah nomor owner (owner number) yang boleh dipakai user. */
function ownerMax(pemilik, plans) {
  if (pemilik && pemilik.role === ADMIN_ROLE) return 999;
  if (!pemilik || !aktif(pemilik)) return 0;
  return Number(paketOf(pemilik.plan, plans)?.owner_max) || 0;
}

/** Batas TOTAL pesan yang boleh diterima bot (received limit, seumur paket). */
function receiveLimit(pemilik, plans) {
  // 0 = tidak dibatasi (engine cek `receive_limit > 0`). Admin juga 0, bukan
  // Infinity — nilainya disimpan ke kolom INT, dan Infinity bikin INSERT gagal.
  if (pemilik && pemilik.role === ADMIN_ROLE) return 0;
  if (!pemilik || !aktif(pemilik)) return 0;
  return Number(paketOf(pemilik.plan, plans)?.receive_limit) || 0;
}

/** Role efektif: admin menang, lalu cek langganan aktif. */
function roleOf(user) {
  if (!user) return 'user';
  if (user.role === ADMIN_ROLE) return ADMIN_ROLE;
  return aktif(user) && user.plan && user.plan !== 'user' ? 'premium' : 'user';
}

module.exports = {
  ADMIN_ROLE, TRIAL, DEFAULT_PLANS, SLOT_DEFAULT, LIMIT_DEFAULT, KATEGORI_URUT,
  aktif, roleOf, slotsOf, paketOf, kuotaBot, fiturBot, ownerMax, receiveLimit,
};
