'use strict';

/**
 * controllers/walletController.js — dompet: top up, perpanjang dari saldo,
 * auto-perpanjang.
 *
 * Ruang lingkupnya SENGAJA sempit: saldo cuma buat top up dan memperpanjang
 * paket. Tidak ada tarik saldo, tidak ada transfer antar user.
 *
 * ATURAN YANG MEMEGANG FILE INI:
 *   1. Setiap perubahan `users.saldo` WAJIB disertai satu baris `wallet_ledger`
 *      di transaksi yang SAMA. Kalau tidak, SUM(jumlah) != saldo dan riwayatnya
 *      berhenti bisa dipercaya.
 *   2. `ref` ledger menentukan idempotensi — lihat catatan di bawah.
 *   3. Saldo TIDAK PERNAH boleh minus. Dijaga `FOR UPDATE` + cek, bukan cuma
 *      karena kolomnya BIGINT SIGNED.
 *
 * ── STATUS SAAT INI ──────────────────────────────────────────────────────────
 * Kerangka. `terapkanTopup` sudah jadi karena `tandaiLunas` (billingController)
 * sudah menyerahkan order topup ke sini — gerbang itu dipasang lebih dulu
 * supaya tidak pernah ada commit yang menerima order topup tanpa penanganan.
 * Sisanya (`perpanjangDariSaldo`, `autoRenew`, admin) menyusul.
 */

const crypto = require('crypto');
const { pool } = require('../config/database');
const pricingStore = require('../config/pricingStore');
const topup = require('../config/topup');

const rupiah = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');

/** Bikin ref unik buat perpanjang manual. Bentuknya sama seperti di schema.sql. */
const refPerpanjang = (userId) => `perpanjang:${userId}:${Date.now()}`;

/**
 * Kredit saldo untuk satu order top up yang sudah dinyatakan lunas.
 *
 * DIPANGGIL DARI `billingController.tandaiLunas` (bukan memanggil balik ke
 * sana) — jadi webhook, tombol "Cek status", dan konfirmasi admin SEMUANYA
 * lewat satu fungsi ini. Tiga jalur, satu implementasi: itu yang bikin
 * "ketiganya bersamaan -> saldo bertambah sekali" benar secara struktur, bukan
 * secara kebetulan.
 *
 * IDEMPOTEN lewat dua lapis, dan urutannya penting:
 *   1. `UPDATE orders ... WHERE status IN ('pending','expired')` +
 *      affectedRows === 1. Ini penjaga UTAMA: hanya satu pemanggil yang boleh
 *      melanjutkan. Status 'expired' ikut diterima karena QRISku bisa
 *      menyatakan paid setelah QR lewat 5 menit — pembayarannya nyata.
 *   2. `ref = 'topup:<orderId>'` yang UNIK di wallet_ledger. Ini sabuk kedua
 *      kalau ada pemanggil yang entah bagaimana lolos penjaga pertama; INSERT
 *      keduanya ditolak MySQL (ER_DUP_ENTRY), jadi saldo tidak mungkin dobel.
 *
 * Kedua lapis memang kelihatan berlebihan sampai ada webhook ganda. QRISku
 * mengirim ulang sampai 4x (immediate, 1s, 5s, 15s) dan setiap pengiriman itu
 * membawa event_id berbeda dengan status paid — tanpa penjaga, user top up
 * Rp50.000 empat kali.
 *
 * YANG DIKREDIT ADALAH `orders.amount`, BUKAN nominal dari payload gateway.
 * Payload cuma dipakai MEMVERIFIKASI (lihat bawah). Nominal dari luar itu
 * angka yang dikendalikan pihak lain; kalau dipercaya, siapa pun bisa
 * mengirim webhook "paid 1.000.000" untuk order 10.000.
 *
 * @param {{user_id:number, order_id:string, amount:number, plan:string, status:string}} order
 * @param {object} data  payload gateway (opsional; konfirmasi admin tidak punya)
 */
