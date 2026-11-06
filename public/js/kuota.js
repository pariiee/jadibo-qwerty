// Halaman Kuota Pesan (/kuota). Datanya dari GET /api/kuota — endpoint itu
// cuma balikin bot milik user yang login, dan angkanya dihitung engine/kuota.js
// (satu sumber aturan, sama seperti yang dipakai bot buat nerima/tolak pesan).
(function () {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  async function api(path) {
    try {
      const res = await fetch(path, { credentials: 'include' });
      if (res.status === 401) { location.href = '/'; return null; }
      return res.json();
    } catch { return null; }
  }

  const angka = (v) => Number(v || 0).toLocaleString('id-ID');

  // Warna bar: hijau < 80%, kuning < 95%, merah sisanya. Ambangnya SAMA dengan
  // ambang peringatan WA di engine/kuota.js — kalau di sana diubah, ubah di sini.
  const warna = (persen) => (persen >= 95 ? 'var(--errTxt)' : persen >= 80 ? 'var(--warn)' : 'var(--ok)');

  function renderKuotaSkeleton() {
    const daftar = document.getElementById('kuota-daftar');
    if (!daftar) return;
    daftar.innerHTML = [1, 2].map(() => `
      <div class="kuota-card" style="pointer-events:none">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div class="bt-skel" style="width:120px;height:24px;border-radius:8px"></div>
          <div class="bt-skel" style="width:70px;height:22px;border-radius:999px"></div>
        </div>
        <div class="bt-skel" style="width:160px;height:34px;border-radius:8px;margin-bottom:12px"></div>
        <div class="bt-skel" style="width:100%;height:14px;border-radius:999px;margin-bottom:10px"></div>
        <div class="bt-skel" style="width:140px;height:18px;border-radius:6px"></div>
      </div>
    `).join('');
  }

  function kartuBot(b) {
    const st = b.jalan ? ['st-on', 'Online'] : (b.status === 'connecting' ? ['st-wait', 'Connecting'] : ['st-off', 'Offline']);

    let isi;
    if (!b.paketAktif) {
      isi =
        '<div class="kuota-angka"><b style="color:#E11D48">Paket Tidak Aktif</b></div>' +
        '<p class="kuota-desc">Bot berhenti merespons dan dipause otomatis sampai masa aktif paket diperpanjang.</p>';
    } else if (b.tanpaBatas) {
      isi =
        '<div class="kuota-angka"><b>Tanpa Batas</b></div>' +
        '<p class="kuota-desc">Akun ini memiliki kuota pesan unlimited.</p>';
    } else {
      isi =
        '<div class="kuota-angka"><b>' + angka(b.sisa) + '</b><span class="kuota-total"> / ' + angka(b.batas) + ' pesan tersisa</span></div>' +
        '<div class="kuota-progress-wrap"><div class="kuota-bar-fill" style="width:' + Math.min(100, b.persen) + '%;background:' + warna(b.persen) + '"></div></div>' +
        '<div class="kuota-status-line"><span>' + b.persen + '% terpakai</span>' + (b.habis ? '<b style="color:#E11D48">Kuota Habis</b>' : '') + '</div>';
    }

    return '<div class="kuota-card">' +
      '<div class="kuota-card-head">' +
        '<div>' +
          '<h3 class="kuota-bot-name">' + esc(b.nama) + '</h3>' +
          '<span class="kuota-status-pill ' + st[0] + '"><i class="st-dot"></i>' + st[1] + '</span>' +
        '</div>' +
        (b.habis || !b.paketAktif ? '<a class="kuota-btn-topup" href="/pricing">Perpanjang &rarr;</a>' : '') +
      '</div>' +
      isi +
      '<div class="kuota-harian-footer">Limit Harian: <b>' + angka(b.harian) + ' pesan</b> <span class="kuota-reset-tag">Reset 00:00 WIB</span></div>' +
    '</div>';
  }

  async function muat() {
    renderKuotaSkeleton();
    const d = await api('/api/kuota');
    const daftar = document.getElementById('kuota-daftar');
    const kosong = document.getElementById('kuota-kosong');
    if (!d || !d.ok) { daftar.innerHTML = '<div class="card"><p class="m-sub">Gagal memuat kuota.</p></div>'; return; }

    if (!d.bots.length) { kosong.style.display = ''; daftar.innerHTML = ''; return; }
    kosong.style.display = 'none';
    daftar.innerHTML = d.bots.map(kartuBot).join('');
  }


  // Topbar default-nya menulis "Dashboard" + tombol "Tambah Bot" — dua-duanya
  // salah di halaman ini. Pola yang sama dipakai command.js/profil.js/billing.js.
  const sapaan = document.getElementById('greeting');
  if (sapaan) sapaan.textContent = 'Kuota Pesan';
  window.openAddBot = () => { location.href = '/dashboard'; };
  muat();
})();
