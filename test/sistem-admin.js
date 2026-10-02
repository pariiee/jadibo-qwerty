'use strict';
/**
 * test/sistem-admin.js
 *
 * Tab "Sistem" di /kountole menyentuh tiga hal yang gampang salah SENYAP:
 *
 *  1. JEJAK AUDIT — dipasang sebagai middleware `/api/admin/*`. Dua jebakan:
 *     (a) kalau pencatatannya sinkron (await) atau melempar, aksi admin yang
 *         sebenarnya BERHASIL jadi ikut gagal — audit tidak boleh jadi jalur
 *         kritis;
 *     (b) kalau route admin didaftarkan SEBELUM middleware-nya, Express tidak
 *         pernah memanggil middleware itu untuk route tersebut, dan tab
 *         aktivitas akan selalu kosong tanpa error apa pun.
 *  2. PENDAPATAN — seri harian harus SELALU 14 titik (termasuk hari tanpa
 *     order). Grafik yang cuma berisi hari-hari yang kebetulan ada transaksi
 *     bikin sumbu waktunya bohong. Dan SATU-SATUNYA nilai yang boleh muncul
 *     saat belum ada penjualan adalah nol — bukan dikosongkan, bukan dipalsukan.
 *  3. BROADCAST — kirim lewat bot milik tiap user; yang botnya mati TIDAK
 *     sampai. Wajib dilaporkan, bukan dibulatkan jadi "terkirim ke semua".
 *
 * Memakai pool & notify palsu, jadi tidak butuh DB maupun WhatsApp.
 */

const path = require('path');
const Module = require('module');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

// ─── Pool palsu ───────────────────────────────────────────────────────────────
const DB = {
  orders: [{ tgl: '2026-10-02', jumlah: 2, total: 75000 }],
  ringkas: [{ total_lunas: 75000, jumlah_lunas: 2, jumlah_pending: 1 }],
  users: [{ id: 1, username: 'king' }, { id: 2, username: 'adminid' }],
  gagalBaca: false,
  insertAudit: [],
};
const poolPalsu = {
  execute: async (sql, params = []) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (/INSERT INTO admin_log/i.test(q)) {
      if (DB.gagalBaca) throw new Error('ER_NO_SUCH_TABLE');
      DB.insertAudit.push(params);
      return [{ affectedRows: 1 }];
    }
    if (/FROM admin_log/i.test(q)) {
      if (DB.gagalBaca) { const e = new Error("Table 'x.admin_log' doesn't exist"); e.errno = 1146; throw e; }
      return [[{ id: 1, username: 'king', method: 'POST', path: '/api/admin/broadcast', status: 200, ip: '1.2.3.4', created_at: '2026-10-02 10:00:00' }]];
    }
    if (/FROM orders/i.test(q)) return [DB.orders];
    if (/SUM\(CASE/i.test(q)) return [DB.ringkas];
    if (/FROM users/i.test(q)) return [DB.users];
    return [[]];
  },
};

// ─── Notify palsu: user 2 botnya mati ─────────────────────────────────────────
const MATI = new Set([2]);
const notifyPalsu = {
  kirimKeOwner: async (userId) => !MATI.has(Number(userId)),
};

// Sisipkan modul tiruan sebelum controller di-require.
//
// PENTING: `require` tiruan TIDAK dipulihkan sesudah `require` controller,
// karena `sistemController` memanggil `require('../engine/notify')` saat
// fungsinya JALAN (bukan saat module-load). Memulihkannya lebih awal bikin
// broadcast memakai notify asli — dan tesnya gagal karena alasan yang salah.
const asli = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../config/database') return { pool: poolPalsu };
  if (id === '../engine/notify') return notifyPalsu;
  return asli.apply(this, arguments);
};

const sistem = require(path.join(__dirname, '..', 'controllers', 'sistemController.js'));

/** Tiruan `res` Express minimal. */
function resPalsu() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

