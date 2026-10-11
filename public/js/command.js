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
      html += '<span class="engine-badge wa" title="Mendukung WhatsApp"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm.01 1.67c2.2 0 4.26.86 5.82 2.42a8.23 8.23 0 0 1 2.41 5.83c0 4.54-3.7 8.24-8.24 8.24-1.42 0-2.82-.37-4.04-1.08l-.29-.17-3.01.79.8-2.93-.19-.3a8.21 8.21 0 0 1-1.26-4.37c0-4.54 3.7-8.24 8.24-8.24zm4.52 11.66c-.25-.13-1.47-.72-1.7-.81-.23-.08-.39-.13-.56.13-.17.25-.64.81-.79.97-.14.17-.29.19-.54.06-.25-.13-1.06-.39-2.02-1.25-.75-.67-1.26-1.5-1.41-1.75-.15-.25-.02-.39.11-.51.11-.11.25-.29.38-.44.13-.14.17-.25.25-.42.08-.17.04-.31-.02-.44-.06-.13-.56-1.35-.77-1.85-.2-.48-.41-.42-.56-.43h-.48c-.17 0-.44.06-.67.31-.23.25-.88.86-.88 2.1s.9 2.44 1.03 2.61c.13.17 1.77 2.7 4.28 3.79.6.26 1.07.41 1.43.53.6.19 1.15.16 1.58.1.48-.07 1.47-.6 1.68-1.18.21-.58.21-1.07.15-1.18-.06-.1-.23-.17-.48-.3z"/></svg></span>';
    }
    if (engines.includes('tele')) {
      html += '<span class="engine-badge tg" title="Mendukung Telegram"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 0 0-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .37z"/></svg></span>';
    }
    if (engines.includes('discord')) {
      html += '<span class="engine-badge dc" title="Mendukung Discord"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.894.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg></span>';
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
      <details class="cmd-row">
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
