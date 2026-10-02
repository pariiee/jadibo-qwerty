// Halaman Log Aktivitas (/log). Datanya dari GET /api/bots/:id/logs — endpoint
// itu sudah ada dan sudah ter-scope kepemilikan (dipakai modal log di /admin),
// jadi halaman ini nol endpoint baru.
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

  // Timestamp MySQL datang tanpa zona — sisipkan 'Z' supaya dibaca UTC, sama
  // seperti billing.js/bot-stats.js. Tanpa itu jamnya geser sebesar offset WIB.
  const jam = (v) => {
    if (!v) return '—';
    const s = /Z|[+-]\d\d:?$/.test(String(v)) ? v : String(v).replace(' ', 'T') + 'Z';
    const d = new Date(s);
    return isNaN(d) ? String(v) : d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  };

  let botId = null;

  async function isiPilihanBot() {
    const d = await api('/api/bots');
    const bots = d?.bots || [];
    const sel = document.getElementById('pilih-bot');
    const kosong = document.getElementById('log-kosong');
    if (!bots.length) {
      kosong.style.display = '';
      document.querySelector('.adm-bar').style.display = 'none';
      sel.innerHTML = '';
      return false;
    }
    kosong.style.display = 'none';
    sel.innerHTML = bots.map((b) => '<option value="' + b.id + '">' + esc(b.bot_name) + '</option>').join('');
    botId = bots[0].id;
    return true;
  }

  async function muatLogHalaman() {
    if (!botId) return;
    const pilih = document.getElementById('pilih-bot');
    if (pilih.value) botId = Number(pilih.value);

    const lv = document.getElementById('log-level').value;
    const term = document.getElementById('terminal');
    term.innerHTML = '<p class="log-line term-hint">// memuat…</p>';

    const d = await api('/api/bots/' + botId + '/logs?limit=200');
    if (!d?.ok) { term.innerHTML = '<p class="log-line term-hint">// gagal memuat log</p>'; return; }

    const logs = (d.logs || []).filter((l) => !lv || l.level === lv);
    if (!logs.length) {
      term.innerHTML = '<p class="log-line term-hint">// ' +
        (lv ? 'tidak ada log di level ini' : 'belum ada aktivitas') + '</p>';
      return;
    }
    // textContent, bukan innerHTML: isi log memuat teks yang dikirim user ke bot.
    term.innerHTML = '';
    logs.slice().reverse().forEach((l) => {
      const p = document.createElement('p');
      p.className = 'log-line log-' + (l.level || 'info');
      p.textContent = '[' + jam(l.created_at) + '] ' + l.message;
      term.appendChild(p);
    });
  }

  (async () => {
    if (!(await isiPilihanBot())) return;
    muatLogHalaman();
  })();

  // Topbar default-nya menulis "Dashboard" + tombol "Tambah Bot" — dua-duanya
  // salah di halaman ini. Pola yang sama dipakai command.js/profil.js/billing.js.
  document.getElementById('greeting').textContent = 'Log Aktivitas';


  // Topbar default-nya menulis "Dashboard" + tombol "Tambah Bot" — dua-duanya
  // salah di halaman ini. Pola yang sama dipakai command.js/profil.js/billing.js.
  const sapaan = document.getElementById('greeting');
  if (sapaan) sapaan.textContent = 'Log Aktivitas';
  window.openAddBot = () => { location.href = '/dashboard'; };
  window.muatLogHalaman = muatLogHalaman;
})();
