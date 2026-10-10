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
    const topAv = document.getElementById('top-avatar-txt');
    if (topAv) topAv.textContent = (me.username || '?')[0].toUpperCase();
    document.getElementById('greeting').textContent   = 'Selamat Datang Kembali, ' + me.username;
    const hg = document.getElementById('hero-greeting');
    if (hg) hg.innerHTML = '<span>Selamat Datang Kembali,</span><br>' + esc(me.username);
    if (me.is_admin) document.getElementById('nav-admin').style.display = '';
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
  let maxSlots = 2;

  async function loadBots() {
    const d = await api('/api/bots');
    maxSlots = me?.slots_max ?? (me?.is_admin ? 999 : 0);
    // Daftar bot gagal? Kartu ringkasan tetap keisi — jangan tinggalin strip.
    if (!d?.ok) { renderStats(); return; }
    bots = d.bots;
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
    document.getElementById('slot-text').textContent = `${used} / ${beli}`;

    const elSlot = document.getElementById('st-slot');
    elSlot.textContent = String(beli);
    elSlot.className = 'val' + (beli > 0 && used >= beli ? ' warn' : '');
    document.getElementById('st-slot-sub').textContent =
      me?.is_admin ? `Administrator \u2014 tak terbatas, ${used} terpakai`
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

    txt('st-role', me.role_label || me.role || '\u2014');
    document.getElementById('st-role-sub').textContent = me.is_admin
      ? 'Akses penuh ke panel Administrator'
      : (me.plan_name ? `Paket ${me.plan_name}` : 'Paket Gratis');

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
  const waIcon = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12c0 1.85.5 3.58 1.37 5.07L2 22l5.09-1.34A9.95 9.95 0 0 0 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2z" fill="#25D366"/></svg>`;
  const tgIcon = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#229ED9"/></svg>`;

  function renderBots() {
    const grid = document.getElementById('bot-grid');
    const empty = document.getElementById('empty-state');
    grid.innerHTML = '';
    empty.style.display = bots.length ? 'none' : '';

    bots.forEach(bot => {
      const card = document.createElement('div');
      card.className = 'card bc';
      card.addEventListener('click', () => { location.href = '/bot/' + bot.id; });
      const on = bot.is_running;
      const stTxt = on ? 'Online' : (bot.status === 'connecting' ? 'Connecting' : 'Offline');
      card.innerHTML =
        '<div class="row">' +
          '<span class="wa">' + esc(bot.platform === 'telegram' ? 'Telegram' : 'WhatsApp') + '</span>' +
          '<span class="on-dot ' + (on ? '' : 'off') + '">' + stTxt + '</span>' +
        '</div>' +
        '<h3>' + esc(bot.bot_name) + '</h3>' +
        '<div class="row" style="margin-top:2px">' + (bot.description ? esc(bot.description) : 'Tidak ada deskripsi') + '</div>' +
        '<div class="row" style="margin-top:14px"><span>Prefix: <b style="color:var(--ink)">' + esc(bot.prefix) + '</b></span><span>' + esc(new Date(bot.created_at).toLocaleDateString('id-ID')) + '</span></div>' +
        '<div class="btns">' +
          '<button data-cfg>Config</button>' +
          '<button data-stat>Statistik</button>' +
        '</div>';
      grid.appendChild(card);
      card.querySelector('[data-cfg]').addEventListener('click', (e) => { e.stopPropagation(); location.href = '/config/' + bot.id; });
      card.querySelector('[data-stat]').addEventListener('click', (e) => { e.stopPropagation(); location.href = '/bot/' + bot.id; });
    });

    if (bots.length < maxSlots) {
      const add = document.createElement('button');
      add.className = 'add add-btn';
      add.style.color = 'inherit';
      add.style.cursor = 'pointer';
      add.innerHTML = '<span class="round"><svg class="i" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></span>Tambah Bot';
      add.addEventListener('click', openAddBot);
      grid.appendChild(add);
    }
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
      footer_text: document.getElementById('f-footer').value.trim() || 'Powered by qwertygate',
      telegram_token: document.getElementById('f-token').value.trim() || undefined
    };
    const d = await api('/api/bots', { method: 'POST', body: JSON.stringify(body) });
    if (!d) return;
    if (d.ok) { closeAdd(); location.href = '/config/' + d.bot_id; }
    else { err.textContent = d.message; err.classList.add('show'); }
  });

  // ── Live stats ──────────────────────────────────────────────────
  // Socket dashboard dibuang bareng indikator "bot online" di topbar — satu-satunya
  // yang dia dengerin cuma pesan `stats`. Log live tetap jalan di /bot/:id
  // (bot-detail.js punya socket sendiri).

  (async () => {
    if (!(await whoami())) return;
    await loadBots();
    // Dipanggil DI SINI, bukan di dalam whoami(): whoami() `return null` kalau
    // sesinya mati, jadi baris ini ikut ke-skip dan bannernya tidak pernah muncul.
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

})();