async function terapkanTopup(order, data) {
  if (!order) return { status: 'unknown', sudah: false, error: 'order kosong' };
  // Sabuk pengaman: fungsi ini cuma buat order top up. Salah kirim dari jalur
  // paket akan mengkredit saldo dari order paket — jadi ditolak, bukan diproses.
  if (order.plan !== 'topup') {
    console.error(`[Wallet] terapkanTopup dipanggil untuk plan '${order.plan}' — DITOLAK`);
    return { status: order.status, sudah: false, error: 'bukan order topup' };
  }

  const jumlah = Number(order.amount);
  if (!Number.isInteger(jumlah) || jumlah <= 0) {
    console.error(`[Wallet] order ${order.order_id} nominal tidak valid: ${order.amount}`);
    return { status: order.status, sudah: false, error: 'nominal order tidak valid' };
  }

  // ── Verifikasi nominal dari gateway (kalau gateway mengirimnya) ─────────────
  // QRISku TIDAK menambah kode unik dan kita tidak pernah mengirim `fee`, jadi
  // yang dibayar seharusnya sama persis dengan yang diorder. Tapi kalau gateway
  // suatu saat menambah biaya, atau webhook dikirim untuk order lain, selisihnya
  // harus KETAHUAN — bukan diam-diam dikredit.
  //
  // Tidak dikredit, TIDAK menggagalkan webhook (biar gateway berhenti mengirim
  // ulang): ordernya ditinggal pending supaya admin bisa memutuskan lewat
  // konfirmasi manual, dan alasannya dicatat di place yang terlihat admin.
  const nominalGateway = Number(data?.amount ?? data?.base_amount ?? NaN);
  if (Number.isFinite(nominalGateway) && nominalGateway !== jumlah) {
    const pesan = `nominal gateway ${nominalGateway} != order ${jumlah}`;
    console.error(`[Wallet] ${order.order_id} NOMINAL TIDAK COCOK: ${pesan} — TIDAK dikredit`);
    try {
      await pool.execute(
        "UPDATE orders SET note = ? WHERE order_id = ? AND status IN ('pending','expired')",
        [`NOMINAL TIDAK COCOK: ${pesan}`.slice(0, 250), order.order_id]
      );
    } catch (e) {
      console.error(`[Wallet] gagal catat mismatch ${order.order_id}: ${e.message}`);
    }
    return { status: order.status, sudah: false, error: pesan, mismatch: true };
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Penjaga utama. `expired` ikut: pembayaran telat tetap sah.
    const [upd] = await conn.execute(
      "UPDATE orders SET status = 'paid', paid_at = NOW(), note = ? WHERE order_id = ? AND status IN ('pending','expired')",
      [data?.payment_reference_id ? String(data.payment_reference_id).slice(0, 250) : null, order.order_id]
    );
    if (upd.affectedRows !== 1) {
      await conn.rollback();
      return { status: 'paid', sudah: true };
    }

    // Kunci baris user: dua top up bersamaan untuk user yang sama harus
    // berurutan, supaya `saldo_sesudah` di ledger tidak salah satu.
    const [rows] = await conn.execute(
      'SELECT saldo FROM users WHERE id = ? FOR UPDATE',
      [order.user_id]
    );
    if (!rows[0]) {
      await conn.rollback();
      console.error(`[Wallet] user ${order.user_id} tidak ada untuk order ${order.order_id}`);
      return { status: order.status, sudah: false, error: 'user tidak ditemukan' };
    }
    const saldoBaru = Number(rows[0].saldo) + jumlah;

    await conn.execute('UPDATE users SET saldo = ? WHERE id = ?', [saldoBaru, order.user_id]);
    await conn.execute(
      `INSERT INTO wallet_ledger (user_id, tipe, jumlah, saldo_sesudah, ref, alasan)
       VALUES (?, 'topup', ?, ?, ?, ?)`,
      [order.user_id, jumlah, saldoBaru, `topup:${order.order_id}`, data?.payment_reference_id || null]
    );

    await conn.commit();
    console.log(`[Wallet] topup ${order.order_id} → user ${order.user_id} +${rupiah(jumlah)} (saldo ${rupiah(saldoBaru)})`);
    return { status: 'paid', saldo: saldoBaru, kredit: jumlah, tipe: 'topup' };
  } catch (e) {
    try { await conn.rollback(); } catch {}
    // ER_DUP_ENTRY di ref = sabuk kedua bekerja: order ini sudah pernah
    // dikredit. Bukan kegagalan — laporkan sebagai sudah.
    if (e.code === 'ER_DUP_ENTRY') {
      console.warn(`[Wallet] topup ${order.order_id} sudah pernah dikredit (ref duplikat) — diabaikan`);
      return { status: 'paid', sudah: true };
    }
    console.error(`[Wallet] terapkanTopup ${order.order_id} GAGAL (di-rollback): ${e.message}`);
    return { status: order.status, sudah: false, error: e.message };
  } finally {
    conn.release();
  }
}

module.exports = {
  refPerpanjang,
  terapkanTopup,
};
