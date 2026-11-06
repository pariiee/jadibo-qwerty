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
    hasil = semua.filter((c) =>
      (!kat || c.kategori === kat) &&
      (!q || c.nama.includes(q) || c.label.toLowerCase().includes(q) ||
        c.alias.some((a) => a.includes(q)))
    );
    hal = 1;
    gambar();
  }

  function renderEngines(engines) {
    if (!engines || !engines.length) engines = ['wa'];
    let html = '<div class="cmd-engines">';
    if (engines.includes('wa')) {
      html += '<span class="engine-badge eb-wa" title="WhatsApp"><svg width="14" height="14" viewBox="0 0 24 24"><path fill="#25D366" d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2z"/><path fill="#fff" d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.95 1.17-.17.2-.35.22-.65.07-.3-.15-1.27-.47-2.42-1.49-.89-.8-1.5-1.78-1.67-2.08-.17-.3-.02-.46.13-.61.13-.14.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.68-1.63-.93-2.23-.24-.6-.49-.51-.67-.52h-.58c-.2 0-.52.07-.79.37-.27.3-1.03 1.01-1.03 2.46s1.06 2.86 1.2 3.06c.15.2 2.08 3.18 5.04 4.46.7.3 1.25.48 1.68.62.71.22 1.35.19 1.86.12.57-.09 1.76-.72 2.01-1.42.25-.7.25-1.3.17-1.42-.07-.13-.27-.2-.57-.35z"/></svg></span>';
    }
    if (engines.includes('tele')) {
      html += '<span class="engine-badge eb-tg" title="Telegram"><svg width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#229ED9"/><path d="M17.5 7.5 14.7 16.7c-.2.6-.8.8-1.3.5l-2.5-1.9-1.2 1.1c-.1.1-.3.2-.5.2l.2-2.7 5.2-4.7c.2-.2 0-.3-.3-.1L7.2 12.9 4.8 12c-.6-.2-.6-.6.1-.9l12-4.6c.5-.2.9.1.6.1z" fill="#fff"/></svg></span>';
    }
    if (engines.includes('discord')) {
      html += '<span class="engine-badge eb-dc" title="Discord"><svg width="14" height="14" viewBox="0 0 24 24"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.894.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg></span>';
    }
    html += '</div>';
    return html;
  }

  function gambar() {
    const list = document.getElementById('cmd-daftar');
    const halaman = Math.max(1, Math.ceil(hasil.length / PER_HAL));
    if (hal > halaman) hal = halaman;
    const potong = hasil.slice((hal - 1) * PER_HAL, hal * PER_HAL);

    // Klik baris = buka detail (deskripsi + alias). <details> bawaan browser,
    // jadi nol JavaScript buat buka/tutupnya.
    list.innerHTML = potong.map((c) => `
      <details class="cmd-row" name="cmd-item">
        <summary>
          <div class="cmd-kiri">
            <code class="cmd-nama">${esc(c.prefix)}</code>
            <span class="cmd-kat">${esc(c.label)}</span>
          </div>
          <div class="cmd-kanan">
            ${renderEngines(c.engines)}
            <span class="cmd-panah" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </span>
          </div>
        </summary>
        <div class="cmd-isi">
          <p class="cmd-desk">${esc(c.deskripsi || 'Belum ada keterangan untuk command ini.')}</p>
          ${c.alias.length ? `<div class="cmd-alias">
            <span class="cmd-alias-lbl">Alias</span>
            ${c.alias.map((a) => `<code class="cmd-alias-item">.${esc(a)}</code>`).join('')}
          </div>` : ''}
        </div>
      </details>`).join('');

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
    const bnr = document.getElementById('cmd-hitung-banner');
    if (bnr) bnr.textContent = `${d.total} Command`;
    document.getElementById('cmd-kategori').innerHTML =
      '<option value="">Semua Kategori</option>' +
      d.kategori.map((k) => `<option value="${esc(k.kunci)}">${esc(k.label)} (${k.jumlah})</option>`).join('');
    document.getElementById('cmd-hitung').textContent = `${d.total} command`;
    saring();
  }

  document.getElementById('cmd-cari').oninput = saring;
  document.getElementById('cmd-kategori').onchange = saring;

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
