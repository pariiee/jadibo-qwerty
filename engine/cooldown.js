'use strict';

/**
 * engine/cooldown.js — middleware cooldown terpusat untuk dispatcher.
 *
 * Dipanggil dari `whatsappEngine.js` & `telegramEngine.js` SEBELUM
 * `await handler(ctx)`. BUKAN plugin — bukan handler pesan, hanya
 * penghalang.
 *
 * Cara kerja:
 *   1. Cek `ctx.command` (di-lower-case oleh dispatcher).
 *   2. Cari kelompok di `config/cooldown.js`.
 *   3. Owner & dev dikecualikan HANYA di kelompok yang mendefinisikan
 *      `pengecualian` di config/cooldown.js — saat ini cuma 'umum'.
 *      Kelompok 'berat', 'upload', 'judi', 'admin-grup', dan
 *      'owner-destructive' TETAP kena untuk owner & dev (opsi A).
 *   4. Map<key, ts> = lastHit. Key = `${senderJid}:${namaKelompok}`.
 *   5. Kalau `now - ts < ms`:
 *        - kelompok 'umum' (balasan:false) → diam, return {ok:false, diam:true}
 *        - kelompok dengan balasan:true → balas "⏳ Tunggu X detik" SEKALI
 *          per jendela cooldown. Map `lastBalas` menyimpan ts balasan
 *          terakhir; kalau balasan < ms/2 lalu, diam saja.
 *   6. Kalau lewat → update ts, jalankan handler.
 *   7. setInterval tiap 1 jam: hapus entry yang sudah melewati cooldown
 *      terpanjang (jadi tidak ada leak). .unref() supaya tidak menahan
 *      proses.
 *
 * Memori: pada dasarnya 1 baris per (user, kelompok). 100 user × 6 kelompok
 * = 600 entry × 16 byte = 10 KB. Trivial. Cleanup cuma untuk user yang
 * tidak aktif berminggu-minggu.
 *
 * @returns {Promise<{ok:boolean, dilanggar?:string, sisa?:number}>}
 *   ok:false + dilanggar ada → handler JANGAN dipanggil.
 *   ok:true → handler boleh dipanggil.
 */
const { TABEL, kelompokUntuk, cfgDefault } = require('../config/cooldown');

// lastHit  = terakhir kali command LULUS (timestamp ms).
// lastBalas = terakhir kali kita KIRIM balasan "tunggu X detik" (untuk
//              throttle "balas sekali per jendela").
const lastHit  = new Map();
const lastBalas = new Map();

const KELOMPOK_TERPANJANG_MS = Math.max(...Object.values(TABEL).map(c => c.ms));

/**
 * Cek apakah command ini boleh jalan untuk sender ini.
 * Kalau tidak boleh, plugin handler JANGAN dipanggil.
 */
async function cooldownGuard(ctx) {
  if (!ctx?.isCmd) return { ok: true };
  const cmd = String(ctx.command || '').toLowerCase();
  if (!cmd) return { ok: true };
  const sender = String(ctx.sender || '');
  if (!sender) return { ok: true };

  const cfg = kelompokUntuk(cmd) || cfgDefault(cmd);
  const { nama, ms, balasan, pengecualian } = cfg;

  // Opsi A: owner & dev TETAP kena cooldown di kelompok mana pun yang TIDAK
  // mendefinisikan `pengecualian` (semua kecuali 'umum'). Perilaku dibaca dari
  // tabel config, bukan di-hardcode di sini — supaya satu tempat saja yang
  // menentukan siapa yang dibebaskan.
  if (pengecualian) {
    if (pengecualian.isOwner && ctx.isOwner) return { ok: true };
    if (pengecualian.isDev   && ctx.isDev)   return { ok: true };
  }

  const key = `${sender}:${nama}`;
  const now = Date.now();
  const last = lastHit.get(key) || 0;

  if (now - last < ms) {
    const sisa = Math.ceil((ms - (now - last)) / 1000);

    if (!balasan) return { ok: false, dilanggar: nama, sisa, diam: true };

    // Balas SEKALI per jendela cooldown. Kalau barusan sudah bilang,
    // diam — supaya user spam tidak dapat 100 pesan "tunggu 3 detik".
    const lastB = lastBalas.get(key) || 0;
    if (now - lastB >= ms) {
      lastBalas.set(key, now);
      const detik = Math.ceil(ms / 1000);
      try {
        await ctx.reply(`⏳ Tunggu ${detik} detik sebelum mengulang command *${cmd}*.`);
      } catch { /* diam kalau reply gagal */ }
    }
    return { ok: false, dilanggar: nama, sisa, diam: false };
  }

  lastHit.set(key, now);
  // lastBalas tidak di-reset di sini: tujuannya adalah rate-limit BALASAN,
  // bukan rate-limit command. Kalau user sudah cooldown 5 menit, balasan
  // berikutnya juga di-throttle.
  return { ok: true };
}

/**
 * Tutup middleware setelah handler selesai — saat ini hanya place-
 * holder. Disini supaya gampang ditambah (mis. audit per user) tanpa
 * mengubah signature.
 */
async function cooldownAfter(ctx) { return { ok: true }; }

/**
 * Cleanup Map. Hapus entry yang sudah lewat `KELOMPOK_TERPANJANG_MS`.
 * Dipanggil periodik supaya user yang jarang chat tidak membebani memori.
 * # ponytail: full-scan O(n) tiap jam; untuk 10k+ user pindah ke LRU.
 */
function cleanup() {
  const ambang = Date.now() - KELOMPOK_TERPANJANG_MS;
  let dihapus = 0;
  for (const [k, ts] of lastHit)  if (ts < ambang) { lastHit.delete(k);    dihapus++; }
  for (const [k, ts] of lastBalas) if (ts < ambang) { lastBalas.delete(k); dihapus++; }
  return dihapus;
}

const TICKER = setInterval(cleanup, 60 * 60 * 1000);
if (TICKER.unref) TICKER.unref();

module.exports = { cooldownGuard, cooldownAfter, cleanup, lastHit, lastBalas, TABEL };