(async () => {
  console.log('=== 1. Jejak audit TIDAK boleh menggagalkan aksi admin ===');
  DB.gagalBaca = true; // DB sedang rusak
  sistem.catatAudit({
    userId: 1, username: 'king', method: 'DELETE',
    path: '/api/admin/users/2', status: 200, ip: '1.2.3.4',
  });
  // Beri kesempatan promise-nya settle (fungsinya fire-and-forget).
  await new Promise((r) => setTimeout(r, 20));
  cek('catatAudit tidak melempar walau INSERT gagal', true);
  DB.gagalBaca = false;

  console.log('\n=== 2. Pencatatan menyimpan apa yang dibutuhkan untuk audit ===');
  DB.insertAudit = [];
  sistem.catatAudit({
    userId: 7, username: 'king', method: 'PATCH',
    path: '/api/admin/users/2?x=1', status: 200, ip: '9.9.9.9',
  });
  await new Promise((r) => setTimeout(r, 20));
  const p = DB.insertAudit[0] || [];
  cek('tercatat 1 baris', DB.insertAudit.length === 1);
  cek('user_id tersimpan', p[0] === 7, String(p[0]));
  cek('username tersimpan', p[1] === 'king', String(p[1]));
  cek('method tersimpan', p[2] === 'PATCH', String(p[2]));
  cek('path termasuk query string', String(p[3]).includes('?x=1'), String(p[3]));
  cek('status tersimpan', p[4] === 200, String(p[4]));
  cek('ip tersimpan', p[5] === '9.9.9.9', String(p[5]));

  console.log('\n=== 3. Tabel belum ada: dilaporkan, bukan 500 mentah ===');
  DB.gagalBaca = true;
  let res = resPalsu();
  await sistem.audit({}, res);
  cek('status 200 (bukan 500)', res.statusCode === 200, String(res.statusCode));
  cek('ok:true dengan daftar kosong', res.body?.ok === true && Array.isArray(res.body.logs));
  cek('ada petunjuk cara memperbaiki', /sync-schema/.test(res.body?.catatan || ''),
    String(res.body?.catatan));
  DB.gagalBaca = false;

  console.log('\n=== 4. Pendapatan: seri SELALU 14 hari ===');
  res = resPalsu();
  await sistem.pendapatan({}, res);
  const seri = res.body?.seri || [];
  cek('panjang seri = 14', seri.length === 14, String(seri.length));
  cek('urut dari paling lama ke terbaru',
    seri.length === 14 && seri[0].tgl < seri[13].tgl, `${seri[0]?.tgl} → ${seri[13]?.tgl}`);
  cek('hari tanpa order tetap ada dan bernilai 0',
    seri.filter((s) => s.total === 0).length === 13,
    `${seri.filter((s) => s.total === 0).length} hari nol`);
  cek('hari yang ada order ikut terisi', seri.some((s) => s.total === 75000));
  cek('ringkasan diteruskan apa adanya',
    res.body?.ringkas?.total_lunas === 75000 && res.body?.ringkas?.jumlah_pending === 1,
    JSON.stringify(res.body?.ringkas));

  console.log('\n=== 5. Broadcast melaporkan yang GAGAL, bukan dibulatkan ===');
  res = resPalsu();
  await sistem.broadcast({ body: { teks: 'halo semua' } }, res);
  cek('terkirim = 1 (user 2 botnya mati)', res.body?.terkirim === 1, String(res.body?.terkirim));
  cek('gagal = 1', res.body?.gagal === 1, String(res.body?.gagal));
  cek('total = 2', res.body?.total === 2, String(res.body?.total));
  cek('pesan menyebut siapa yang tidak sampai',
    /adminid/.test(res.body?.message || ''), String(res.body?.message));
  cek('TIDAK mengklaim terkirim ke semua',
    !/terkirim ke 2\/2/i.test(res.body?.message || ''), String(res.body?.message));

  console.log('\n=== 6. Broadcast kosong ditolak ===');
  res = resPalsu();
  await sistem.broadcast({ body: { teks: '   ' } }, res);
  cek('status 400', res.statusCode === 400, String(res.statusCode));
  cek('tidak mengirim apa pun', res.body?.ok === false);

  console.log('\n=== 7. Status sistem: health gagal pun tetap menjawab ===');
  res = resPalsu();
  await sistem.status({}, res);
  cek('ok:true', res.body?.ok === true);
  cek('ada bagian resource', !!res.body?.resource?.ram?.total);
  cek('ada versi node', !!res.body?.resource?.node);
  cek('ada catatan loadavg (LXC bisa menampilkan beban HOST)',
    /host/i.test(res.body?.resource?.cpu?.loadCatatan || ''));

  console.log('\n=== 8. Urutan middleware audit di server.js ===');
  // Express memanggil middleware sesuai URUTAN PENDAFTARAN. Kalau ada route
  // `/api/admin/*` yang didaftarkan SEBELUM middleware audit, route itu tidak
  // pernah terekam — dan tab aktivitas jadi bolong tanpa satu pun error.
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const idxMiddleware = src.indexOf("app.use('/api/admin'");
  const semuaRoute = [...src.matchAll(/app\.(get|post|put|patch|delete)\('\/api\/admin/g)];
  cek('middleware audit ada', idxMiddleware > 0);
  const routeSebelum = semuaRoute.filter((m) => m.index < idxMiddleware);
  cek(`tidak ada route /api/admin SEBELUM middleware (ditemukan ${routeSebelum.length})`,
    routeSebelum.length === 0,
    routeSebelum.map((m) => m[0]).join(', ') || '—');
  cek('middleware pakai res.on(\'finish\') (status code belum final saat middleware jalan)',
    /res\.on\('finish'/.test(src));
  cek('IP asli diambil dari cf-connecting-ip (di belakang Cloudflare Tunnel req.ip = 127.0.0.1)',
    /cf-connecting-ip/.test(src));

  console.log('');
  console.log(gagal ? `=== GAGAL: ${gagal} masalah ===` : '=== SEMUA CEK LULUS ===');
  process.exit(gagal ? 1 : 0);
})();
