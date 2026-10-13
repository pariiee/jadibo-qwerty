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

    // Batang harian: 7 hari penuh (isi 0 jika tidak ada aktivitas di hari tsb)
    const hariMap = new Map();
    (d.harian || []).forEach(h => {
      const k = String(h.tgl || '').slice(0, 10);
      hariMap.set(k, Number(h.n || 0));
    });

    const listHarian = [];
    const totalHari = Number(d.ringkas?.hari || 7);
    for (let i = totalHari - 1; i >= 0; i--) {
      const dt = new Date();
      dt.setDate(dt.getDate() - i);
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, '0');
      const day = String(dt.getDate()).padStart(2, '0');
      const k = `${y}-${m}-${day}`;
      listHarian.push({ tgl: k, n: hariMap.get(k) || 0 });
    }

    const chart = document.getElementById('chart');
    const totalCmdHarian = listHarian.reduce((acc, h) => acc + Number(h.n || 0), 0);
    const maks = Math.max(1, ...listHarian.map(h => Number(h.n || 0)));

    const sumEl = document.getElementById('chart-sum');
    if (sumEl) {
      sumEl.textContent = '7 Hari: ' + n(totalCmdHarian) + ' cmd • Puncak: ' + n(maks);
    }

    const W = 760, H = 220;
    const padL = 45, padR = 25, padT = 32, padB = 35;
    const cW = W - padL - padR;
    const cH = H - padT - padB;

    const pts = listHarian.map((h, i) => {
      const x = padL + (i / Math.max(1, listHarian.length - 1)) * cW;
      const r = maks > 0 ? Number(h.n || 0) / maks : 0;
      const y = padT + (1 - r) * cH;
      return { x, y, n: Number(h.n || 0), tgl: h.tgl };
    });

    function spline(p) {
      if (p.length < 2) return p.length === 1 ? `M ${p[0].x} ${p[0].y}` : '';
      let s = `M ${p[0].x.toFixed(1)} ${p[0].y.toFixed(1)}`;
      for (let i = 0; i < p.length - 1; i++) {
        const p0 = i > 0 ? p[i - 1] : p[i];
        const p1 = p[i];
        const p2 = p[i + 1];
        const p3 = i + 2 < p.length ? p[i + 2] : p2;
        const cp1x = p1.x + (p2.x - p0.x) / 6;
        const cp1y = p1.y + (p2.y - p0.y) / 6;
        const cp2x = p2.x - (p3.x - p1.x) / 6;
        const cp2y = p2.y - (p3.y - p1.y) / 6;
        s += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
      }
      return s;
    }

    const linePath = spline(pts);
    const bottomY = padT + cH;
    const areaPath = pts.length > 1
      ? `${linePath} L ${pts[pts.length - 1].x.toFixed(1)} ${bottomY} L ${pts[0].x.toFixed(1)} ${bottomY} Z`
      : '';

    let yGrid = '';
    [0, 0.5, 1].forEach(r => {
      const y = padT + (1 - r) * cH;
      const val = Math.round(r * maks);
      yGrid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--line)" stroke-width="1" />` +
        `<text x="${padL - 10}" y="${y + 4}" text-anchor="end" fill="var(--mute)" font-size="10.5" font-weight="600">${n(val)}</text>`;
    });

    let xGrid = '';
    pts.forEach(p => {
      xGrid += `<line x1="${p.x}" y1="${padT}" x2="${p.x}" y2="${bottomY}" stroke="var(--line)" stroke-dasharray="3,3" stroke-width="1" />` +
        `<text x="${p.x}" y="${H - 10}" text-anchor="middle" fill="var(--mute)" font-size="11" font-weight="700">${esc(tgl(p.tgl))}</text>`;
    });

    let nodes = '';
    pts.forEach(p => {
      nodes += `<g class="chart-point" tabindex="0">` +
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" fill="#818cf8" stroke="var(--card)" stroke-width="2.5" />` +
        `<g class="chart-tip" transform="translate(${p.x.toFixed(1)}, ${(p.y - 12).toFixed(1)})">` +
        `<rect x="-26" y="-25" width="52" height="23" rx="7" fill="#ffffff" filter="drop-shadow(0 4px 10px rgba(0,0,0,0.3))" />` +
        `<text x="0" y="-10" text-anchor="middle" fill="#0f172a" font-size="11" font-weight="800">${n(p.n)}</text>` +
        `<polygon points="-4,-3 4,-3 0,1" fill="#ffffff" />` +
        `</g>` +
        `</g>`;
    });

    chart.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" class="chart-svg" preserveAspectRatio="none">
        <defs>
          <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#818cf8" stop-opacity="0.45" />
            <stop offset="60%" stop-color="#6366f1" stop-opacity="0.12" />
            <stop offset="100%" stop-color="#6366f1" stop-opacity="0.0" />
          </linearGradient>
        </defs>
        ${yGrid}
        ${xGrid}
        ${areaPath ? `<path d="${areaPath}" fill="url(#areaGrad)" />` : ''}
        ${linePath ? `<path d="${linePath}" fill="none" stroke="#818cf8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />` : ''}
        ${nodes}
      </svg>
    `;
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
