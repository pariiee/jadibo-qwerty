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
      sumEl.textContent = totalHari + ' Hari: ' + n(totalCmdHarian) + ' cmd • Puncak: ' + n(maks);
    }

    // ── Chart Aktivitas Harian ────────────────────────────────────────────────
    // viewBox WAJIB sama dengan ukuran kotaknya. Dulu viewBox dipaku 760x300
    // padahal kartunya ~1150px lebar, dan `preserveAspectRatio="none"` memaksa
    // SVG mengisi seluruh ruang itu — isinya jadi diregang 1.48x horizontal &
    // 0.93x vertikal, sehingga garis, titik, dan teks kelihatan gepeng.
    let timerChart = null;

    function gambarChart() {
      // 20 = padding .chart (10px kiri + 10px kanan), 20 = 14px atas + 6px bawah.
      const W = Math.max(320, Math.round(chart.clientWidth - 20));
      const H = Math.max(200, Math.round(chart.clientHeight - 20));
      const padL = 48, padR = 20, padT = 44, padB = 40;
      const cW = W - padL - padR;
      const cH = H - padT - padB;
      const bottomY = padT + cH;

      const pts = listHarian.map((h, i) => {
        const x = padL + (i / Math.max(1, listHarian.length - 1)) * cW;
        const r = maks > 0 ? Number(h.n || 0) / maks : 0;
        const y = padT + (1 - r) * cH;
        return { x, y, n: Number(h.n || 0), tgl: h.tgl };
      });

      // Smooth Line Chart + Area Fill: tension .35 + polaritas monoton, meniru
      // Chart.js `tension`. Tanpa ini spline overshoot (naik-turun palsu) saat
      // nilai naik-turun tajam — apalagi kalau ada dua titik bernilai sama.
      const tension = 0.35;
      function spline(p, polarity) {
        if (p.length < 2) return p.length === 1 ? `M ${p[0].x} ${p[0].y}` : '';
        let s = `M ${p[0].x.toFixed(1)} ${p[0].y.toFixed(1)}`;
        for (let i = 0; i < p.length - 1; i++) {
          const p0 = p[i > 0 ? i - 1 : i];
          const p1 = p[i];
          const p2 = p[i + 1];
          const p3 = p[i + 2 < p.length ? i + 2 : i + 1];
          const d = [p1.x - p0.x, p1.y - p0.y, p2.x - p1.x, p2.y - p1.y, p3.x - p2.x, p3.y - p2.y];
          for (let k = 0; k < polarity.length; k++) {
            if (polarity[k] === 0) d[2 * k + 1] = d[2 * k + 3] = 0;
          }
          const cp1x = p1.x + (d[2] - d[0]) * tension / 3;
          const cp1y = p1.y + (d[3] - d[1]) * tension / 3;
          const cp2x = p2.x + (d[4] - d[2]) * tension / 3;
          const cp2y = p2.y + (d[5] - d[3]) * tension / 3;
          s += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
        }
        return s;
      }

      // Polaritas tiap titik (sign perubahan nilai) — dipakai spline.
      const polarity = pts.map((p, i) => {
        if (i === 0) return pts.length > 1 ? Math.sign(pts[1].n - p.n) : 0;
        if (i === pts.length - 1) return Math.sign(p.n - pts[i - 1].n);
        return Math.sign(p.n - pts[i - 1].n) || Math.sign(pts[i + 1].n - p.n);
      });

      const linePath = spline(pts, polarity);
      const areaPath = pts.length > 1
        ? `${linePath} L ${pts[pts.length - 1].x.toFixed(1)} ${bottomY} L ${pts[0].x.toFixed(1)} ${bottomY} Z`
        : '';

      let yGrid = '';
      [0, 0.5, 1].forEach(r => {
        const y = (padT + (1 - r) * cH).toFixed(1);
        const val = Math.round(r * maks);
        yGrid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--line)" stroke-width="1" />` +
          `<text x="${padL - 10}" y="${y}" dy="4" text-anchor="end" fill="var(--mute)" font-size="10.5" font-weight="600">${n(val)}</text>`;
      });

      // Pilih maksimal 7 titik tanggal pada sumbu X agar teks tidak bertumpuk
      const maxTicks = 7;
      const tickIndices = new Set();
      if (pts.length <= maxTicks) {
        pts.forEach((_, i) => tickIndices.add(i));
      } else {
        const step = (pts.length - 1) / (maxTicks - 1);
        for (let i = 0; i < maxTicks; i++) tickIndices.add(Math.round(i * step));
      }

      // Sumbu X: cuma label tanggal (tanpa garis vertikal) — sama seperti referensi
      // `scales.x.grid.display = false`. Garis vertikal bikin area fill kelihatan penuh coretan.
      let xLabels = '';
      pts.forEach((p, idx) => {
        if (tickIndices.has(idx)) {
          xLabels += `<text x="${p.x.toFixed(1)}" y="${H - 12}" text-anchor="middle" fill="var(--mute)" font-size="11" font-weight="600">${esc(tgl(p.tgl))}</text>`;
        }
      });

      let nodes = '';
      pts.forEach(p => {
        nodes += `<g class="chart-point" tabindex="0">` +
          `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5" fill="#3b82f6" stroke="#ffffff" stroke-width="2" />` +
          `<g class="chart-tip" transform="translate(${p.x.toFixed(1)}, ${(p.y - 14).toFixed(1)})">` +
          `<rect x="-34" y="-27" width="68" height="24" rx="8" fill="#1a1a19" />` +
          `<text x="0" y="-11" text-anchor="middle" fill="#e5e5e5" font-size="11" font-weight="600">${n(p.n)} cmd</text>` +
          `<polygon points="-4,-4 4,-4 0,0" fill="#1a1a19" />` +
          `</g>` +
          `</g>`;
      });

      chart.innerHTML = `
        <svg viewBox="0 0 ${W} ${H}" class="chart-svg">
          ${yGrid}
          ${xLabels}
          <path d="${areaPath}" fill="#3b82f6" fill-opacity=".12" />
          ${linePath ? `<path d="${linePath}" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />` : ''}
          ${nodes}
        </svg>
      `;
    }

    gambarChart();
    window.addEventListener('resize', () => {
      clearTimeout(timerChart);
      timerChart = setTimeout(gambarChart, 150);
    });
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
