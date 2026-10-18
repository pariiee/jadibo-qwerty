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
    const topAv = document.getElementById('top-avatar-txt');
    if (topAv) topAv.textContent = (me.username || '?')[0].toUpperCase();
    document.getElementById('greeting').textContent   = 'Selamat Datang Kembali, ' + me.username;
    const hg = document.getElementById('hero-greeting');
    if (hg) {
      hg.innerHTML = '<span class="hero-sub">Selamat Datang Kembali,</span><br><span class="hero-user" id="hero-name"></span>';
      typeWriter(document.getElementById('hero-name'), me.username);
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

  async function loadBots() {
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

  function renderBots() {
    const grid = document.getElementById('bot-grid');
    const empty = document.getElementById('empty-state');
    grid.innerHTML = '';
    if (empty) empty.style.display = 'none';

    bots.forEach(bot => {
      const card = document.createElement('div');
      card.className = 'card bc';
      card.addEventListener('click', () => { location.href = '/bot/' + botHref(bot); });
      const on = bot.is_running;
      const stTxt = on ? 'Online' : (bot.status === 'connecting' ? 'Connecting' : 'Offline');
      const k = botKuota.get(bot.id);

      let kuotaHtml = '';
      if (k) {
        if (k.tanpaBatas) {
          kuotaHtml = '<div class="bot-kuota-sec">' +
            '<div class="bot-kuota-info"><span>Kuota Pesan</span><b>Tanpa Batas</b></div>' +
            '<div class="bot-kuota-sub">Akun bebas batas kuota</div>' +
          '</div>';
        } else if (!k.paketAktif) {
          kuotaHtml = '<div class="bot-kuota-sec">' +
            '<div class="bot-kuota-info"><span>Kuota Pesan</span><b style="color:var(--errTxt)">Paket Berakhir</b></div>' +
            '<div class="bot-kuota-sub">Perpanjang di menu Pricing</div>' +
          '</div>';
        } else {
          const w = k.persen >= 95 ? 'var(--errTxt)' : (k.persen >= 80 ? 'var(--warn)' : 'var(--green)');
          kuotaHtml = '<div class="bot-kuota-sec">' +
            '<div class="bot-kuota-info"><span>Kuota Pesan</span><b>' + Number(k.sisa || 0).toLocaleString('id-ID') + ' / ' + Number(k.batas || 0).toLocaleString('id-ID') + '</b></div>' +
            '<div class="bot-kuota-bar"><div class="bot-kuota-fill" style="width:' + Math.min(100, k.persen) + '%;background:' + w + '"></div></div>' +
            '<div class="bot-kuota-sub">' + k.persen + '% terpakai · harian: ' + Number(k.harian || 0).toLocaleString('id-ID') + '</div>' +
          '</div>';
        }
      }

      card.innerHTML =
        '<div class="row">' +
          '<span class="eb-label ' + (bot.platform === 'telegram' ? 'eb-tg' : 'eb-wa') + '">' + esc(bot.platform === 'telegram' ? 'Telegram' : 'WhatsApp') + '</span>' +
          '<span class="on-dot ' + (on ? '' : 'off') + '">' + stTxt + '</span>' +
        '</div>' +
        '<h3 style="margin:10px 0 4px">' + esc(bot.bot_name) + '</h3>' +
        '<div class="row" style="margin-top:2px;font-size:13px;color:var(--mute)">' + (bot.description ? esc(bot.description) : 'Tidak ada deskripsi') + '</div>' +
        kuotaHtml +
        '<div class="row" style="margin-top:14px"><span>Prefix: <b style="color:var(--ink)">' + esc(bot.prefix) + '</b></span><span>' + esc(new Date(bot.created_at).toLocaleDateString('id-ID')) + '</span></div>' +
        '<div class="bot-auto-renew-row" style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;padding:8px 12px;border-radius:8px;background:rgba(255,255,255,0.03);border:1px solid var(--border)">' +
          '<span style="font-size:12px;display:flex;align-items:center;gap:6px"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg> <b>Auto-perpanjang</b></span>' +
          '<button type="button" data-toggle-autorenew class="btn btn-sm ' + (me?.auto_renew ? 'btn-primary' : 'btn-outline') + '" style="font-size:11px;padding:3px 10px;border-radius:999px;' + (me?.auto_renew ? 'background:#10b981;color:#000;border:none;' : '') + '">' +
            (me?.auto_renew ? 'Aktif' : 'Mati') +
          '</button>' +
        '</div>' +
        '<div class="bot-addon-row" style="display:flex;gap:8px;margin-top:10px;">' +
          '<button type="button" class="btn btn-sm btn-outline" data-addon-owner style="flex:1;font-size:11px;padding:6px 8px;border-radius:8px;">+1 Slot Owner</button>' +
          '<button type="button" class="btn btn-sm btn-outline" data-addon-quota style="flex:1;font-size:11px;padding:6px 8px;border-radius:8px;">+1.000 Kuota</button>' +
        '</div>' +
        '<div class="btns">' +
          '<button data-cfg>Config</button>' +
          '<button data-stat>Statistik</button>' +
        '</div>';
      grid.appendChild(card);
      card.querySelector('[data-cfg]').addEventListener('click', (e) => { e.stopPropagation(); location.href = '/config/' + botHref(bot); });
      card.querySelector('[data-stat]').addEventListener('click', (e) => { e.stopPropagation(); location.href = '/bot/' + botHref(bot); });
      const btnAuto = card.querySelector('[data-toggle-autorenew]');
      if (btnAuto) {
        btnAuto.addEventListener('click', async (e) => {
          e.stopPropagation();
          const targetState = !me?.auto_renew;
          btnAuto.disabled = true;
          btnAuto.textContent = '…';
          try {
            const res = await api('/api/wallet/auto-renew', {
              method: 'POST',
              body: JSON.stringify({ aktif: targetState })
            });
            if (res?.ok) {
              me.auto_renew = targetState;
              renderBots();
            } else {
              alert(res?.message || 'Gagal mengubah status auto-perpanjang');
              renderBots();
            }
          } catch {
            renderBots();
          }
        });
      }

      const btnAddOwner = card.querySelector('[data-addon-owner]');
      if (btnAddOwner) {
        btnAddOwner.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm('Beli +1 Slot Owner Bot langsung potong saldo dompet kamu?')) return;
          btnAddOwner.disabled = true;
          try {
            const res = await api('/api/billing/addon', {
              method: 'POST',
              body: JSON.stringify({ type: 'owner' })
            });
            if (res?.ok) {
              showToast(res.message || 'Berhasil tambah slot owner!', 'success');
              init();
            } else {
              showToast(res?.message || 'Gagal membeli addon', 'error');
            }
          } catch {
            showToast('Terjadi kesalahan jaringan', 'error');
          } finally {
            btnAddOwner.disabled = false;
          }
        });
      }

      const btnAddQuota = card.querySelector('[data-addon-quota]');
      if (btnAddQuota) {
        btnAddQuota.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm('Beli +1.000 Kuota Respon langsung potong saldo dompet kamu?')) return;
          btnAddQuota.disabled = true;
          try {
            const res = await api('/api/billing/addon', {
              method: 'POST',
              body: JSON.stringify({ type: 'quota' })
            });
            if (res?.ok) {
              showToast(res.message || 'Berhasil tambah kuota!', 'success');
              init();
            } else {
              showToast(res?.message || 'Gagal membeli addon', 'error');
            }
          } catch {
            showToast('Terjadi kesalahan jaringan', 'error');
          } finally {
            btnAddQuota.disabled = false;
          }
        });
      }
    });

    // Selalu tampilkan card Tambah Bot
    const add = document.createElement('div');
    add.className = 'card add-card';
    add.innerHTML = '<span class="round"><svg class="i" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></span><span>+ Tambah Bot</span>';
    add.addEventListener('click', openAddBot);
    grid.appendChild(add);
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
    if (d.ok) { closeAdd(); location.href = '/config/' + (d.slug || d.bot_id); }
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