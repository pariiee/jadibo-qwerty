// Halaman statistik bot. Nol WebSocket — angka di sini nggak perlu realtime,
// jadi cukup satu fetch pas buka + refresh manual. Live log ada di /config/:id.
(function () {
  const botId = (location.pathname.match(/\/(\d+)\/?$/) || [])[1];
  if (!botId) { location.href = '/dashboard'; return; }

  const waIcon = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12c0 1.85.5 3.58 1.37 5.07L2 22l5.09-1.34A9.95 9.95 0 0 0 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2z" fill="#25D366"/></svg>`;
  const tgIcon = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#229ED9"/></svg>`;

  async function api(path) {
    try {
      const res = await fetch(path, { credentials: 'include' });
      if (res.status === 401) { location.href = '/'; return null; }
      return res.json();
    } catch { return null; }
  }

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const n = (v) => Number(v || 0).toLocaleString('id-ID');
  const tgl = (v) => {
    if (!v) return '—';
    const s = /Z|[+-]\d\d:?\d\d$/.test(v) ? v : String(v).replace(' ', 'T') + 'Z';
    const d = new Date(s);
    return isNaN(d) ? String(v) : d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
  };
  const jam = (v) => {
    if (!v) return '—';
    const s = /Z|[+-]\d\d:?\d\d$/.test(v) ? v : String(v).replace(' ', 'T') + 'Z';
    const d = new Date(s);
    return isNaN(d) ? String(v) : d.toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  };

  function isiTabel(tbody, baris, kolom, kosong) {
    if (!baris.length) {
      tbody.innerHTML = '<tr><td colspan="' + kolom + '" class="muted">' + kosong + '</td></tr>';
      return;
    }
    tbody.innerHTML = baris.join('');
  }

  async function load() {
    const d = await api('/api/bots/' + botId + '/stats');
    if (!d?.ok) return;

    const r = d.ringkas;
    document.getElementById('st-cmd').textContent = n(r.cmd_total);
    document.getElementById('st-usr').textContent = n(r.user_aktif);
    document.getElementById('st-err').textContent = n(r.err_total);
    document.getElementById('st-lim').textContent = n(r.limit_total);

    isiTabel(document.querySelector('#tbl-cmd tbody'),
      d.cmd.map((c, i) => '<tr><td class="muted">' + (i + 1) + '</td><td><code>' + esc(c.cmd) +
        '</code></td><td style="text-align:right"><b>' + n(c.n) + '</b>' +
        (c.ms ? '<br><small class="muted">' + n(c.ms) + ' ms</small>' : '') + '</td></tr>'),
      3, 'Belum ada command yang tercatat.');

    isiTabel(document.querySelector('#tbl-usr tbody'),
      d.user.map((u, i) => '<tr><td class="muted">' + (i + 1) + '</td><td>' + esc(u.nama) +
        '</td><td class="muted">' + esc(u.grup || '—') + '</td>' +
        '<td style="text-align:right"><b>' + n(u.n) + '</b><br><small class="muted">' + n(u.ncmd) + ' cmd</small></td>' +
        '<td style="text-align:right" class="muted">' + jam(u.terakhir) + '</td></tr>'),
      5, 'Belum ada aktivitas user.');

    // Batang harian: lebar relatif ke hari paling ramai — nggak butuh chart lib.
    const chart = document.getElementById('chart');
    const maks = Math.max(1, ...d.harian.map(h => Number(h.n)));
    chart.innerHTML = d.harian.length
      ? d.harian.map(h =>
          '<div class="bar" title="' + esc(h.tgl) + ': ' + n(h.n) + ' command">' +
          '<div class="fill" style="height:' + Math.round(Number(h.n) / maks * 100) + '%"></div>' +
          '<span>' + esc(tgl(h.tgl)) + '</span></div>').join('')
      : '<p class="muted">Belum ada data.</p>';
  }

  (async () => {
    const d = await api('/api/bots/' + botId);
    if (!d?.ok) { alert('Bot tidak ditemukan'); location.href = '/dashboard'; return; }
    const b = d.bot;
    document.title = 'Statistik ' + b.bot_name + ' — qwertygate';
    document.getElementById('hdr-name').textContent = b.bot_name;
    document.getElementById('hdr-icon').innerHTML = b.platform === 'telegram' ? tgIcon(18) : waIcon(18);
    document.getElementById('btn-config').href = '/config/' + botId;

    // is_running = "user mau bot ini jalan", bukan "socket kebuka" — sama seperti
    // di halaman config, biar nggak kedip Offline tiap WA mutusin koneksi.
    const st = b.is_running ? 'connected' : b.status;
    const map = { connected: ['on', 'Online'], connecting: ['wait', 'Connecting'], qr_pending: ['wait', 'QR Pending'] };
    const [c, l] = map[st] || ['', 'Offline'];
    document.getElementById('hdr-dot').className = 'dot ' + c;
    document.getElementById('hdr-status').textContent = l;

    load();
  })();
})();
