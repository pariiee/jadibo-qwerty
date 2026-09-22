// Halaman ini dulunya inline <script>, jadi fungsi-fungsinya global.
// CSP sekarang nggak ngebolehin script inline, jadi dibungkus fungsi biasa —
// yang perlu dipanggil HTML diekspor ke window di bawah.
(function () {
// ── Session via cookie — tidak pakai localStorage ────────────────
  let me = null;
  async function whoami() {
    const d = await api('/api/auth/me');
    if (!d?.ok) { location.href = '/'; return null; }
    me = d.user;
    document.getElementById('side-avatar').textContent = (me.username || '?')[0].toUpperCase();
    document.getElementById('side-name').textContent  = me.username;
    document.getElementById('side-role').textContent  = me.role;
    document.getElementById('greeting').textContent   = 'Selamat Datang Kembali, ' + me.username;
    if (me.role === 'king') document.getElementById('nav-admin').style.display = '';
    return me;
  }

  // ── API helper ──────────────────────────────────────────────────
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

  // ── Data ────────────────────────────────────────────────────────
  let bots = [];
  let maxSlots = 2;

  async function loadBots() {
    const d = await api('/api/bots');
    if (!d?.ok) return;
    bots = d.bots;
    maxSlots = me?.slots_max ?? (me?.role === 'king' ? 999 : 2);
    renderSlots();
    renderBots();
  }

  function renderSlots() {
    const used = bots.length;
    const box = document.getElementById('slot-dots');
    box.innerHTML = '';
    const show = maxSlots > 12 ? Math.min(used, 12) : maxSlots;
    for (let i = 0; i < show; i++) {
      const d = document.createElement('i');
      if (i < used) d.className = 'on';
      box.appendChild(d);
    }
    document.getElementById('slot-text').textContent = `${used} / ${maxSlots > 12 ? '\u221E' : maxSlots}`;
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  const waIcon = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12c0 1.85.5 3.58 1.37 5.07L2 22l5.09-1.34A9.95 9.95 0 0 0 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2z" fill="#25D366"/></svg>`;
  const tgIcon = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#229ED9"/></svg>`;

  function renderBots() {
    const grid = document.getElementById('bot-grid');
    const empty = document.getElementById('empty-state');
    grid.innerHTML = '';
    empty.style.display = bots.length ? 'none' : '';

    const online = bots.filter(b => b.is_running).length;
    const dot = document.getElementById('live-dot');
    dot.className = 'dot' + (online ? '' : ' off');
    document.getElementById('online-text').textContent = `${online} bot online`;

    bots.forEach(bot => {
      const card = document.createElement('div');
      card.className = 'bot-card';
      card.addEventListener('click', () => { location.href = '/bot/' + bot.id; });
      const on = bot.is_running;
      const stCls = on ? 'st-on' : (bot.status === 'connecting' ? 'st-wait' : 'st-off');
      const stTxt = on ? 'Online' : (bot.status === 'connecting' ? 'Connecting' : 'Offline');
      card.innerHTML =
        '<div class="bc-top">' +
          '<div class="bc-platform">' + (bot.platform === 'telegram' ? tgIcon(14) : waIcon(14)) + '<span>' + esc(bot.platform) + '</span></div>' +
          '<div class="bc-status"><span class="st-dot ' + stCls + '"></span>' + stTxt + '</div>' +
        '</div>' +
        '<h3>' + esc(bot.bot_name) + '</h3>' +
        '<div class="desc">' + (bot.description ? esc(bot.description) : 'Tidak ada deskripsi') + '</div>' +
        '<div class="bc-meta"><span>Prefix: <b>' + esc(bot.prefix) + '</b></span><span>' + esc(new Date(bot.created_at).toLocaleDateString('id-ID')) + '</span></div>';
      grid.appendChild(card);
    });

    if (bots.length < maxSlots) {
      const add = document.createElement('div');
      add.className = 'add-card';
      add.innerHTML = '<div class="add-ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="#71717a" stroke-width="2" stroke-linecap="round"/></svg></div><span>Tambah Bot</span>';
      add.addEventListener('click', openAddBot);
      grid.appendChild(add);
    }
  }

  // ── Add bot ─────────────────────────────────────────────────────
  let platform = 'whatsapp';
  function openAddBot() {
    if (bots.length >= maxSlots) { alert('Slot penuh. Maksimal ' + maxSlots + ' bot per akun.'); return; }
    platform = 'whatsapp';
    setPlatUI();
    showStep('platform');
    document.getElementById('add-overlay').classList.add('show');
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
    document.getElementById('form-badge').textContent = platform;
    const isTg = platform === 'telegram';
    document.getElementById('wrap-token').style.display = isTg ? '' : 'none';
    document.getElementById('wrap-botnum').style.display = isTg ? 'none' : '';
    const lbl = document.getElementById('lbl-owner');
    const inp = document.getElementById('f-owner');
    const hint = document.getElementById('hint-owner');
    if (isTg) { lbl.textContent = 'Owner Telegram ID'; inp.placeholder = 'Contoh: 123456789'; hint.textContent = 'Telegram user ID pemilik bot — untuk akses command owner-only'; }
    else { lbl.textContent = 'Nomor Owner'; inp.placeholder = '628xxxxxxxxxx'; hint.textContent = 'Nomor pemilik bot — untuk akses command owner-only'; }
  }

  document.getElementById('add-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeAdd(); });

  document.getElementById('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('add-error');
    err.classList.remove('show');
    const body = {
      platform,
      bot_name: document.getElementById('f-name').value.trim(),
      bot_number: document.getElementById('f-botnum').value.trim() || undefined,
      owner_number: document.getElementById('f-owner').value.trim() || undefined,
      prefix: document.getElementById('f-prefix').value.trim() || '!',
      footer_text: document.getElementById('f-footer').value.trim() || 'Powered by yaparbots',
      telegram_token: document.getElementById('f-token').value.trim() || undefined
    };
    const d = await api('/api/bots', { method: 'POST', body: JSON.stringify(body) });
    if (!d) return;
    if (d.ok) { closeAdd(); location.href = '/bot/' + d.bot_id; }
    else { err.textContent = d.message; err.classList.add('show'); }
  });

  // ── Live stats ──────────────────────────────────────────────────
  function connectWS() {
    try {
      const ws = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host);
      ws.onmessage = e => {
        try {
          const d = JSON.parse(e.data);
          if (d.type === 'stats') document.getElementById('online-text').textContent = `${d.payload.total_bots_online} bot online`;
        } catch {}
      };
      ws.onclose = () => setTimeout(connectWS, 5000);
    } catch {}
  }

  (async () => {
    if (!(await whoami())) return;
    await loadBots();
    connectWS();
  })();
window.openAddBot = openAddBot; window.closeAdd = closeAdd;
window.showStep = showStep; window.backStep = backStep; window.pickPlatform = pickPlatform;
window.logout = logout;

})();
