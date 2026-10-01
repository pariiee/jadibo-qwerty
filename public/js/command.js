// Halaman Command Manager (/command) — semuanya dari GET /api/command sekali
// jalan, sisanya nyaring di browser. Nol request tambahan waktu ganti filter.
(function () {
  const PER_HAL = 10;

  let semua = [];      // hasil mentah dari API
  let hasil = [];      // setelah disaring
  let hal = 1;

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  async function api(path) {
    try {
      const res = await fetch(path, { credentials: 'include' });
      if (res.status === 401) { location.href = '/'; return null; }
      return res.json();
    } catch { return null; }
  }

  function saring() {
    const q = document.getElementById('cmd-cari').value.trim().toLowerCase();
    const kat = document.getElementById('cmd-kategori').value;
    const limit = document.getElementById('cmd-limit').checked;
    hasil = semua.filter((c) =>
      (!kat || c.kategori === kat) &&
      (!limit || c.limit) &&
      (!q || c.nama.includes(q) || c.label.toLowerCase().includes(q))
    );
    hal = 1;
    gambar();
  }

  function gambar() {
    const list = document.getElementById('cmd-daftar');
    const halaman = Math.max(1, Math.ceil(hasil.length / PER_HAL));
    if (hal > halaman) hal = halaman;
    const potong = hasil.slice((hal - 1) * PER_HAL, hal * PER_HAL);

    list.innerHTML = potong.map((c) => `
      <div class="cmd-row">
        <div class="cmd-kiri">
          <code class="cmd-nama">${esc(c.prefix)}</code>
          <span class="cmd-kat">${esc(c.label)}</span>
        </div>
        <div class="cmd-tanda">
          ${c.limit ? '<span class="cmd-tag tag-limit">Limit</span>' : ''}
          ${c.bebas ? '<span class="cmd-tag tag-bebas">Wajib</span>' : ''}
        </div>
      </div>`).join('');

    document.getElementById('cmd-kosong').style.display = hasil.length ? 'none' : 'block';
    document.getElementById('cmd-hitung').textContent =
      `${hasil.length} dari ${semua.length} command` +
      (hasil.length !== semua.length ? ' (disaring)' : '') +
      ` · ${halaman} halaman`;

    const pager = document.getElementById('cmd-pager');
    pager.style.display = hasil.length > PER_HAL ? 'flex' : 'none';
    document.getElementById('cmd-hal').textContent = `Hal ${hal}/${halaman}`;
  }

  function cmdHal(arah) {
    const halaman = Math.max(1, Math.ceil(hasil.length / PER_HAL));
    hal = Math.min(halaman, Math.max(1, hal + arah));
    gambar();
  }

  async function muatCommand() {
    const d = await api('/api/command');
    if (!d?.ok) { document.getElementById('cmd-hitung').textContent = 'Gagal memuat daftar command.'; return; }

    semua = d.commands;
    document.getElementById('cmd-kategori').innerHTML =
      '<option value="">Semua Kategori</option>' +
      d.kategori.map((k) => `<option value="${esc(k.kunci)}">${esc(k.label)} (${k.jumlah})</option>`).join('');
    document.getElementById('cmd-hitung').textContent = `${d.total} command`;
    saring();
  }

  document.getElementById('cmd-cari').oninput = saring;
  document.getElementById('cmd-kategori').onchange = saring;
  document.getElementById('cmd-limit').onchange = saring;

  // Topbar-nya partial bersama: tombolnya "Tambah Bot" (buka modal yang cuma
  // ada di /dashboard) dan judulnya "Dashboard". Di sini keduanya disesuaikan
  // biar nggak ada tombol yang diam total karena fungsinya nggak ada.
  const sapaan = document.getElementById('greeting');
  if (sapaan) sapaan.textContent = 'Command Manager';
  window.openAddBot = () => { location.href = '/dashboard'; };

  window.muatCommand = muatCommand;
  window.cmdHal = cmdHal;
  muatCommand();
})();
