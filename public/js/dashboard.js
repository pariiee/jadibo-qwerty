(function () {
  let me = null;
  function typeWriter(el, text, speed) {
    if (!el || !text) return;
    let i = 0, isDeleting = false;

    function tick() {
      if (isDeleting) {
        if (i > 0) {
          i--;
          el.textContent = text.slice(0, i);
          setTimeout(tick, 35);
        } else {
          isDeleting = false;
          setTimeout(tick, 600);
        }
      } else {
        if (i < text.length) {
          i++;
          el.textContent = text.slice(0, i);
          setTimeout(tick, speed || 60);
        } else {
          isDeleting = true;
          setTimeout(tick, 3500);
        }
      }
    }
    tick();
  }

  async function whoami() {
    const d = await api('/api/auth/me');
    if (!d?.ok) { location.href = '/'; return null; }
    me = d.user;
    const tn = document.getElementById('top-name');
    if (tn) tn.textContent = 'Hai, ' + me.username + '!';
    const tr = document.getElementById('top-role');
    if (tr) tr.textContent = me.is_admin ? 'Admin' : (me.plan_aktif ? (me.slots || 1) + ' Slot' : 'Belum ada paket');
    const topAv = document.getElementById('top-avatar-txt');
    if (topAv) topAv.textContent = (me.username || '?')[0].toUpperCase();
    document.getElementById('greeting').textContent   = 'Selamat Datang Kembali, ' + me.username;
    const hg = document.getElementById('hero-greeting');
    if (hg) {
      hg.innerHTML = '<span class="bt-hello">Selamat datang kembali,</span><span class="bt-name" id="hero-name"></span>';
      typeWriter(document.getElementById('hero-name'), me.username);
      setTimeout(() => {
        const hn = document.getElementById('hero-name');
        if (hn && !hn.textContent.trim()) hn.textContent = me.username;
      }, 2000);
    }
    if (me.is_admin) document.getElementById('nav-admin').style.display = '';
    const nd = document.getElementById('nav-dashboard');
    if (nd) nd.classList.add('on', 'active');

    document.body.classList.toggle('is-kawula', !!me.is_superadmin);

    if (me.is_superadmin) {
      ['nav-command', 'nav-log', 'nav-panduan'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });

      const btnAdd = document.getElementById('dx-add');
      if (btnAdd) btnAdd.style.display = 'none';
      const heroLead = document.querySelector('.bt-hero .bt-lead');
      if (heroLead) heroLead.textContent = 'Monitoring telemetri ekosistem qwertygate, omzet transaksi, dan performa server.';
      const trialBtn = document.querySelector('.bt-peach .bt-pill-btn');
      if (trialBtn) trialBtn.style.display = 'none';
      const promoCard = document.querySelector('.bt-promo');
      if (promoCard) promoCard.style.display = 'none';

      const popMenu = document.querySelector('.pop-menu');
      if (popMenu) {
        ['/billing', '/saldo', '/pricing'].forEach(href => {
          const el = popMenu.querySelector(`a[href="${href}"]`);
          if (el) el.remove();
        });
        const elPortal = document.getElementById('pop-admin-portal');
        if (elPortal) elPortal.remove();
      }
    }

    renderStats();
    return me;
  }

  async function api(path, opts = {}) {
    try {
      const res = await fetch(path, {
        ...opts,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
      });
      if (res.status === 401) { location.href = '/'; return null; }
      return res.json();
    } catch { return null; }
  }
  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
    location.href = '/';
  }

  let bots = [];
  let botKuota = new Map();
  let maxSlots = 2;

  function renderSkeletons() {
    const grid = document.getElementById('bot-grid');
    if (!grid || bots.length) return;
    grid.innerHTML = [1, 2].map(() => `
      <article class="bt-tile bt-k bt-bot bt-s3 bt-r2 bt-skeleton">
        <div class="bt-row" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <div style="width:76px;height:24px;border-radius:999px;background:#E4E4E7"></div>
          <div style="width:60px;height:24px;border-radius:999px;background:#E4E4E7"></div>
        </div>
        <div style="width:65%;height:22px;border-radius:6px;background:#E4E4E7;margin:4px 0 8px"></div>
        <div style="width:85%;height:14px;border-radius:4px;background:#E4E4E7;margin-bottom:16px"></div>
        <div style="width:100%;height:44px;border-radius:10px;background:#F4F3FF;margin-bottom:14px;border:1px solid #E4E4E7"></div>
        <div class="bt-row bt-m" style="display:flex;justify-content:space-between;align-items:center;margin-top:auto;padding-top:10px">
          <div style="width:30%;height:14px;border-radius:4px;background:#E4E4E7"></div>
          <div style="width:25%;height:14px;border-radius:4px;background:#E4E4E7"></div>
        </div>
        <div class="bt-btns" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px">
          <div style="height:36px;border-radius:999px;background:#151515;opacity:0.12"></div>
          <div style="height:36px;border-radius:999px;background:#151515;opacity:0.12"></div>
        </div>
      </article>
    `).join('');
  }

  async function loadBots() {
    renderSkeletons();
    const [dBots, dKuota] = await Promise.all([
      api('/api/bots'),
      api('/api/kuota')
    ]);
    maxSlots = me?.slots_max ?? (me?.is_admin ? 999 : 0);
    if (!dBots?.ok) { renderStats(); return; }
    bots = dBots.bots || [];
    botKuota = new Map((dKuota?.bots || []).map(k => [k.id, k]));
    renderSlots();
    renderStats();
    renderBots();
  }

  function renderSlots() {
    const used = bots.length;
    const beli = me?.slots_beli ?? maxSlots;
    document.getElementById('slot-text').textContent = me?.is_admin ? `${used} / \u221e` : `${used} / ${beli}`;

    const elSlot = document.getElementById('st-slot');
    elSlot.textContent = me?.is_admin ? '0' : String(beli);
    elSlot.className = 'bt-v' + (beli > 0 && used >= beli ? ' warn' : '');
    document.getElementById('st-slot-sub').textContent =
      me?.is_admin ? `Tak terbatas \u00b7 ${used} terpakai`
      : beli === 0 ? 'Belum ada slot \u2014 klaim Trial atau beli paket'
      : used >= beli ? `Slot penuh \u2014 ${used} dari ${beli} terpakai`
      : `Sisa ${beli - used} slot lagi dari ${beli}`;
  }

  function renderPeringatan() {
    const el = document.getElementById('kuota-alert');
    if (!el) return;

    const baris = [];

    for (const b of bots) {
      const batas = Number(b.receive_limit) || 0;
      if (batas <= 0) continue;
      const pakai = Number(b.received_count) || 0;
      const persen = Math.round((pakai / batas) * 100);
      if (persen < 80) continue;

      const habis = pakai >= batas;
      const nama = b.bot_name || `bot #${b.id}`;
      baris.push({
        kritis: habis,
        teks: habis
          ? `<b>${esc(nama)}</b> — kuota pesannya <b>habis</b>. Bot berhenti membalas sampai paket ditambah.`
          : `<b>${esc(nama)}</b> — kuota pesan tinggal <b>${(batas - pakai).toLocaleString('id-ID')}</b> (${persen}% terpakai).`,
      });
    }

    const exp = me.plan_expired_at ? new Date(me.plan_expired_at) : null;
    const hari = exp ? Math.ceil((exp - Date.now()) / 86400000) : null;
    if (me.plan_aktif && hari !== null && hari <= 3) {
      baris.push({
        kritis: hari <= 0,
        teks: hari <= 0
          ? 'Masa aktif paketmu <b>sudah habis</b>. Bot dimatikan otomatis sampai paket diperpanjang.'
          : `Masa aktif paketmu tinggal <b>${hari} hari</b>.`,
      });
    } else if (me.trial_used && !me.plan_aktif) {
      baris.push({ kritis: true, teks: 'Paketmu <b>tidak aktif</b>. Bot berhenti membalas sampai paket diperpanjang.' });
    }

    if (!baris.length) { el.style.display = 'none'; el.innerHTML = ''; return; }

    baris.sort((a, b) => Number(b.kritis) - Number(a.kritis));

    el.className = 'kuota-alert' + (baris.some((x) => x.kritis) ? ' kritis' : '');
    el.innerHTML =
      baris.map((x) => `<div class="kuota-alert-baris">${x.kritis ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'} <span>${x.teks}</span></div>`).join('') +
      '<div class="kuota-alert-aksi"><a class="btn btn-outline btn-sm" href="/pricing">Tambah Kuota / Perpanjang</a>' +
      '<a class="btn btn-outline btn-sm" href="/kuota">Lihat Kuota</a></div>';
    el.style.display = '';
  }

  function renderStats() {
    const txt = (id, v, cls) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = v;
      el.className = 'val' + (cls ? ' ' + cls : '');
    };

    if (me?.is_superadmin) {
      const lbOnline = document.querySelector('.bt-purple .bt-lb');
      if (lbOnline) lbOnline.innerHTML = '<span class="bt-ic"><svg class="i" viewBox="0 0 24 24"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></span>Total Omzet';

      const lbRole = document.querySelector('.bt-lav .bt-lb');
      if (lbRole) lbRole.innerHTML = '<span class="bt-ic"><svg class="i" viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></span>RAM Server';

      const lbSlot = document.querySelector('.bt-sky .bt-lb');
      if (lbSlot) lbSlot.innerHTML = '<span class="bt-ic"><svg class="i" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg></span>Disk Server';

      const lbExp = document.querySelector('.bt-peach .bt-lb');
      if (lbExp) lbExp.innerHTML = '<span class="bt-ic"><svg class="i" viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/></svg></span>Transaksi';

      const updateSys = () => {
        api('/api/admin/pendapatan').then(d => {
          if (d?.ok && d.ringkas) {
            txt('st-online', 'Rp ' + Number(d.ringkas.total_lunas || 0).toLocaleString('id-ID'), 'ok');
            const subOnline = document.getElementById('st-online-sub');
            if (subOnline) subOnline.textContent = (d.ringkas.jumlah_lunas || 0) + ' transaksi berhasil';

            txt('st-exp', (d.ringkas.jumlah_lunas || 0) + ' Order', 'ok');
            const subExp = document.getElementById('st-exp-sub');
            if (subExp) subExp.textContent = (d.ringkas.jumlah_pending || 0) + ' order pending';
          }
        });

        api('/api/admin/sistem').then(d => {
          if (d?.ok && d.resource) {
            const r = d.resource.ram;
            const dk = d.resource.disk;
            const ramPct = r ? Math.round((r.terpakai / r.total) * 100) : 0;
            const diskPct = dk ? Math.round((dk.terpakai / dk.total) * 100) : 0;

            txt('st-role', ramPct + '%', ramPct > 85 ? 'warn' : 'ok');
            const subRole = document.getElementById('st-role-sub');
            if (subRole && r) subRole.textContent = Math.round(r.terpakai / 1048576) + ' MB / ' + Math.round(r.total / 1048576) + ' MB';

            txt('st-slot', diskPct + '%', diskPct > 85 ? 'warn' : 'ok');
            const subSlot = document.getElementById('st-slot-sub');
            if (subSlot && dk) subSlot.textContent = (dk.terpakai / 1073741824).toFixed(1) + ' GB / ' + (dk.total / 1073741824).toFixed(1) + ' GB';
          }
        });
      };

      updateSys();
      if (!window._sysPollInterval) {
        window._sysPollInterval = setInterval(() => {
          if (!document.hidden) updateSys();
        }, 3000);
      }

      renderPeringatan();
      return;
    }

    txt('st-role', me.is_admin ? 'Staff' : (me.plan_aktif ? (me.slots || 1) + ' Slot' : '0 Slot'));
    document.getElementById('st-role-sub').textContent = me.is_admin
      ? 'Akses Staff Bot Manager'
      : (me.plan_aktif ? 'Slot bot aktif' : 'Belum ada slot aktif');

    const exp = me.plan_expired_at ? new Date(me.plan_expired_at) : null;
    const hari = exp ? Math.ceil((exp - Date.now()) / 86400000) : null;
    if (me.plan_aktif && exp) {
      txt('st-exp', exp.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }), hari <= 3 ? 'warn' : 'ok');
      document.getElementById('st-exp-sub').textContent = hari <= 0 ? 'Berakhir hari ini' : `Sisa ${hari} hari`;
    } else if (me.trial_used) {
      txt('st-exp', 'Tidak ada', 'dim');
      document.getElementById('st-exp-sub').textContent = 'Paket berakhir \u2014 perpanjang di halaman Pricing';
    } else {
      txt('st-exp', 'Tidak ada', 'dim');
      document.getElementById('st-exp-sub').textContent = `Belum ambil paket \u2014 klaim Trial ${me.trial_hari ?? 3} hari gratis`;
    }

    const online = bots.filter(b => b.is_running).length;
    txt('st-online', String(online), online ? 'ok' : 'dim');
    document.getElementById('st-online-sub').textContent = bots.length
      ? `dari ${bots.length} bot kamu` : 'Belum ada bot';

    renderPeringatan();
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  let btAnimated = false;

  function renderSide() {
    const pips = document.getElementById('bt-pips');
    if (!pips) return;
    if (me?.is_superadmin) {
      pips.innerHTML = '';
      return;
    }
    const used = bots.length;
    const unlimited = !!(me && me.is_admin);
    const cap = unlimited ? 0 : (me && me.plan_aktif ? (me.slots || 1) : 0);
    let h = '';
    for (let i = 0; i < Math.min(used, 8); i++) h += '<i></i>';
    if (unlimited) h += '<i class="bt-inf">\u221e</i>';
    else for (let i = used; i < Math.min(cap, 8); i++) h += '<i class="bt-empty"></i>';
    pips.innerHTML = h;
  }

  function renderBots() {
    const grid = document.getElementById('bot-grid');
    grid.innerHTML = '';

    if (me?.is_superadmin) {
      const tileChart = document.createElement('article');
      tileChart.id = 'super-tile-chart';
      tileChart.className = 'bt-tile bt-k bt-s6 bt-r2 bt-lime bt-anim';
      tileChart.style.minHeight = '280px';
      tileChart.innerHTML =
        '<div class="bt-row"><span class="bt-pill">Grafik Sistem</span><span class="bt-pill bt-on">14 Hari Terakhir</span></div>' +
        '<div style="margin:8px 0 16px"><h3 style="font-size:18px;font-weight:800;letter-spacing:-.02em">Omzet & Pertumbuhan Penjualan</h3>' +
        '<p class="bt-d" style="font-size:12.5px;color:var(--bt-mute)">Grafik akumulasi transaksi dan nominal gateway realtime.</p></div>' +
        '<div id="super-chart" style="width:100%;height:140px;display:flex;align-items:flex-end;gap:6px;padding-top:10px;border-bottom:2px solid #151515"></div>' +
        '<div id="super-chart-labels" style="width:100%;display:flex;justify-content:space-between;padding-top:6px;font-size:10.5px;font-weight:700;color:#151515"></div>';
      grid.appendChild(tileChart);

      const tileTable = document.createElement('article');
      tileTable.id = 'super-tile-table';
      tileTable.className = 'bt-tile bt-k bt-s6 bt-r2 bt-lav bt-anim';
      tileTable.style.minHeight = '280px';
      tileTable.innerHTML =
        '<div class="bt-row"><span class="bt-pill">Aktivitas</span><span class="bt-pill bt-on">Realtime</span></div>' +
        '<div style="margin:8px 0 12px"><h3 style="font-size:18px;font-weight:800;letter-spacing:-.02em">Transaksi Terbaru</h3>' +
        '<p class="bt-d" style="font-size:12.5px;color:var(--bt-mute)">Daftar order masuk terbaru di ekosistem qwertygate.</p></div>' +
        '<div class="tbl-wrap" style="width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;margin-top:auto">' +
          '<table style="width:100%;border-collapse:collapse;font-size:12px;font-weight:600;color:#151515;text-align:left">' +
            '<thead><tr style="border-bottom:2px solid #151515"><th style="padding:6px 8px">ID ORDER</th><th style="padding:6px 8px">NOMINAL</th><th style="padding:6px 8px">STATUS</th><th style="padding:6px 8px">WAKTU</th></tr></thead>' +
            '<tbody id="super-order-rows"><tr><td colspan="4" style="padding:12px;text-align:center;color:var(--bt-mute)">Memuat transaksi...</td></tr></tbody>' +
          '</table>' +
        '</div>';
      grid.appendChild(tileTable);

      const updateSuperGrid = () => {
        api('/api/admin/pendapatan').then(d => {
          if (!d?.ok || !d.seri) return;
          const chartEl = document.getElementById('super-chart');
          const lblEl = document.getElementById('super-chart-labels');
          if (!chartEl) return;
          const maxVal = Math.max(...d.seri.map(s => s.total), 1);
          chartEl.innerHTML = d.seri.map(s => {
            const pct = Math.max(4, Math.round((s.total / maxVal) * 100));
            const hasVal = s.total > 0;
            return `<div title="${s.tgl}: Rp ${Number(s.total).toLocaleString('id-ID')} (${s.jumlah} order)" style="flex:1;height:${pct}%;background:${hasVal ? '#151515' : '#D4D4D8'};border-radius:4px 4px 0 0;transition:height .3s;min-width:12px;cursor:pointer"></div>`;
          }).join('');
          if (lblEl) {
            const first = d.seri[0]?.tgl?.slice(5) || '';
            const mid = d.seri[Math.floor(d.seri.length / 2)]?.tgl?.slice(5) || '';
            const last = d.seri[d.seri.length - 1]?.tgl?.slice(5) || '';
            lblEl.innerHTML = `<span>${first}</span><span>${mid}</span><span>${last}</span>`;
          }
        });

        api('/api/admin/billing/orders').then(d => {
          const tbody = document.getElementById('super-order-rows');
          if (!tbody || !d?.ok || !d.orders) return;
          const rows = d.orders.slice(0, 5);
          if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="4" style="padding:12px;text-align:center">Belum ada transaksi</td></tr>';
            return;
          }
          tbody.innerHTML = rows.map(o => {
            const isPaid = o.status === 'paid';
            const badgeBg = isPaid ? '#10B981' : '#F59E0B';
            const badgeTxt = isPaid ? 'Lunas' : 'Pending';
            const tgl = new Date(o.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) + ' · ' + new Date(o.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
            return `<tr style="border-bottom:1px solid rgba(0,0,0,0.08)">
              <td style="padding:8px 8px;font-family:monospace;font-weight:700">${esc(String(o.order_id || o.id).slice(0, 14))}</td>
              <td style="padding:8px 8px;font-weight:800">Rp ${Number(o.amount || 0).toLocaleString('id-ID')}</td>
              <td style="padding:8px 8px"><span style="background:${badgeBg};color:#fff;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:800;text-transform:uppercase">${badgeTxt}</span></td>
              <td style="padding:8px 8px;font-size:11px;color:var(--bt-mute)">${tgl}</td>
            </tr>`;
          }).join('');
        });
      };

      updateSuperGrid();
      if (!window._superGridInterval) {
        window._superGridInterval = setInterval(() => {
          if (!document.hidden) updateSuperGrid();
        }, 5000);
      }

      btAnimated = true;
      renderSide();
      return;
    }

    const PL = {
      whatsapp: { c: 'bt-lime', n: 'WhatsApp', s: 'bt-s-wa' },
      telegram: { c: 'bt-sky',  n: 'Telegram', s: 'bt-s-tg' },
      discord:  { c: 'bt-lav',  n: 'Discord',  s: 'bt-s-dc' }
    };

    bots.forEach((bot, i) => {
      const p = PL[bot.platform] || PL.whatsapp;
      const on = bot.is_running;
      const stTxt = on ? 'Online' : (bot.status === 'connecting' ? 'Connecting' : 'Offline');
      const k = botKuota.get(bot.id);

      let kuotaHtml = '';
      if (k && k.tanpaBatas) {
        kuotaHtml = '<div class="bt-q"><div class="bt-row"><span>Kuota pesan</span><b>Tanpa batas</b></div>' +
          '<div class="bt-bar"><i style="width:100%"></i></div></div>';
      } else if (k && k.paketAktif) {
        const w = k.persen >= 95 ? 'var(--errTxt)' : (k.persen >= 80 ? 'var(--warn)' : 'var(--bt-purple)');
        kuotaHtml = '<div class="bt-q"><div class="bt-row"><span>Kuota pesan</span><b>' +
          Number(k.sisa || 0).toLocaleString('id-ID') + ' / ' + Number(k.batas || 0).toLocaleString('id-ID') + '</b></div>' +
          '<div class="bt-bar"><i style="width:' + Math.min(100, k.persen) + '%;background:' + w + '"></i></div>' +
          '<small>' + k.persen + '% terpakai</small></div>';
      } else if (k && !k.paketAktif) {
        kuotaHtml = '<div class="bt-q"><div class="bt-row"><span>Kuota pesan</span><b style="color:var(--errTxt)">Paket Berakhir</b></div>' +
          '<small>Perpanjang di menu Pricing</small></div>';
      }

      const card = document.createElement('article');
      card.className = 'bt-tile bt-k bt-bot bt-s3 bt-r2 ' + p.c + (btAnimated ? '' : ' bt-anim');
      if (!btAnimated) card.style.animationDelay = (300 + i * 70) + 'ms';
      card.innerHTML =
        '<div class="bt-row"><span class="bt-pill">' + esc(p.n) + '</span>' +
          '<span class="bt-pill' + (on ? ' bt-on' : '') + '">' + stTxt + '</span></div>' +
        '<span class="bt-stk"><svg viewBox="0 0 64 64" aria-hidden="true"><use href="#' + p.s + '"/></svg></span>' +
        '<div><h3>' + esc(bot.bot_name) + '</h3>' +
          '<p class="bt-d">' + (bot.description ? esc(bot.description) : 'Tidak ada deskripsi') + '</p></div>' +
        kuotaHtml +
        '<div class="bt-row bt-m"><span>Prefix <b>' + esc(bot.prefix) + '</b></span>' +
          '<span>' + esc(new Date(bot.created_at).toLocaleDateString('id-ID')) + '</span></div>' +
        '<div class="bt-btns"><button type="button" class="bt-pri" data-cfg>Config</button>' +
          '<button type="button" data-stat>Statistik</button></div>';

      grid.appendChild(card);
      card.querySelector('[data-cfg]').onclick = (e) => { e.stopPropagation(); location.href = '/config/' + botHref(bot); };
      card.querySelector('[data-stat]').onclick = (e) => { e.stopPropagation(); location.href = '/bot/' + botHref(bot); };
    });

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'bt-tile bt-add bt-s3 bt-r2' + (btAnimated ? '' : ' bt-anim');
    if (!btAnimated) add.style.animationDelay = (300 + bots.length * 70) + 'ms';
    const slotDesc = (me && me.is_admin) ? (bots.length + ' / \u221e slot terpakai') : (bots.length + ' / ' + (me && me.slots ? me.slots : 1) + ' slot terpakai');
    add.innerHTML = '<span class="bt-pl"><svg class="i" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></span><span>Tambah bot</span><small style="font-size:12px;color:var(--bt-mute);font-weight:600">' + esc(slotDesc) + '</small>';
    add.onclick = openAddBot;
    grid.appendChild(add);

    btAnimated = true;
    renderSide();
  }

  let platform = 'whatsapp';
  function openAddBot() {
    if (maxSlots === 0) {
      if (me && !me.trial_used) {
        if (confirm('Akun Anda belum memiliki slot bot.\nKlaim Trial 3 Hari sekarang gratis?')) {
          klaimTrialAction();
        }
        return;
      }
      location.href = '/pricing';
      return;
    }
    if (bots.length >= maxSlots) { alert('Slot penuh. Maksimal ' + maxSlots + ' bot per akun.'); return; }
    platform = 'whatsapp';
    setPlatUI();
    showStep('platform');
    document.getElementById('add-overlay').classList.add('show');
  }

  async function klaimTrialAction() {
    try {
      const res = await api('/api/billing/trial', { method: 'POST' });
      if (res && res.ok) {
        alert(res.message || 'Trial 3 hari berhasil aktif!');
        location.reload();
      } else {
        alert(res?.message || 'Gagal klaim trial.');
      }
    } catch (e) {
      alert('Error klaim trial: ' + e.message);
    }
  }
  function closeAdd() { document.getElementById('add-overlay').classList.remove('show'); }
  function showStep(s) {
    document.getElementById('step-platform').style.display = s === 'platform' ? '' : 'none';
    document.getElementById('step-form').style.display     = s === 'form' ? '' : 'none';
  }
  function backStep() { showStep('platform'); }
  function pickPlatform(p) { platform = p; setPlatUI(); showStep('form'); }
  function setPlatUI() {
    document.getElementById('plat-wa').classList.toggle('sel', platform === 'whatsapp');
    document.getElementById('plat-tg').classList.toggle('sel', platform === 'telegram');
    const platDc = document.getElementById('plat-dc');
    if (platDc) platDc.classList.toggle('sel', platform === 'discord');
    document.getElementById('form-badge').textContent = platform;
    const isTg = platform === 'telegram';
    const isDc = platform === 'discord';
    const isTokenBased = isTg || isDc;
    const wToken = document.getElementById('wrap-token');
    const wBotnum = document.getElementById('wrap-botnum');
    if (wToken) wToken.style.setProperty('display', isTokenBased ? 'flex' : 'none', 'important');
    if (wBotnum) wBotnum.style.setProperty('display', isTokenBased ? 'none' : 'flex', 'important');
    const lbl = document.getElementById('lbl-owner');
    const inp = document.getElementById('f-owner');
    const hint = document.getElementById('hint-owner');
    const tokenLbl = document.querySelector('label[for="f-token"]');
    const tokenInp = document.getElementById('f-token');
    const hintToken = document.getElementById('hint-token');

    const hiddenPfx = document.getElementById('f-prefix');
    const chipWrap = document.getElementById('f-pfx-chips');
    const setPfxVal = (v) => {
      if (hiddenPfx) hiddenPfx.value = v;
      if (chipWrap) {
        const arr = String(v || '').split('');
        chipWrap.querySelectorAll('.pfx-chip').forEach(c => c.classList.toggle('active', arr.includes(c.dataset.pfx)));
      }
    };

    if (isTg) {
      if (tokenLbl) tokenLbl.textContent = 'Token Telegram Bot *';
      if (tokenInp) tokenInp.placeholder = '123456:ABC-DEF...';
      if (hintToken) hintToken.innerHTML = 'Ambil token via <a href="https://t.me/BotFather" target="_blank" rel="noopener" style="color:#7A63F0;font-weight:700;text-decoration:underline">@BotFather</a> di Telegram.';
      setPfxVal('/');
      if (lbl) lbl.textContent = 'Owner Telegram ID *';
      if (inp) inp.placeholder = 'Contoh: 123456789';
      if (hint) hint.textContent = 'Telegram user ID pemilik bot — untuk akses command owner-only';
    } else if (isDc) {
      if (tokenLbl) tokenLbl.textContent = 'Token Bot Discord *';
      if (tokenInp) tokenInp.placeholder = 'Bot token dari Discord Developer Portal';
      if (hintToken) hintToken.innerHTML = 'Ambil token di <a href="https://discord.com/developers/applications" target="_blank" rel="noopener" style="color:#7A63F0;font-weight:700;text-decoration:underline">Discord Developer Portal → Bot</a>. <a href="/panduan#panduan-discord" target="_blank" style="color:#7A63F0;text-decoration:underline">Lihat Panduan</a>';
      setPfxVal('!');
      if (lbl) lbl.textContent = 'Owner Discord ID *';
      if (inp) inp.placeholder = 'Contoh: 123456789012345678';
      if (hint) hint.textContent = 'Discord User ID pemilik bot (aktifkan Developer Mode lalu Copy ID)';
    } else {
      if (hintToken) hintToken.innerHTML = '';
      setPfxVal('.');
      if (lbl) lbl.textContent = 'Nomor owner *';
      if (inp) inp.placeholder = '628xxxxxxxxxx';
      if (hint) hint.textContent = 'Nomor pemilik bot — untuk akses command owner-only';
    }

    const isPaid = me && (
      me.is_admin ||
      (me.plan !== 'trial' && !!me.plan_expired_at && new Date(me.plan_expired_at) > new Date())
    );
    const fFooter = document.getElementById('f-footer');
    if (fFooter) {
      if (!isPaid) {
        fFooter.value = 'Powered by qwertygate';
        fFooter.disabled = true;
        fFooter.title = 'Custom footer hanya untuk langganan berbayar (bukan akun Trial)';
        const lblF = document.querySelector('label[for="f-footer"]');
        if (lblF) lblF.textContent = 'Footer Bot [Khusus Langganan Berbayar]';
      } else {
        fFooter.disabled = false;
        fFooter.title = '';
        const lblF = document.querySelector('label[for="f-footer"]');
        if (lblF) lblF.textContent = 'Footer Bot';
      }
    }
  }

  document.getElementById('add-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeAdd(); });

  document.getElementById('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('add-error');
    err.classList.remove('show');
    document.querySelectorAll('#add-form .inp').forEach(i => i.classList.remove('inp-error'));

    const nameInp = document.getElementById('f-name');
    const nameVal = nameInp?.value.trim();
    if (!nameVal) {
      nameInp?.classList.add('inp-error');
      nameInp?.focus();
      err.textContent = 'Nama bot wajib diisi.';
      err.classList.add('show');
      return;
    }

    if (platform === 'telegram' || platform === 'discord') {
      const tokenInp = document.getElementById('f-token');
      const tokenVal = tokenInp?.value.trim();
      if (!tokenVal) {
        tokenInp?.classList.add('inp-error');
        tokenInp?.focus();
        err.textContent = (platform === 'discord' ? 'Token Bot Discord' : 'Token Telegram') + ' wajib diisi.';
        err.classList.add('show');
        return;
      }
    }

    const ownerInp = document.getElementById('f-owner');
    const ownerVal = ownerInp?.value.trim();
    if (!ownerVal) {
      ownerInp?.classList.add('inp-error');
      ownerInp?.focus();
      const lblOwner = platform === 'discord' ? 'Owner Discord ID' : (platform === 'telegram' ? 'Owner Telegram ID' : 'Nomor owner');
      err.textContent = lblOwner + ' wajib diisi.';
      err.classList.add('show');
      return;
    }

    const body = {
      platform,
      bot_name: nameVal,
      bot_number: document.getElementById('f-botnum').value.trim() || undefined,
      owner_number: ownerVal,
      prefix: document.getElementById('f-prefix').value.trim() || '.',
      footer_text: document.getElementById('f-footer').value.trim() || 'Powered by qwertygate',
      telegram_token: platform === 'telegram' ? (document.getElementById('f-token').value.trim() || undefined) : undefined,
      discord_token: platform === 'discord' ? (document.getElementById('f-token').value.trim() || undefined) : undefined,
    };
    const d = await api('/api/bots', { method: 'POST', body: JSON.stringify(body) });
    if (!d) return;
    if (d.ok) { closeAdd(); location.href = '/config/' + (d.slug || d.bot_id); }
    else { err.textContent = d.message; err.classList.add('show'); }
  });

  const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('qwertygate_bot') : null;
  if (bc) {
    bc.onmessage = (e) => {
      if (e.data?.type === 'status') {
        const b = bots.find(x => String(x.id) === String(e.data.botId));
        if (b) {
          b.is_running = e.data.isRunning ? 1 : 0;
          b.status = e.data.status;
          renderBots();
        }
      }
    };
  }

  let ws = null;
  function connectWS() {
    try { if (ws) ws.close(); } catch {}
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'subscribe_user' }));
    };
    ws.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.type === 'status' && d.botId) {
          const b = bots.find(x => x.id === d.botId);
          if (b) {
            b.status = d.payload.status;
            b.is_running = (d.payload.status === 'connected') ? 1 : 0;
            renderBots();
            renderStats();
          }
        }
      } catch {}
    };
    ws.onclose = () => setTimeout(connectWS, 4000);
  }

  const btnToggle = document.getElementById('toggle-token-btn');
  if (btnToggle) {
    btnToggle.addEventListener('click', (e) => {
      e.preventDefault();
      const inp = document.getElementById('f-token');
      if (!inp) return;
      const isPass = inp.type === 'password';
      inp.type = isPass ? 'text' : 'password';
      btnToggle.innerHTML = isPass
        ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
        : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
    });
  }

  (async () => {
    if (!(await whoami())) return;
    await loadBots();
    muatPengumuman();
    connectWS();
  })();

  function kunciPengumuman(stempel) { return 'yb-pengumuman-tutup:' + (stempel || 'x'); }

  async function muatPengumuman() {
    let d;
    try {
      const res = await fetch('/api/pengumuman', { credentials: 'include' });
      d = await res.json();
    } catch { return; }
    const p = d?.pengumuman;
    if (!p) return;
    try {
      if (localStorage.getItem(kunciPengumuman(p.updated_at))) return;
    } catch { /* localStorage bisa dimatikan browser — tampilkan saja */ }
    const box = document.getElementById('pengumuman');
    box.dataset.stempel = p.updated_at || '';
    document.getElementById('peng-judul').textContent = p.judul;
    document.getElementById('peng-isi').textContent = p.isi;
    box.style.display = '';
  }

  window.tutupPengumuman = function () {
    const box = document.getElementById('pengumuman');
    box.style.display = 'none';
    try {
      if (box.dataset.stempel) localStorage.setItem(kunciPengumuman(box.dataset.stempel), '1');
    } catch { /* abaikan */ }
  };
window.openAddBot = openAddBot; window.closeAdd = closeAdd;
window.showStep = showStep; window.backStep = backStep; window.pickPlatform = pickPlatform;
window.logout = logout;

const dxAdd = document.getElementById('dx-add');
if (dxAdd) dxAdd.addEventListener('click', openAddBot);

document.querySelectorAll('.bt-grid > .bt-anim').forEach((el, i) => { el.style.animationDelay = (i * 60) + 'ms'; });

document.querySelectorAll('.cx-nav-item[href]').forEach(a => {
  const h = a.getAttribute('href');
  if (location.pathname === h || location.pathname.startsWith(h + '/')) a.classList.add('on', 'active');
});

})();
