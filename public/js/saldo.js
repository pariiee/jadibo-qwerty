// Halaman Saldo (/saldo). Datanya dari:
//   GET  /api/wallet          -> saldo, status auto-renew, daftar paket + harga
//   GET  /api/wallet/ledger   -> riwayat dari wallet_ledger
//   POST /api/wallet/topup    -> bikin tagihan QRIS
//   POST /api/wallet/perpanjang
//   POST /api/wallet/auto-renew
//
// Dua hal yang sengaja dilakukan UI di sini:
//
// 1. Tombol DINONAKTIFKAN selama request berjalan. Bukan cuma kosmetik — ini
//    lapis pertama terhadap dobel-klik, dan biayanya nol. Lapis keduanya ada di
//    server (ref ledger = user+paket+milidetik, dan `idempotency_key` yang
//    dikirim dari sini).
//
// 2. Setiap klik perpanjang mengirim `idempotency_key` unik (crypto.randomUUID,
//    dibuat SEKALI saat klik). Kalau klik pertama timeout dan user mengulang,
//    kuncinya berbeda -> itu memang pembelian baru. Kalau UI/browser mengirim
//    ulang request yang SAMA, kuncinya sama -> server menolak yang kedua.
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

  // Timestamp MySQL datang tanpa zona — ditempel 'Z' supaya diperlakukan UTC,
  // sama seperti billing.js. Kalau tidak, jamnya geser sebesar offset.
  const waktu = (v) => {
    if (!v) return '—';
    const s = /Z|[+-]\d\d:?$/.test(String(v)) ? v : String(v).replace(' ', 'T') + 'Z';
    const d = new Date(s);
    return isNaN(d) ? String(v) : d.toLocaleString('id-ID',
      { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  };
  const tanggal = (v) => {
    if (!v) return null;
    const s = /Z|[+-]\d\d:?$/.test(String(v)) ? v : String(v).replace(' ', 'T') + 'Z';
    const d = new Date(s);
    return isNaN(d) ? null : d.toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });
  };

  // Jenis ledger -> label + arah. Tanda diambil dari DATA (`jumlah`), bukan
  // ditebak dari tipe, supaya permintaan datang dari server apa pun yang
  // mengubahnya tetap ditampilkan benar.
  const TIPE = {
    topup: 'Top up',
    perpanjang: 'Perpanjang',
    auto: 'Auto-perpanjang',
    adjust: 'Penyesuaian admin',
  };

  let data = null;
  let batas = null;
  let sedangKirim = false; // penjaga dobel-klik (lapis pertama)

  // ── Baca ──────────────────────────────────────────────────────────────────
  async function muat() {
    data = await api('/api/wallet');
    const daftar = document.getElementById('tabel-paket');

    if (!data || !data.ok) {
      document.getElementById('saldo-angka').textContent = '—';
      document.getElementById('saldo-paket').textContent = 'Gagal memuat saldo. Muat ulang halaman.';
      daftar.innerHTML = '<p class="m-sub" style="margin:0">Gagal memuat paket.</p>';
      return;
    }

    batas = data.topup;
    document.getElementById('saldo-angka').textContent = data.saldo_text;

    // Baris paket: nama + sampai kapan (jika ada elemennya di DOM)
    const akhir = tanggal(data.plan_expired_at);
    const namaPaket = (data.plans.find((p) => p.id === data.paket) || {}).name || data.paket || 'Gratis';
    const namaEl = document.getElementById('saldo-paket-nama');
    if (namaEl) namaEl.textContent = esc(namaPaket);
    const paketEl = document.getElementById('saldo-paket');
    if (paketEl) {
      paketEl.innerHTML = akhir
        ? `Paket <b>${esc(namaPaket)}</b> — ${data.paket_aktif ? 'aktif sampai' : 'sudah berakhir'} <b>${esc(akhir)}</b>`
        : 'Tidak ada paket aktif. Beli paket berbayar buat menyalakan bot.';
    }

    // Banner auto-perpanjang.
    const banner = document.getElementById('banner-auto');
    if (data.auto_renew_status === 'saldo_kurang') {
      const butuh = data.harga_paket_ini;
      banner.style.display = '';
      banner.innerHTML =
        '<b>Auto-perpanjang gagal: saldo kurang</b>' +
        '<p class="m-sub" style="margin:8px 0 0">' +
        `Saldo kamu <b>${rupiah(data.saldo)}</b>${butuh ? ', butuh <b>' + rupiah(butuh) + '</b>' : ''}. ` +
        'Paket <b>tidak dipotong sebagian</b>. Top up dulu, lalu perpanjang manual di bawah. ' +
        `Terakhir dicek: ${esc(waktu(data.auto_renew_status_at))}.</p>`;
    } else if (data.auto_renew_status === 'paket_tidak_bisa_diperpanjang') {
      banner.style.display = '';
      banner.innerHTML =
        '<b>Auto-perpanjang tidak berlaku untuk paket ini</b>' +
        '<p class="m-sub" style="margin:8px 0 0">Paket gratis/trial tidak bisa diperpanjang dengan saldo. Pilih paket berbayar di bawah.</p>';
    } else {
      banner.style.display = 'none';
    }

    // Toggle auto-renew + keterangan percobaan terakhir.
    document.getElementById('auto-renew').checked = !!data.auto_renew;
    document.getElementById('auto-status').textContent = data.auto_renew_status === 'sukses'
      ? `Terakhir berhasil: ${waktu(data.auto_renew_status_at)}`
      : data.auto_renew
        ? 'Aktif. Belum ada perpanjangan otomatis yang dijalankan.'
        : 'Mati. Paket tidak akan diperpanjang otomatis.';

    // Nominal top up: batas & pilihan cepat SELALU dari server, tidak dihitung
    // ulang di sini. Kalau dihitung di sini, dua sumber angka bisa berbeda.
    const inp = document.getElementById('nominal');
    inp.min = batas.min; inp.max = batas.max; inp.step = batas.kelipatan;
    document.getElementById('petunjuk-nominal').textContent =
      `Min ${rupiah(batas.min)} · maks ${rupiah(batas.max)} · kelipatan ${rupiah(batas.kelipatan)}` +
      (batas.maks_pending ? ` · maksimal ${batas.maks_pending} tagihan belum dibayar` : '');
    document.getElementById('pilihan-cepat').innerHTML = batas.cepat
      .map((n) => `<button type="button" class="btn btn-outline btn-sm chip-btn" data-act="pilihNominal(${n})">${rupiah(n)}</button>`)
      .join('');
    document.getElementById('blok-topup').style.display = '';

    // Tombol perpanjang per paket.
    daftar.innerHTML = data.plans.length
      ? data.plans.map((p) => {
          const cukup = data.saldo >= p.price;
          return '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--line,#e5e7eb)">' +
            '<span><b>' + esc(p.name) + '</b><span class="m-sub" style="display:block;margin-top:2px">' +
              p.days + ' hari · ' + rupiah(p.price) + '</span></span>' +
            '<button class="btn btn-sm' + (cukup ? '' : ' btn-outline') + '" ' +
              'data-act="perpanjang(\'' + esc(p.id) + '\')"' + (cukup ? '' : ' disabled') + '>' +
              (cukup ? 'Perpanjang' : 'Saldo kurang') + '</button>' +
          '</div>';
        }).join('')
      : '<p class="m-sub" style="margin:0">Belum ada paket berbayar. Hubungi admin.</p>';
  }

  async function muatLedger() {
    const d = await api('/api/wallet/ledger?limit=50');
    const tbody = document.querySelector('#tbl-ledger tbody');
    const kosong = document.getElementById('ledger-kosong');
    if (!d || !d.ok) {
      tbody.innerHTML = '<tr><td colspan="5" class="kosong">Gagal memuat riwayat.</td></tr>';
      return;
    }
    if (!d.ledger.length) {
      tbody.innerHTML = '';
      kosong.style.display = '';
      document.querySelector('.tbl-wrap').style.display = 'none';
      return;
    }
    kosong.style.display = 'none';
    tbody.innerHTML = d.ledger.map((r) => {
      const naik = Number(r.jumlah) >= 0;
      return '<tr>' +
        '<td class="muted">' + esc(waktu(r.created_at)) + '</td>' +
        '<td>' + esc(TIPE[r.tipe] || r.tipe) + '</td>' +
        '<td style="text-align:right;font-weight:700;color:' + (naik ? '#059669' : '#b91c1c') + '">' +
          (naik ? '+' : '−') + rupiah(Math.abs(r.jumlah)) + '</td>' +
        '<td style="text-align:right" class="muted">' + rupiah(r.saldo_sesudah) + '</td>' +
        '<td class="muted">' + esc(r.alasan || '—') + '</td>' +
        '</tr>';
    }).join('');
  }

  // ── Tulis ─────────────────────────────────────────────────────────────────
  //
  // `sedangKirim` menahan klik kedua SELAMA request berjalan. Itu lapis pertama
  // dan paling murah; server tetap punya penjaganya sendiri (idempotency_key +
  // ref ledger), jadi request kedua yang entah bagaimana lolos pun tidak
  // memotong saldo dua kali.
  async function kunci(tombol, fn) {
    if (sedangKirim) return;
    sedangKirim = true;
    const teksAsli = tombol ? tombol.textContent : null;
    if (tombol) { tombol.disabled = true; tombol.textContent = 'Memproses…'; }
    try { return await fn(); }
    finally {
      sedangKirim = false;
      if (tombol) { tombol.disabled = false; tombol.textContent = teksAsli; }
    }
  }

  async function topup(tombol) {
    await kunci(tombol, async () => {
      const nominal = Number(String(document.getElementById('nominal').value || '').replace(/\D/g, ''));
      if (!nominal) { alert('Isi nominal top up dulu.'); return; }
      // Validasi di sini cuma buat pesan cepat; SERVER yang menentukan. Kalau
      // aturannya berubah di server, UI ini tidak bisa jadi lubang.
      const d = await api('/api/wallet/topup', { method: 'POST', body: JSON.stringify({ nominal }) });
      if (!d || !d.ok) { alert(d?.message || 'Gagal membuat tagihan.'); return; }
      if (d.order_id) {
        location.href = '/invoice/' + encodeURIComponent(d.order_id);
        return;
      }
      tampilkanQris(d);
      muatLedger();
    });
  }

  function tampilkanQris(d) {
    const blok = document.getElementById('blok-qris');
    blok.style.display = '';
    blok.innerHTML =
      '<b>Tagihan ' + esc(d.nominal_text) + '</b>' +
      '<p class="m-sub" style="margin:8px 0 12px">' + esc(d.keterangan || '') +
      ' QR berlaku sampai <b>' + esc(waktu(d.expired_at)) + '</b>.</p>' +
      (d.qris_image ? '<img src="' + esc(d.qris_image) + '" alt="QRIS" style="max-width:260px;width:100%;border-radius:12px" />' : '') +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">' +
        (d.pay_url ? '<a class="btn" href="' + esc(d.pay_url) + '" target="_blank" rel="noopener">Buka halaman bayar</a>' : '') +
        '<button class="btn btn-outline" data-act="cekTopup(\'' + esc(d.order_id) + '\')">Cek status</button>' +
      '</div>' +
      '<p class="m-sub" style="margin:12px 0 0">Saldo masuk otomatis setelah pembayaran terkonfirmasi gateway. ' +
      'Kalau webhook-nya telat, tekan <b>Cek status</b>.</p>';
  }

  async function cekTopup(orderId, tombol) {
    await kunci(tombol, async () => {
      const d = await api('/api/billing/orders/' + encodeURIComponent(orderId) + '/check', { method: 'POST' });
      if (!d) return;
      alert(d.status === 'paid' ? 'Pembayaran diterima. Saldo sudah ditambah.' : (d.message || 'Belum lunas.'));
      await muat(); await muatLedger();
    });
  }

  // Kunci idempotensi per niat beli. Dibuat saat konfirmasi dibuka, dipakai ulang
  // untuk semua klik/retry sampai sukses, baru dibuang sesudahnya.
  const kunciNiat = {};

  async function perpanjang(planId, tombol) {
    const p = data?.plans?.find((x) => x.id === planId);
    const namaPaket = p?.name || planId;
    const hargaPaket = p?.price_text || rupiah(p?.price || 0);

    if (!kunciNiat[planId]) {
      kunciNiat[planId] = (window.crypto?.randomUUID && window.crypto.randomUUID()) ||
        (Date.now().toString(36) + Math.random().toString(36).slice(2));
    }

    if (!confirm(`Perpanjang paket ${namaPaket} seharga ${hargaPaket} dari saldo?`)) return;

    await kunci(tombol, async () => {
      const idempotency_key = kunciNiat[planId];
      const d = await api('/api/wallet/perpanjang', {
        method: 'POST',
        body: JSON.stringify({ plan: planId, idempotency_key }),
      });
      if (!d || !d.ok) {
        alert(d?.message || 'Gagal memperpanjang.');
        if (d && d.reason === 'saldo_kurang') muat();
        return;
      }
      delete kunciNiat[planId];
      alert(d.message || 'Paket diperpanjang.');
      await muat(); await muatLedger();
    });
  }

  async function autoRenew(el) {
    const mau = el.checked;
    el.disabled = true;
    try {
      const d = await api('/api/wallet/auto-renew', { method: 'POST', body: JSON.stringify({ aktif: mau }) });
      if (!d || !d.ok) { el.checked = !mau; alert(d?.message || 'Gagal menyimpan pengaturan.'); return; }
      await muat();
    } finally { el.disabled = false; }
  }

  // Dipakai atribut data-act (lihat head.js: satu listener untuk semuanya).
  window.pilihNominal = (n) => { document.getElementById('nominal').value = n; };
  window.topup = (t) => topup(t);
  window.perpanjang = (p, t) => perpanjang(p, t);
  window.cekTopup = (o, t) => cekTopup(o, t);
  window.autoRenew = (el) => autoRenew(el);

  // Topbar default menulis "Dashboard" + tombol "Tambah Bot" — dua-duanya salah
  // di halaman ini. Pola yang sama dipakai kuota.js/profil.js/billing.js.
  const sapaan = document.getElementById('greeting');
  if (sapaan) sapaan.textContent = 'Saldo';
  window.openAddBot = () => { location.href = '/dashboard'; };

  muat().then(muatLedger);
})();
