// Halaman ini dulunya inline <script>, jadi fungsi-fungsinya global.
// CSP sekarang nggak ngebolehin script inline, jadi dibungkus fungsi biasa —
// yang perlu dipanggil HTML diekspor ke window di bawah.
(function () {
// ── Session via cookie — tidak pakai localStorage ────────────────
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
    renderStats();
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
  let botKuota = new Map();
  let maxSlots = 2;

  function renderSkeletons() {
    const grid = document.getElementById('bot-grid');
    if (!grid || bots.length) return;
    grid.innerHTML = [1, 2].map(() => `
      <div class="card bc skeleton-card" style="pointer-events:none;opacity:0.6;animation:skeleton-pulse 1.4s ease-in-out infinite">
        <div class="row" style="display:flex;justify-content:space-between;margin-bottom:12px">
          <div style="width:75px;height:22px;border-radius:6px;background:var(--border)"></div>
          <div style="width:55px;height:22px;border-radius:6px;background:var(--border)"></div>
        </div>
        <div style="width:55%;height:22px;border-radius:6px;background:var(--border);margin:12px 0 8px"></div>
        <div style="width:85%;height:14px;border-radius:4px;background:var(--border);margin-bottom:16px"></div>
        <div style="width:100%;height:45px;border-radius:8px;background:var(--border);margin-bottom:14px"></div>
        <div class="row" style="display:flex;justify-content:space-between;margin-top:10px">
          <div style="width:35%;height:14px;border-radius:4px;background:var(--border)"></div>
          <div style="width:25%;height:14px;border-radius:4px;background:var(--border)"></div>
        </div>
      </div>
    `).join('');
  }

  async function loadBots() {
    renderSkeletons();
    const [dBots, dKuota] = await Promise.all([
      api('/api/bots'),
      api('/api/kuota')
    ]);
    maxSlots = me?.slots_max ?? (me?.is_admin ? 999 : 0);
    // Daftar bot gagal? Kartu ringkasan tetap keisi — jangan tinggalin strip.
    if (!dBots?.ok) { renderStats(); return; }
    bots = dBots.bots || [];
    botKuota = new Map((dKuota?.bots || []).map(k => [k.id, k]));
    renderSlots();
    renderStats();
    renderBots();
  }

  function renderSlots() {
    const used = bots.length;
    // Tampilan pakai JATAH YANG DIBELI (`slots_beli`). `maxSlots` cuma buat
    // nentuin boleh nambah bot apa nggak — di situ admin dapet 999, dan angka
    // itu yang bikin baris ini nulis "1 / ∞" padahal jatahnya 2.
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

  /**
   * Banner peringatan di atas dashboard.
   *
   * KENAPA ADA: peringatan kuota & masa aktif dikirim lewat WhatsApp, dan
   * pengirimnya adalah bot MILIK USER SENDIRI (engine/notify.js). Jadi tepat
   * saat kuota habis — bot berhenti membalas — kabar itu ikut tidak sampai, dan
   * user cuma melihat bot yang diam tanpa sebab. Ini kanal yang tidak
   * bergantung pada bot.
   *
   * Datanya dari `me` + `bots` yang SUDAH dimuat halaman ini: nol request
   * tambahan, nol endpoint baru. Ambangnya sengaja sama dengan
   * engine/kuota.js (80%/95%) — kalau di sana diubah, ubah di sini juga.
   */
  function renderPeringatan() {
    const el = document.getElementById('kuota-alert');
    if (!el) return;

    const baris = [];

    // 1) Kuota per bot. `receive_limit` 0 = tanpa batas (jangan dihitung).
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

    // 2) Masa aktif paket. `hari <= 3` sama dengan ambang di renderStats().
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

    // Kritis duluan — yang bikin bot benar-benar diam harus dibaca pertama.
    baris.sort((a, b) => Number(b.kritis) - Number(a.kritis));

    el.className = 'kuota-alert' + (baris.some((x) => x.kritis) ? ' kritis' : '');
    el.innerHTML =
      baris.map((x) => `<div class="kuota-alert-baris">${x.kritis ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'} <span>${x.teks}</span></div>`).join('') +
      '<div class="kuota-alert-aksi"><a class="btn btn-outline btn-sm" href="/pricing">Tambah Kuota / Perpanjang</a>' +
      '<a class="btn btn-outline btn-sm" href="/kuota">Lihat Kuota</a></div>';
    el.style.display = '';
  }

  // ── Kartu ringkasan ─────────────────────────────────────────────
  // "Bot Online" = bot milik user sendiri, dihitung dari /api/bots.
  // endpoint /stats nggak dipakai karena angkanya global (bocorin jumlah
  // pelanggan ke semua user) dan bikin request tambahan tiap 10 detik.
  function renderStats() {
    const txt = (id, v, cls) => {
      const el = document.getElementById(id);
      el.textContent = v;
      el.className = 'val' + (cls ? ' ' + cls : '');
    };

    txt('st-role', me.is_admin ? 'Admin' : (me.plan_aktif ? (me.slots || 1) + ' Slot' : '0 Slot'));
    document.getElementById('st-role-sub').textContent = me.is_admin
      ? 'Akses penuh Administrator'
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

    // Banner kuota/paket. Dipanggil DI SINI supaya ikut jalan di jalur gagal
    // (/api/bots error) juga — di situ `bots` kosong, tapi peringatan paket
    // tetap harus muncul.
    renderPeringatan();

    // Slot pun belum keisi di jalur ini — /api/bots nggak jalan, jadi `used` nggak
    // diketahui. Jangan timpa angka terakhir yang udah bener sama tebakan.
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  let btAnimated = false;

  function renderSide() {
    const pips = document.getElementById('bt-pips');
    if (!pips) return;
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

  // ── Add bot ─────────────────────────────────────────────────────
  let platform = 'whatsapp';
  function openAddBot() {
    // Slot 0 = akun gratis. Arahkan ke halaman pricing, bukan cuma alert:
    // dari situ user bisa langsung klaim Trial atau pilih paket.
    if (maxSlots === 0) { location.href = '/pricing'; return; }
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
    const platDc = document.getElementById('plat-dc');
    if (platDc) platDc.classList.toggle('sel', platform === 'discord');
    document.getElementById('form-badge').textContent = platform;
    const isTg = platform === 'telegram';
    const isDc = platform === 'discord';
    const isTokenBased = isTg || isDc;
    document.getElementById('wrap-token').style.display = isTokenBased ? '' : 'none';
    document.getElementById('wrap-botnum').style.display = isTokenBased ? 'none' : '';
    const lbl = document.getElementById('lbl-owner');
    const inp = document.getElementById('f-owner');
    const hint = document.getElementById('hint-owner');
    const tokenLbl = document.querySelector('label[for="f-token"]');
    const tokenInp = document.getElementById('f-token');

    if (isTg) {
      if (tokenLbl) tokenLbl.textContent = 'Token Telegram Bot *';
      if (tokenInp) tokenInp.placeholder = '123456:ABC-DEF...';
      lbl.textContent = 'Owner Telegram ID'; inp.placeholder = 'Contoh: 123456789'; hint.textContent = 'Telegram user ID pemilik bot — untuk akses command owner-only';
    } else if (isDc) {
      if (tokenLbl) tokenLbl.textContent = 'Token Bot Discord *';
      if (tokenInp) tokenInp.placeholder = 'Bot token dari Discord Developer Portal';
      lbl.textContent = 'Owner Discord ID'; inp.placeholder = 'Contoh: 123456789012345678'; hint.textContent = 'Discord user ID pemilik bot — untuk akses command owner-only';
    } else {
      lbl.textContent = 'Nomor Owner'; inp.placeholder = '628xxxxxxxxxx'; hint.textContent = 'Nomor pemilik bot — untuk akses command owner-only';
    }
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
      footer_text: document.getElementById('f-footer').value.trim() || 'Powered by qwertygate',
      telegram_token: platform === 'telegram' ? (document.getElementById('f-token').value.trim() || undefined) : undefined,
      discord_token: platform === 'discord' ? (document.getElementById('f-token').value.trim() || undefined) : undefined,
    };
    const d = await api('/api/bots', { method: 'POST', body: JSON.stringify(body) });
    if (!d) return;
    if (d.ok) { closeAdd(); location.href = '/config/' + (d.slug || d.bot_id); }
    else { err.textContent = d.message; err.classList.add('show'); }
  });

  // ── Multi-tab sync via BroadcastChannel ──────────────────────────
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

  // ── Live stats ──────────────────────────────────────────────────
  // Socket dashboard dibuang bareng indikator "bot online" di topbar — satu-satunya
  // yang dia dengerin cuma pesan `stats`. Log live tetap jalan di /bot/:id
  // (bot-detail.js punya socket sendiri).

  // Setup toggle intip / sembunyikan token bot
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
  })();

  // ── Pengumuman dari admin ───────────────────────────────────────
  // Ditutup -> diingat di localStorage pakai `updated_at`. Admin menulis
  // pengumuman baru = stempelnya berubah = muncul lagi sendiri, tanpa user
  // perlu menghapus apa pun.
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
    // textContent, BUKAN innerHTML: isinya tulisan admin, dan innerHTML bikin
    // satu tag yang tidak sengaja ditulis jadi HTML yang jalan di browser user.
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

// Tombol "Tambah bot" di tile Welcome
const dxAdd = document.getElementById('dx-add');
if (dxAdd) dxAdd.addEventListener('click', openAddBot);

// Stagger animasi masuk untuk tile statis
document.querySelectorAll('.bt-grid > .bt-anim').forEach((el, i) => { el.style.animationDelay = (i * 60) + 'ms'; });

// Tandai menu navbar aktif
document.querySelectorAll('.cx-nav-item[href]').forEach(a => {
  const h = a.getAttribute('href');
  if (location.pathname === h || location.pathname.startsWith(h + '/')) a.classList.add('on', 'active');
});

})();