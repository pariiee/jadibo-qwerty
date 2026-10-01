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

  function kartuBot(b) {
    const st = b.jalan ? ['st-on', 'Online'] : (b.status === 'connecting' ? ['st-wait', 'Connecting'] : ['st-off', 'Offline']);

    let isi;
    if (!b.paketAktif) {
      isi =
        '<div class="kuota-angka"><b style="color:var(--errTxt)">Paket tidak aktif</b></div>' +
        '<p class="m-sub" style="margin:4px 0 0">Bot berhenti membalas dan dimatikan otomatis sampai paket diperpanjang.</p>';
    } else if (b.tanpaBatas) {
      isi =
        '<div class="kuota-angka"><b>Tanpa batas</b></div>' +
        '<p class="m-sub" style="margin:4px 0 0">Akun ini tidak dibatasi kuota pesan.</p>';
    } else {
      isi =
        '<div class="kuota-angka"><b>' + angka(b.sisa) + '</b><span>sisa dari ' + angka(b.batas) + ' pesan</span></div>' +
        '<div class="kuota-bar"><i style="width:' + Math.min(100, b.persen) + '%;background:' + warna(b.persen) + '"></i></div>' +
        '<p class="m-sub" style="margin:8px 0 0">' + b.persen + '% terpakai' + (b.habis ? ' — <b style="color:var(--errTxt)">kuota habis</b>' : '') + '</p>';
    }

    return '<div class="card kuota-card">' +
      '<div class="kuota-head">' +
        '<div>' +
          '<h4>' + esc(b.nama) + '</h4>' +
          '<div class="bc-status"><span class="st-dot ' + st[0] + '"></span>' + st[1] + '</div>' +
        '</div>' +
        (b.habis || !b.paketAktif ? '<a class="btn btn-outline" href="/pricing">Tambah Kuota</a>' : '') +
      '</div>' +
      isi +
      '<div class="kuota-harian">Per hari: <b>' + angka(b.harian) + '</b> · reset 00:00 WIB</div>' +
    '</div>';
  }

  async function muat() {
    const d = await api('/api/kuota');
    const daftar = document.getElementById('kuota-daftar');
    const kosong = document.getElementById('kuota-kosong');
    if (!d || !d.ok) { daftar.innerHTML = '<div class="card"><p class="m-sub">Gagal memuat kuota.</p></div>'; return; }

    if (!d.bots.length) { kosong.style.display = ''; daftar.innerHTML = ''; return; }
    kosong.style.display = 'none';
    daftar.innerHTML = d.bots.map(kartuBot).join('');
  }

  muat();
})();
