// Halaman statistik bot. Nol WebSocket — angka di sini nggak perlu realtime,
// jadi cukup satu fetch pas buka + refresh manual. Live log ada di /config/:id.
(function () {
  // id bisa slug ATAU nomor lama — pakai helper bersama, jangan regex sendiri.
  const botId = botIdDariPath(location.pathname);
  if (!botId) { location.href = '/dashboard'; return; }

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

    const stRes = document.getElementById('st-res');
    if (stRes && d.bot) {
      const terpakai = Number(d.bot.receive_count || 0);
      const total = Number(d.bot.receive_limit || 0);
      stRes.textContent = total > 0 ? (n(Math.max(0, total - terpakai)) + ' sisa') : 'Tanpa batas';
      const sub = document.getElementById('st-res-sub');
      if (sub && total > 0) sub.textContent = 'dari total ' + n(total) + ' respon';
    }

    // Render 5 Command Paling Sering (Donut Chart & Legend seperti mockup)
    const WARNA_CMD = ['#f97316', '#3b82f6', '#a855f7', '#10b981', '#eab308'];
    const top5 = (d.cmd || []).slice(0, 5);
    const totalCmd = top5.reduce((acc, c) => acc + (c.n || 0), 0);
    const donutGraphic = document.getElementById('cmd-donut-graphic');
    const donutLegend = document.getElementById('cmd-donut-legend');

    if (donutGraphic && donutLegend) {
      if (!top5.length || totalCmd === 0) {
        donutGraphic.innerHTML = '<svg width="140" height="140" viewBox="0 0 140 140"><circle cx="70" cy="70" r="50" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="16"/><circle cx="70" cy="70" r="34" fill="rgba(0,0,0,0.1)"/></svg>';
        donutLegend.innerHTML = '<span class="muted" style="font-size:13px">Belum ada command yang tercatat.</span>';
      } else {
        const C = 2 * Math.PI * 50; // 314.16
        let offset = 0;
        let svgCircles = '';
        let legendHtml = '';

        top5.forEach((c, idx) => {
          const color = WARNA_CMD[idx % WARNA_CMD.length];
          const pct = Math.max(1, Math.round((c.n / totalCmd) * 100));
          const dash = (pct / 100) * C;
          const strokeWidth = idx === 0 ? 19 : 15; // segmen teratas menonjol tebal

          svgCircles += '<circle cx="70" cy="70" r="50" fill="none" stroke="' + color + '" stroke-width="' + strokeWidth + '" ' +
            'stroke-dasharray="' + dash + ' ' + C + '" stroke-dashoffset="' + (-offset) + '" ' +
            'transform="rotate(-90 70 70)" stroke-linecap="round" />';
          offset += dash;

          legendHtml += '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13.5px">' +
            '<div style="display:flex;align-items:center;gap:10px;min-width:0;overflow:hidden">' +
            '<span style="width:10px;height:10px;border-radius:50%;background:' + color + ';flex:none"></span>' +
            '<span style="font-weight:600;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(c.cmd) + '</span>' +
            '</div>' +
            '<div style="flex:none;color:var(--mute)">– <b style="color:var(--ink);font-weight:700">' + pct + '%</b></div>' +
            '</div>';
        });

        donutGraphic.innerHTML = '<svg width="140" height="140" viewBox="0 0 140 140" style="overflow:visible">' +
          '<circle cx="70" cy="70" r="50" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="15"/>' +
          '<circle cx="70" cy="70" r="34" fill="rgba(0,0,0,0.18)" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>' +
          svgCircles + '</svg>';
        donutLegend.innerHTML = legendHtml;
      }
    }

    const tblCmd = document.querySelector('#tbl-cmd tbody');
    if (tblCmd) {
      isiTabel(tblCmd, top5.map((c, i) => '<tr><td>' + (i + 1) + '</td><td>' + esc(c.cmd) + '</td><td>' + n(c.n) + '</td></tr>'), 3, '');
    }

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

      // Smooth Line Chart + Area Fill: cubic bezier terkontrol tanpa overshoot
      function spline(p) {
        if (p.length < 2) return p.length === 1 ? 'M ' + p[0].x.toFixed(1) + ' ' + p[0].y.toFixed(1) : '';
        let s = 'M ' + p[0].x.toFixed(1) + ' ' + p[0].y.toFixed(1);
        for (let i = 0; i < p.length - 1; i++) {
          const p1 = p[i];
          const p2 = p[i + 1];
          const dx = (p2.x - p1.x) * 0.4;
          const cp1x = p1.x + dx;
          const cp1y = p1.y;
          const cp2x = p2.x - dx;
          const cp2y = p2.y;
          s += ' C ' + cp1x.toFixed(1) + ' ' + cp1y.toFixed(1) + ', ' + cp2x.toFixed(1) + ' ' + cp2y.toFixed(1) + ', ' + p2.x.toFixed(1) + ' ' + p2.y.toFixed(1);
        }
        return s;
      }

      const linePath = spline(pts);
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
    document.getElementById('hdr-icon').innerHTML = platIcon(b.platform, 18);
    document.getElementById('btn-config').href = '/config/' + botHref(b);

    // is_running = "user mau bot ini jalan", bukan "socket kebuka" — sama seperti
    // di halaman config, biar nggak kedip Offline tiap WA mutusin koneksi.
    const st = b.is_running ? 'connected' : b.status;
    const map = { connected: ['on', 'Online'], connecting: ['wait', 'Connecting'], qr_pending: ['wait', 'QR Pending'] };
    const [c, l] = map[st] || ['', 'Offline'];
    document.getElementById('hdr-dot').className = 'dot ' + c;
    document.getElementById('hdr-status').textContent = l;

    load();
  })();

  window.tambahRespon = async function () {
    if (!confirm('Beli 1.000 kuota respon seharga Rp 500 dari saldo dompet?')) return;
    const btn = document.getElementById('btn-tambah-respon');
    if (btn) btn.disabled = true;
    try {
      const res = await fetch('/api/bots/' + botId + '/tambah-respon', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      const d = await res.json();
      if (!d?.ok) {
        alert(d?.message || 'Gagal menambah kuota respon');
        return;
      }
      alert(d.message);
      load();
    } catch {
      alert('Terjadi kesalahan koneksi');
    } finally {
      if (btn) btn.disabled = false;
    }
  };
})();
