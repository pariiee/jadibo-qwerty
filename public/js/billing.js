// Halaman Riwayat Pembayaran (/billing). Datanya dari GET /api/billing/orders
// — endpoint itu cuma balikin order milik user yang login.
(function () {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  async function api(path, opts = {}) {
    try {
      const res = await fetch(path, {
        ...opts, credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      });
      if (res.status === 401) { location.href = '/'; return null; }
      return res.json();
    } catch { return null; }
  }

  const rupiah = (v) => 'Rp' + Number(v || 0).toLocaleString('id-ID');

  // Timestamp dari MySQL datang tanpa zona — ditempel 'Z' supaya diperlakukan
  // UTC, sama seperti bot-stats.js. Kalau tidak, jamnya geser sebesar offset.
  const waktu = (v) => {
    if (!v) return '—';
    const s = /Z|[+-]\d\d:?$/.test(String(v)) ? v : String(v).replace(' ', 'T') + 'Z';
    const d = new Date(s);
    return isNaN(d) ? String(v) : d.toLocaleString('id-ID',
      { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  };

  const STATUS = {
    pending: ['st-pending', 'Menunggu'],
    paid: ['st-paid', 'Lunas'],
    rejected: ['st-rejected', 'Ditolak'],
  };

  let semuaOrder = [];
  let aku = null;   // dari /api/auth/me — buat tahu trial masih bisa diklaim

  function gambar() {
    const st = document.getElementById('filter-status').value;
    const baris = semuaOrder.filter((o) => !st || o.status === st);
    const tbody = document.querySelector('#tbl-order tbody');
    const kosong = document.getElementById('order-kosong');

    if (!baris.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="kosong">' +
        (semuaOrder.length ? 'Nggak ada pesanan dengan status itu.' : 'Belum ada pesanan.') +
        '</td></tr>';
    } else {
      tbody.innerHTML = baris.map((o) => {
        const [cls, label] = STATUS[o.status] || ['', o.status];
        return '<tr>' +
          '<td><code>' + esc(o.order_id) + '</code></td>' +
          '<td>' + esc(o.plan) + '</td>' +
          '<td style="text-align:right"><b>' + rupiah(o.amount) + '</b></td>' +
          '<td class="muted">' + esc(String(o.method || '').toUpperCase() || '—') + '</td>' +
          '<td><span class="badge ' + cls + '">' + label + '</span></td>' +
          '<td class="muted">' + waktu(o.paid_at || o.created_at) + '</td>' +
          '<td class="aksi">' + (o.status === 'pending'
            ? '<button class="btn btn-outline btn-sm" data-act="cekOrder(\'' + esc(o.order_id) + '\')">Cek Status</button>'
            : '') + '</td>' +
          '</tr>';
      }).join('');
    }

    // Kartu jalan keluar cuma muncul kalau memang belum ada pesanan SAMA SEKALI —
    // kalau cuma kena filter, tabel kosongnya sudah ada pesannya sendiri.
    const belumPernah = semuaOrder.length === 0;
    kosong.style.display = belumPernah ? 'flex' : 'none';
    // Tabel kosong + kartu kosong sekaligus = dua pesan yang sama. Yang bicara
    // kartunya, tabelnya disembunyikan.
    document.querySelector('.tbl-wrap').style.display = belumPernah ? 'none' : '';
    if (belumPernah && aku) {
      document.getElementById('btn-trial').style.display = aku.trial_used ? 'none' : 'inline-flex';
      document.getElementById('kosong-teks').textContent = aku.trial_used
        ? 'Kamu sudah pernah pakai trial. Pilih paket buat mengaktifkan bot lagi.'
        : 'Kamu belum pernah berlangganan. Coba trial ' + (aku.trial_hari || 5) + ' hari dulu — gratis.';
    }

    // Catatan di bawah tabel.
    const pending = semuaOrder.filter((o) => o.status === 'pending');
    const catatan = document.getElementById('order-note');
    if (pending.length) {
      catatan.innerHTML = 'Masih ada pesanan yang belum dibayar. Lanjutkan pembayarannya di ' +
        '<a href="/pricing">halaman langganan</a> — atau klik “Cek Status” kalau sudah bayar.';
    } else {
      catatan.textContent = semuaOrder.length ? 'Semua pesanan sudah selesai.' : '';
    }
  }

  async function muatOrder() {
    const [d, me] = await Promise.all([api('/api/billing/orders'), api('/api/auth/me')]);
    if (!d?.ok) { document.querySelector('#tbl-order tbody').innerHTML =
      '<tr><td colspan="7" class="kosong">Gagal memuat riwayat.</td></tr>'; return; }
    semuaOrder = d.orders || [];
    if (me?.ok) aku = me.user;
    gambar();
  }

  // Tombol "Cek Status" nembak endpoint per-order — itu satu-satunya cara tahu
  // pembayaran QRIS sudah masuk sebelum webhook datang. Bentuk balasannya
  // { ok, status, message }, bukan { sudah_lunas }.
  async function cekOrder(orderId) {
    showToast('Mengecek pembayaran…');
    const d = await api('/api/billing/orders/' + encodeURIComponent(orderId) + '/check', { method: 'POST' });
    if (!d?.ok) { showToast(d?.message || 'Gagal cek status', 'error'); return; }
    const lunas = d.status === 'paid';
    showToast(d.message || (lunas ? 'Pembayaran masuk' : 'Belum masuk'), lunas ? 'success' : 'error');
    muatOrder();
  }

  // Trial: POST /api/billing/trial sudah ada (dipakai /pricing) — di sini cuma
  // dipanggil dari tempat user bingung, bukan dibuat endpoint baru.
  async function klaimTrial() {
    const btn = document.getElementById('btn-trial');
    btn.disabled = true;
    const d = await api('/api/billing/trial', { method: 'POST' });
    btn.disabled = false;
    if (!d?.ok) { showToast(d?.message || 'Gagal klaim trial', 'error'); return; }
    showToast(d.message || 'Trial aktif!', 'success');
    muatOrder();
  }

  const sapaan = document.getElementById('greeting');
  if (sapaan) sapaan.textContent = 'Riwayat Pembayaran';
  window.openAddBot = () => { location.href = '/dashboard'; };

  document.getElementById('filter-status').onchange = gambar;
  window.muatOrder = muatOrder;
  window.cekOrder = cekOrder;
  window.klaimTrial = klaimTrial;
  muatOrder();
})();
