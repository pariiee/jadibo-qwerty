// Halaman Administrator — user, pesanan, harga & benefit.
// Hanya admin tertinggi yang boleh masuk; server menolak 403 kalau bukan.
(function () {
  let paket = [];
  let userAktif = null;
  let cacheUser = [];

  async function api(path, opts = {}) {
    try {
      const res = await fetch(path, {
        ...opts,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
      });
      if (res.status === 401) { location.href = '/'; return null; }
      // 403 = bukan admin. Dulu cuma diem-diem lempar ke /dashboard, jadi
      // kelihatan seperti halaman yang "balik sendiri". Kasih alasannya.
      if (res.status === 403) {
        const j = await res.json().catch(() => ({}));
        alert(j.message || 'Akses ditolak');
        location.href = '/dashboard';
        return null;
      }
      return res.json();
    } catch { return null; }
  }

  const rupiah = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');
  const tanggal = (s) => s ? new Date(s).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Server kirim created_at UTC (kolom MySQL default TIMESTAMP). Tanpa 'Z', JS
  // bacanya sebagai waktu lokal → jamnya meleset sebesar offset. (sama spt bot-detail.js)
  function logTime(v) {
    if (!v) return '';
    const s = /Z|[+-]\d\d:?\d\d$/.test(v) ? v : String(v).replace(' ', 'T') + 'Z';
    const d = new Date(s);
    return isNaN(d) ? String(v) : d.toLocaleTimeString('id-ID', { hour12: false });
  }

  // ── Custom Glassmorphic Dialog System (ganti prompt/confirm/alert bawaan) ──
  function customDialog({ title, message, hint = '', placeholder = '', defaultValue = '', okText = 'Oke', cancelText = 'Batal', isPrompt = false, isAlert = false, danger = false }) {
    return new Promise((resolve) => {
      const existing = document.getElementById('admin-dialog-overlay');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'admin-dialog-overlay';
      overlay.className = 'overlay';
      overlay.style.cssText = 'display:flex;align-items:center;justify-content:center;z-index:999999;';

      const okBtnCls = danger ? 'btn btn-danger btn-sm' : 'btn btn-dark btn-sm';
      const promptHtml = isPrompt ? `
        <div style="margin:16px 0 18px;">
          <input class="inp" id="dlg-inp" value="${esc(defaultValue)}" placeholder="${esc(placeholder)}" style="width:100%;height:44px;font-size:14px;box-sizing:border-box;" autocomplete="off" />
          ${hint ? `<div class="hint" style="margin-top:6px;font-size:12px;line-height:1.4;">${hint}</div>` : ''}
        </div>
      ` : '';

      overlay.innerHTML = `
        <div class="modal">
          <h3 style="margin:0 0 8px;font-size:18px;font-weight:700;letter-spacing:-.01em;">${esc(title)}</h3>
          <p style="margin:0;font-size:13.5px;line-height:1.55;white-space:pre-line;">${esc(message)}</p>
          ${promptHtml}
          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:${isPrompt ? '0' : '22px'};">
            ${!isAlert ? `<button type="button" class="btn btn-outline" id="dlg-cancel">${esc(cancelText)}</button>` : ''}
            <button type="button" class="${okBtnCls}" id="dlg-ok">${esc(okText)}</button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      const inp = overlay.querySelector('#dlg-inp');
      const btnOk = overlay.querySelector('#dlg-ok');
      const btnCancel = overlay.querySelector('#dlg-cancel');

      function close(val) {
        overlay.remove();
        resolve(val);
      }

      if (btnCancel) {
        btnCancel.addEventListener('click', () => close(isPrompt ? null : false));
      }
      btnOk.addEventListener('click', () => {
        close(isPrompt ? (inp ? inp.value : '') : true);
      });
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(isPrompt ? null : false);
      });

      if (inp) {
        inp.focus();
        inp.select();
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            btnOk.click();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            if (btnCancel) btnCancel.click();
            else close(null);
          }
        });
      } else {
        btnOk.focus();
      }
    });
  }

  function customConfirm({ title = 'Konfirmasi', message, okText = 'Lanjutkan', cancelText = 'Batal', danger = false }) {
    return customDialog({ title, message, okText, cancelText, danger, isPrompt: false });
  }

  function customPrompt({ title, message, hint = '', placeholder = '', defaultValue = '', okText = 'Simpan', cancelText = 'Batal' }) {
    return customDialog({ title, message, hint, placeholder, defaultValue, okText, cancelText, isPrompt: true });
  }

  // ── Floating Action Popover Menu (3-dots ⋮) ─────────────────────────
  let menuAktif = null;
  function tutupAksiMenu() {
    if (menuAktif) {
      menuAktif.remove();
      menuAktif = null;
    }
    document.querySelectorAll('.btn-more.active').forEach(b => b.classList.remove('active'));
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.action-popover') && !e.target.closest('.btn-more')) {
      tutupAksiMenu();
    }
  });
  window.addEventListener('scroll', tutupAksiMenu, { passive: true });
  window.addEventListener('resize', tutupAksiMenu, { passive: true });

  function bukaMenuAksi(e, items) {
    e.stopPropagation();
    const btn = e.currentTarget;
    if (btn.classList.contains('active')) {
      tutupAksiMenu();
      return;
    }
    tutupAksiMenu();
    btn.classList.add('active');

    const pop = document.createElement('div');
    pop.className = 'action-popover';
    pop.innerHTML = items.map(it => {
      if (it.divider) return '<div class="act-divider"></div>';
      const cls = 'act-item' + (it.danger ? ' act-danger' : '');
      const ic = it.icon ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${it.icon}</svg>` : '';
      if (it.href) {
        return `<a href="${it.href}" class="${cls}">${ic}<span>${it.label}</span></a>`;
      }
      return `<button type="button" class="${cls}" data-act="${it.act}">${ic}<span>${it.label}</span></button>`;
    }).join('');

    document.body.appendChild(pop);
    menuAktif = pop;

    const rect = btn.getBoundingClientRect();
    const popWidth = 175;
    let left = rect.right + window.scrollX - popWidth;
    if (left < 10) left = 10;
    let top = rect.bottom + window.scrollY + 6;
    pop.style.top = top + 'px';
    pop.style.left = left + 'px';

    pop.querySelectorAll('.act-item').forEach(el => {
      el.addEventListener('click', () => {
        setTimeout(tutupAksiMenu, 60);
      });
    });
  }

  window.menuUser = function (e, id, username, isActive) {
    const uName = esc(username);
    bukaMenuAksi(e, [
      { label: 'Edit Akun', act: `bukaUser(${id})`, icon: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>' },
      { label: 'Atur Saldo', act: `bukaSaldo(${id}, '${uName}')`, icon: '<rect x="2" y="4" width="20" height="16" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>' },
      { label: isActive ? 'Matikan Akun' : 'Aktifkan Akun', act: `toggleAktif(${id}, ${isActive ? 0 : 1})`, icon: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>' },
      { divider: true },
      { label: 'Hapus User', act: `hapusUser(${id}, '${uName}')`, danger: true, icon: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' }
    ]);
  };

  window.menuBot = function (e, id, slug) {
    bukaMenuAksi(e, [
      { label: 'Kontrol & Pairing', href: '/config/' + slug, icon: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>' },
      { label: 'Statistik Bot', href: '/bot/' + slug, icon: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>' },
      { label: 'Lihat Log', act: `bukaLog(${id})`, icon: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>' },
      { label: 'Tambah Kuota', act: `aturKuota(${id})`, icon: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>' },
      { label: 'Reset Kuota', act: `resetKuota(${id})`, icon: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>' },
      { divider: true },
      { label: 'Hapus Bot', act: `hapusBot(${id})`, danger: true, icon: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' }
    ]);
  };

  // ── Navigasi halaman per-page ─────────────────────────────────────
  const PAGE_MAP = {
    'user': { key: 'user', subId: 'sub-manage-users', title: 'Manajemen User', desc: 'Kelola akun pengguna, hak akses, dan paket langganan bot.' },
    'users': { key: 'user', subId: 'sub-manage-users', title: 'Manajemen User', desc: 'Kelola akun pengguna, hak akses, dan paket langganan bot.' },
    'bot': { key: 'bot', subId: 'sub-manage-bots', title: 'Manajemen Bot', desc: 'Pantau seluruh instans bot pengguna, status koneksi, dan kuota pesan.' },
    'bots': { key: 'bot', subId: 'sub-manage-bots', title: 'Manajemen Bot', desc: 'Pantau seluruh instans bot pengguna, status koneksi, dan kuota pesan.' },
    'order': { key: 'order', subId: 'sub-manage-orders', title: 'Pesanan & Pembayaran', desc: 'Daftar invoice, riwayat transaksi QRIS, dan rekap pendapatan sistem.' },
    'orders': { key: 'order', subId: 'sub-manage-orders', title: 'Pesanan & Pembayaran', desc: 'Daftar invoice, riwayat transaksi QRIS, dan rekap pendapatan sistem.' },
    'saldo': { key: 'saldo', subId: 'sub-manage-saldo', title: 'Saldo & Dompet User', desc: 'Kelola saldo member, mutasi dompet, dan rekonsiliasi buku besar.' },
    'harga': { key: 'harga', subId: 'sub-manage-harga', title: 'Harga & Benefit Paket', desc: 'Atur harga sewa slot bot, durasi paket, dan batasan kuota pesan.' },
    'sistem': { key: 'sistem', subId: 'sub-manage-sistem', title: 'Sistem & Server', desc: 'Pemantauan kesehatan server, resource CPU/RAM, dan broadcast pengumuman.' },
    'logs': { key: 'logs', subId: 'sub-manage-logs', title: 'Log Aktivitas Sistem', desc: 'Rekam jejak seluruh operasi sistem: autentikasi, aksi admin, cron otomatis, dan bot.' }
  };

  function tab(nama) {
    const info = PAGE_MAP[nama] || PAGE_MAP['users'];
    const key = info.key;

    ['user', 'bot', 'order', 'harga', 'saldo', 'sistem', 'logs'].forEach((t) => {
      const el = document.getElementById('pane-' + t);
      if (el) el.style.display = t === key ? '' : 'none';
    });

    const titleEl = document.getElementById('admin-page-title');
    const descEl = document.getElementById('admin-page-desc');
    if (titleEl) titleEl.textContent = info.title;
    if (descEl) descEl.textContent = info.desc;
    document.title = info.title + ' — Administrator';

    document.querySelectorAll('.nav-sub-item').forEach((a) => {
      a.classList.toggle('active', a.id === info.subId);
    });

    const sysLink = document.getElementById('nav-syslogs');
    if (sysLink) sysLink.classList.toggle('active', key === 'logs');

    if (key === 'user') muatUser();
    if (key === 'bot') muatBot();
    if (key === 'order') { muatPendapatan(); muatOrder(); }
    if (key === 'harga') muatSetelan();
    if (key === 'saldo') muatSaldo();
    if (key === 'sistem') { muatSistem(); muatAudit(); }
    if (key === 'logs') muatLogSistem();
  }

  // ── Bot semua user + log ───────────────────────────────────────
  let logBotId = null;

  async function muatBot() {
    // q dikirim ke server (LIKE di SQL) — bukan difilter di browser lagi.
    const q = (document.getElementById('cari-bot').value || '').trim();
    const d = await api('/api/bots?q=' + encodeURIComponent(q));
    if (!d?.ok) return showToast(d?.message || 'Gagal memuat bot', 'error');
    const rows = d.bots || [];
    const tb = document.getElementById('tbl-bot').querySelector('tbody');
    tb.innerHTML = '';
    if (!rows.length) { tb.innerHTML = '<tr><td class="kosong" colspan="8">Belum ada bot.</td></tr>'; return; }
    rows.forEach((b) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td><b>' + esc(b.bot_name || '—') + '</b></td>' +
        '<td><b>' + esc(b.username || 'user#' + b.user_id) + '</b></td>' +
        '<td><span class="badge">' + esc(b.platform === 'zapo' ? 'whatsapp' : (b.platform || 'whatsapp')) + '</span></td>' +
        '<td>' + (b.is_running ? '<span class="dot on"></span> Online' : '<span class="dot off"></span> Offline') + '</td>' +
        '<td>' + (b.received_count ?? 0) + ' / ' + (b.receive_limit || '∞') + (b.bonus_kuota > 0 ? ' <small style="color:var(--green,#10b981)">(+' + b.bonus_kuota + ')</small>' : '') + '</td>' +
        '<td><code style="background:rgba(18,20,43,.06);padding:3px 7px;border-radius:6px;font-weight:700">' + esc(b.prefix || '.') + '</code></td>' +
        '<td>' + (b.cmd_count ?? 0) + '</td>' +
        '<td class="aksi">' +
          '<button type="button" class="btn-more" onclick="menuBot(event, ' + b.id + ', \'' + botHref(b) + '\')" title="Pilihan aksi">' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="12" cy="19" r="2.2"/></svg>' +
          '</button>' +
        '</td>';
      tb.appendChild(tr);
    });
  }

  /** Nama bot dari baris tabel yang sudah dimuat — biar prompt-nya menyebut nama. */
  function namaBot(id) {
    const btn = document.querySelector('[data-act="bukaLog(' + id + ')"]');
    const tr = btn?.closest('tr');
    return tr?.querySelector('td b')?.textContent || ('bot #' + id);
  }

  /**
   * Top-up kuota pesan. Sengaja pakai prompt bawaan browser, bukan modal baru:
   * ini aksi admin yang jarang dipakai, dan satu modal lagi berarti satu form
   * lagi yang harus dirawat. Kalau nanti jadi sering dipakai, baru dibikin modal.
   */
  async function aturKuota(id) {
    const nama = namaBot(id);
    const jawab = await customPrompt({
      title: 'Atur Kuota Bonus',
      message: `Atur kuota pesan tambahan untuk "${nama}".\nKuota ini ditambahkan di atas jatah paket bawaan.`,
      placeholder: 'mis. 5000 (atau 0 untuk hapus)',
      hint: 'Ketik angka bonus (mis. 5000) atau ketik 0 untuk menghapus bonus.'
    });
    if (jawab === null || jawab.trim() === '') return;

    const jumlah = parseInt(jawab, 10);
    if (!Number.isFinite(jumlah) || jumlah < 0) return showToast('Angka tidak valid', 'error');

    const d = await api('/api/admin/bots/' + id + '/kuota', {
      method: 'POST',
      body: JSON.stringify({ jumlah }),
    });
    showToast(d?.message || (d?.ok ? 'Kuota berhasil diperbarui' : 'Gagal'), d?.ok ? 'success' : 'error');
    if (d?.ok) muatBot();
  }

  /** Nolkan pemakaian kuota tanpa mengubah jatah paket maupun bonus. */
  async function resetKuota(id) {
    const nama = namaBot(id);
    const ok = await customConfirm({
      title: 'Reset Pemakaian Kuota',
      message: `Reset pemakaian kuota "${nama}" ke nol?\n\nPesan yang sudah terpakai akan dianggap 0 lagi. Jatah paket & bonus tidak berubah.`,
      okText: 'Reset Sekarang'
    });
    if (!ok) return;

    const d = await api('/api/admin/bots/' + id + '/reset-kuota', { method: 'POST' });
    showToast(d?.message || (d?.ok ? 'Pemakaian kuota di-reset ke nol' : 'Gagal'), d?.ok ? 'success' : 'error');
    if (d?.ok) muatBot();
  }

  function bukaLog(id) {
    logBotId = id;
    document.getElementById('log-judul').textContent = 'Log Bot #' + id;
    document.getElementById('log-overlay').classList.add('show');
    muatLog();
  }

  function tutupLog() { document.getElementById('log-overlay').classList.remove('show'); }

  async function muatLog() {
    if (!logBotId) return;
    const lv = document.getElementById('log-level').value;
    const d = await api('/api/bots/' + logBotId + '/logs?limit=200');
    const term = document.getElementById('terminal');
    term.innerHTML = '';
    const logs = (d?.logs || []).filter((l) => !lv || l.level === lv);
    if (!logs.length) { term.innerHTML = '<p class="log-line term-hint">// tidak ada log di level ini</p>'; return; }
    logs.forEach((l) => {
      const p = document.createElement('p');
      p.className = 'log-line log-' + (l.level || 'info');
      p.textContent = '[' + logTime(l.created_at) + '] ' + l.message;
      term.appendChild(p);
    });
  }

  // ── Manajemen User ─────────────────────────────────────────────
  async function muatUser() {
    const d = await api('/api/admin/users');
    if (!d?.ok) return showToast(d?.message || 'Gagal memuat user', 'error');
    cacheUser = d.users || [];
    renderUser();
  }

  function renderUser() {
    const q = (document.getElementById('cari-user').value || '').toLowerCase();
    const rows = cacheUser.filter((u) => !q || (u.username || '').toLowerCase().includes(q));
    const tb = document.getElementById('tbl-user').querySelector('tbody');
    tb.innerHTML = '';
    rows.forEach((u) => {
      const emailBadge = u.email ? (
        u.email_verified
          ? ' <span class="badge" style="background:rgba(16,185,129,.12);color:#059669;border:1px solid rgba(16,185,129,.25);font-size:10px;padding:1px 6px;margin-left:4px;font-weight:600;">Terverifikasi</span>'
          : ' <span class="badge" style="background:rgba(245,158,11,.12);color:#d97706;border:1px solid rgba(245,158,11,.25);font-size:10px;padding:1px 6px;margin-left:4px;font-weight:600;">Belum Verifikasi</span>'
      ) : '';
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td><b>' + u.username + '</b>' + (u.email ? '<br><small style="display:inline-flex;align-items:center;flex-wrap:wrap;gap:4px;margin-top:2px;">' + esc(u.email) + emailBadge + '</small>' : '') + '</td>' +
        '<td><span class="badge role-' + (u.role_efektif || u.role) + '">' + (u.role_label || u.role) + '</span></td>' +
        '<td>' + (u.plan_name || u.plan || 'Gratis') + '</td>' +
        '<td>' + tanggal(u.plan_expired_at) + '</td>' +
        '<td>' + (u.plan_slots ?? 'paket') + '</td>' +
        '<td>' + (u.bot_count ?? u.slots_used ?? 0) + '</td>' +
        '<td>' + (u.is_active ? '<span class="dot on"></span> Aktif' : '<span class="dot off"></span> Nonaktif') + '</td>' +
        '<td class="aksi">' +
          '<button type="button" class="btn-more" onclick="menuUser(event, ' + u.id + ', \'' + esc(u.username) + '\', ' + (u.is_active ? 1 : 0) + ')" title="Pilihan aksi">' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="12" cy="19" r="2.2"/></svg>' +
          '</button>' +
        '</td>';
      tb.appendChild(tr);
    });
    if (!rows.length) tb.innerHTML = '<tr><td colspan="8" class="kosong">Tidak ada user.</td></tr>';
  }

  async function toggleAktif(id, aktif) {
    const d = await api('/api/admin/users/' + id, {
      method: 'PATCH',
      body: JSON.stringify({ is_active: aktif })
    });
    if (!d?.ok) return showToast(d?.message || 'Gagal ubah status', 'error');
    showToast(aktif ? 'User diaktifkan' : 'User dimatikan', 'success');
    muatUser();
  }

  function bukaUser(id) {
    const u = cacheUser.find((x) => x.id === id);
    if (!u) return;
    userAktif = u;
    document.getElementById('mu-judul').textContent = 'Edit User: ' + u.username;
    document.getElementById('mu-role').value = u.role || 'user';

    const sel = document.getElementById('mu-plan');
    sel.innerHTML = '<option value="user">Gratis (Basic)</option>';
    paket.forEach((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name + ' — ' + rupiah(p.price) + ' / ' + p.days + ' hari';
      sel.appendChild(o);
    });
    sel.value = u.plan || 'user';
    document.getElementById('mu-exp').value = u.plan_expired_at
      ? new Date(u.plan_expired_at).toISOString().slice(0, 10) : '';
    document.getElementById('mu-slot').value = u.plan_slots ?? '';
    document.getElementById('mu-pass').value = '';
    document.getElementById('mu-error').textContent = '';
    document.getElementById('modal-user').classList.add('show');
  }

  function tutupUser() {
    document.getElementById('modal-user').classList.remove('show');
    userAktif = null;
  }

  async function simpanUser() {
    if (!userAktif) return;
    const role = document.getElementById('mu-role').value;
    const plan = document.getElementById('mu-plan').value;
    const exp = document.getElementById('mu-exp').value;
    const slot = document.getElementById('mu-slot').value;
    const pass = document.getElementById('mu-pass').value.trim();
    const err = document.getElementById('mu-error');

    const body = {
      role,
      plan,
      plan_expired_at: plan === 'user' ? null : (exp ? exp + ' 23:59:59' : null),
      plan_slots: plan === 'user' ? null : (slot === '' ? null : Number(slot))
    };
    if (pass) body.password = pass;

    const d = await api('/api/admin/users/' + userAktif.id, { method: 'PATCH', body: JSON.stringify(body) });
    if (!d?.ok) { err.textContent = d?.message || 'Gagal menyimpan'; err.classList.add('show'); return; }
    tutupUser();
    showToast('Data user ' + userAktif.username + ' berhasil diperbarui', 'success');
    muatUser();
  }

  async function hapusUser(id, username) {
    const u = cacheUser.find((x) => x.id === Number(id));
    const name = (typeof username === 'string' && username ? username : null) || u?.username || ('User #' + id);
    const ok = await customConfirm({
      title: 'Hapus Akun Pengguna',
      message: `Hapus permanen akun "${name}" beserta seluruh bot dan data terkait?\n\nTindakan ini permanen dan tidak bisa dibatalkan!`,
      okText: 'Hapus Akun',
      danger: true
    });
    if (!ok) return;
    const d = await api('/api/admin/users/' + id, { method: 'DELETE' });
    if (!d?.ok) return showToast(d?.message || 'Gagal menghapus user', 'error');
    showToast('User ' + name + ' berhasil dihapus', 'success');
    muatUser();
  }

  // ── Pesanan ────────────────────────────────────────────────────
  async function muatOrder() {
    const st = document.getElementById('filter-order').value;
    const d = await api('/api/admin/billing/orders' + (st ? '?status=' + st : ''));
    if (!d?.ok) return showToast(d?.message || 'Gagal memuat pesanan', 'error');
    const tb = document.getElementById('tbl-order').querySelector('tbody');
    tb.innerHTML = '';
    (d.orders || []).forEach((o) => {
      const tr = document.createElement('tr');
      const tombol = o.status === 'pending'
        ? '<button class="btn btn-sm btn-dark" data-act="konfirmasi(\'' + o.order_id + '\')">Konfirmasi</button>' +
          '<button class="btn btn-sm btn-outline" data-act="tolak(\'' + o.order_id + '\')">Tolak</button>'
        : '<span class="m-sub">—</span>';
      const gagalPaket = o.note && o.note.includes('paket gagal diterapkan');
      const badgeGagal = gagalPaket
        ? '<span class="badge" style="background:rgba(239,68,68,.14);color:var(--errTxt);margin-left:4px" title="' + (o.note || '').replace(/"/g, '&quot;') + '">paket gagal diterapkan</span>'
        : '';
      tr.innerHTML =
        '<td><code>' + o.order_id + '</code></td>' +
        '<td>' + (o.username || '—') + '</td>' +
        '<td>' + (o.plan_name || o.plan) + '</td>' +
        '<td>' + rupiah(o.amount) + '</td>' +
        '<td>' + (o.method === 'manual' ? 'Manual' : 'QRISku') + '</td>' +
        '<td><span class="badge st-' + o.status + '">' + o.status + '</span>' + badgeGagal + '</td>' +
        '<td>' + tanggal(o.created_at) + '</td>' +
        '<td class="aksi">' + tombol + '</td>';
      tb.appendChild(tr);
    });
    if (!d.orders?.length) {
      tb.innerHTML = '<tr><td colspan="8" class="kosong" style="padding:48px 16px;text-align:center;">' +
        '<div style="display:flex;flex-direction:column;align-items:center;gap:10px;">' +
          '<div style="width:44px;height:44px;border-radius:12px;background:rgba(18,20,43,.04);display:grid;place-items:center;color:var(--mute)">' +
            '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="7" y1="8" x2="17" y2="8"/><line x1="7" y1="12" x2="13" y2="12"/></svg>' +
          '</div>' +
          '<div style="font-weight:700;color:var(--ink);font-size:14.5px;">Belum Ada Riwayat Pesanan</div>' +
          '<div style="font-size:13px;color:var(--mute);max-width:320px;line-height:1.45;">Setiap transaksi pembelian paket langganan atau top-up otomatis masuk ke sini.</div>' +
        '</div>' +
      '</td></tr>';
    }
  }

  async function konfirmasi(orderId) {
    const ok = await customConfirm({
      title: 'Konfirmasi Pembayaran',
      message: `Konfirmasi pembayaran pesanan "${orderId}"?\nPaket langganan user akan langsung diaktifkan.`,
      okText: 'Konfirmasi'
    });
    if (!ok) return;
    const d = await api('/api/admin/billing/orders/' + orderId + '/confirm', { method: 'POST' });
    if (!d?.ok) return showToast(d?.message || 'Gagal konfirmasi', 'error');
    showToast('Pembayaran dikonfirmasi', 'success');
    muatOrder();
  }

  async function tolak(orderId) {
    const alasan = await customPrompt({
      title: 'Tolak Pesanan',
      message: `Tolak pesanan "${orderId}"? Masukkan alasan penolakan jika diperlukan.`,
      placeholder: 'mis. Bukti transfer tidak valid / belum masuk'
    });
    if (alasan === null) return;
    const d = await api('/api/admin/billing/orders/' + orderId + '/reject', {
      method: 'POST',
      body: JSON.stringify({ reason: alasan })
    });
    if (!d?.ok) return showToast(d?.message || 'Gagal menolak', 'error');
    showToast('Pesanan ditolak', 'success');
    muatOrder();
  }

  // ── Harga & Benefit ────────────────────────────────────────────
  async function muatSetelan() {
    const d = await api('/api/admin/billing/settings');
    if (!d?.ok) return showToast(d?.message || 'Gagal memuat setelan', 'error');
    paket = d.plans || [];
    renderPaket();
    document.getElementById('f-mode').value = d.pay_mode || d.settings?.pay_mode || 'both';
    document.getElementById('f-qris').value = d.qris_static_url || d.settings?.qris_static_url || '';
    document.getElementById('f-trial').value = d.trial_days ?? 5;
    const elSlots = document.getElementById('f-trial-slots');
    if (elSlots) elSlots.value = d.trial_slots ?? 1;
    const elOwner = document.getElementById('f-trial-owner');
    if (elOwner) elOwner.value = d.trial_owner_max ?? 1;
    const elQuota = document.getElementById('f-trial-quota');
    if (elQuota) elQuota.value = d.trial_receive_limit ?? 5000;
    const elAdOwner = document.getElementById('f-addon-owner');
    if (elAdOwner) elAdOwner.value = d.price_per_owner ?? 2500;
    const elAdQuota = document.getElementById('f-addon-quota');
    if (elAdQuota) elAdQuota.value = d.price_per_1k_quota ?? 5000;
    const p = d.pengumuman || {};
    document.getElementById('f-peng-judul').value = p.judul || '';
    document.getElementById('f-peng-isi').value = p.isi || '';
    document.getElementById('f-peng-aktif').checked = !!p.aktif;
  }

  function renderPaket() {
    const box = document.getElementById('daftar-paket');
    box.innerHTML = '';
    paket.forEach((p, i) => {
      const el = document.createElement('div');
      el.className = 'plan-row';
      const tetap = p.id === 'user';
      el.innerHTML =
        '<div class="field"><label>Nama</label>' +
          '<input class="inp" data-f="name" data-i="' + i + '" value="' + (p.name || '') + '"' + (tetap ? ' readonly' : '') + ' /></div>' +
        '<div class="field"><label>ID</label>' +
          '<input class="inp" data-f="id" data-i="' + i + '" value="' + (p.id || '') + '"' + (tetap ? ' readonly' : '') + ' /></div>' +
        '<div class="field"><label>Harga (Rp)</label>' +
          '<input class="inp" type="number" min="0" data-f="price" data-i="' + i + '" value="' + (p.price || 0) + '"' + (tetap ? ' readonly' : '') + ' /></div>' +
        '<div class="field"><label>Slot bot</label>' +
          '<input class="inp" type="number" min="0" data-f="slots" data-i="' + i + '" value="' + (p.slots ?? 1) + '" /></div>' +
        '<div class="field"><label>Masa aktif (hari)</label>' +
          '<input class="inp" type="number" min="0" data-f="days" data-i="' + i + '" value="' + (p.days ?? 30) + '" /></div>' +
        '<div class="field"><label>Pesan / hari</label>' +
          '<input class="inp" type="number" min="1" data-f="daily_limit" data-i="' + i + '" value="' + (p.daily_limit || 20) + '" /></div>' +
        '<div class="field"><label>Owner number</label>' +
          '<input class="inp" type="number" min="0" data-f="owner_max" data-i="' + i + '" value="' + (p.owner_max || 0) + '" /></div>' +
        '<div class="field"><label>Total pesan diterima</label>' +
          '<input class="inp" type="number" min="0" data-f="receive_limit" data-i="' + i + '" value="' + (p.receive_limit || 0) + '" /></div>' +
        (tetap ? '' : '<button class="btn btn-sm btn-outline" data-act="hapusPaket(' + i + ')">Hapus</button>');
      box.appendChild(el);
    });
  }

  function tambahPaket() {
    paket.push({ id: 'paket' + (paket.length + 1), name: 'Paket Baru', price: 10000, slots: 1, days: 30, daily_limit: 25 });
    renderPaket();
  }

  function hapusPaket(i) {
    paket.splice(i, 1);
    renderPaket();
  }

  function bacaForm() {
    document.querySelectorAll('#daftar-paket [data-f]').forEach((inp) => {
      const p = paket[Number(inp.dataset.i)];
      if (!p) return;
      const f = inp.dataset.f;
      p[f] = (f === 'name' || f === 'id') ? inp.value.trim() : Number(inp.value || 0);
    });
    return paket;
  }

  async function simpanPaket() {
    const err = document.getElementById('harga-error');
    err.textContent = '';
    const d = await api('/api/admin/billing/plans', { method: 'PUT', body: JSON.stringify({ plans: bacaForm() }) });
    if (!d?.ok) { err.textContent = d?.message || 'Gagal menyimpan paket'; return; }
    showToast('Paket disimpan', 'success');
    muatSetelan();
  }

  async function simpanSetelan() {
    const err = document.getElementById('harga-error');
    err.textContent = '';
    const body = {
      pay_mode: document.getElementById('f-mode').value,
      qris_static_url: document.getElementById('f-qris').value.trim(),
      trial_days: Number(document.getElementById('f-trial').value || 5),
      trial_slots: Number(document.getElementById('f-trial-slots')?.value || 1),
      trial_owner_max: Number(document.getElementById('f-trial-owner')?.value || 1),
      trial_receive_limit: Number(document.getElementById('f-trial-quota')?.value || 5000),
      price_per_owner: Number(document.getElementById('f-addon-owner')?.value || 2500),
      price_per_1k_quota: Number(document.getElementById('f-addon-quota')?.value || 5000)
    };
    const d = await api('/api/admin/billing/settings', { method: 'PUT', body: JSON.stringify(body) });
    if (!d?.ok) { err.textContent = d?.message || 'Gagal menyimpan setelan'; return; }
    showToast('Setelan disimpan', 'success');
  }

  // Pengumuman dikirim tersendiri, bukan ikut `simpanSetelan`: admin sering
  // mengubah harga tanpa berniat menyentuh pengumuman, dan sebaliknya.
  async function simpanPengumuman() {
    const err = document.getElementById('harga-error');
    err.textContent = '';
    const body = {
      pengumuman: {
        judul: document.getElementById('f-peng-judul').value,
        isi: document.getElementById('f-peng-isi').value,
        aktif: document.getElementById('f-peng-aktif').checked
      }
    };
    const d = await api('/api/admin/billing/settings', { method: 'PUT', body: JSON.stringify(body) });
    if (!d?.ok) { err.textContent = d?.message || 'Gagal menyimpan pengumuman'; return; }
    showToast('Pengumuman disimpan', 'success');
    muatSetelan();
  }

  // ── Tab "Sistem" ───────────────────────────────────────────────
  // Kesehatan, beban server, jejak aktivitas admin, pendapatan, broadcast.

  const mb = (n) => (Number(n || 0) / 1024 / 1024).toFixed(0) + ' MB';
  const jam = (detik) => {
    const d = Math.floor(Number(detik || 0) / 86400);
    const j = Math.floor((Number(detik || 0) % 86400) / 3600);
    const m = Math.floor((Number(detik || 0) % 3600) / 60);
    return d ? `${d}h ${j}j` : j ? `${j}j ${m}m` : `${m}m`;
  };

  /** Satu kotak angka: label, nilai besar, keterangan kecil. */
  const kotak = (label, nilai, sub = '') =>
    `<div class="sys-item"><div class="lbl">${esc(label)}</div>` +
    `<div class="val">${esc(nilai)}</div>` +
    (sub ? `<div class="sub">${esc(sub)}</div>` : '') + `</div>`;

  async function muatSistem() {
    const el = document.getElementById('sys-sehat');
    el.innerHTML = kotak('Memuat…', '—');
    const d = await api('/api/admin/sistem');
    if (!d?.ok) { el.innerHTML = kotak('Gagal memuat', '—'); return; }

    const h = d.kesehatan || {};
    el.innerHTML =
      kotak('Status', h.ok ? 'SEHAT' : 'BERMASALAH', h.db ? 'DB tersambung' : 'DB TIDAK tersambung') +
      kotak('Bot online', String(h.bots_online ?? 0), `dari ${h.bots_harus_jalan ?? 0} yang harus jalan`) +
      kotak('Versi', d.versi || '—') +
      kotak('Waktu server', new Date(d.waktuServer).toLocaleString('id-ID'));

    const alasan = document.getElementById('sys-alasan');
    alasan.textContent = (h.alasan || []).length ? h.alasan.join(' • ') : '';

    const r = d.resource || {};
    const ram = r.ram || {};
    const pakaiRam = ram.total ? Math.round((ram.terpakai / ram.total) * 100) : 0;
    document.getElementById('sys-resource').innerHTML =
      kotak('RAM', `${mb(ram.terpakai)} / ${mb(ram.total)}`, `${pakaiRam}% terpakai`) +
      (r.disk
        ? kotak('Disk', `${mb(r.disk.terpakai)} / ${mb(r.disk.total)}`,
            `${Math.round((r.disk.terpakai / r.disk.total) * 100)}% terpakai`)
        : kotak('Disk', '—', 'tidak terbaca')) +
      kotak('CPU', `${r.cpu?.inti ?? 0} inti`, (r.cpu?.load || []).map((n) => Number(n).toFixed(2)).join(' / ')) +
      kotak('Uptime proses', jam(r.uptimeProses), `sistem: ${jam(r.uptimeSistem)}`) +
      kotak('Node', r.node || '—', r.platform || '');
    document.getElementById('sys-load-catatan').textContent = r.cpu?.loadCatatan || '';
  }

  async function muatAudit() {
    const tb = document.querySelector('#tbl-audit tbody');
    tb.innerHTML = '<tr><td colspan="6" class="kosong">Memuat…</td></tr>';
    const d = await api('/api/admin/audit');
    document.getElementById('audit-catatan').textContent = d?.catatan || '';
    if (!d?.logs?.length) {
      tb.innerHTML = '<tr><td colspan="6" class="kosong">Belum ada aktivitas admin.</td></tr>';
      return;
    }
    tb.innerHTML = d.logs.map((l) => {
      const kelas = l.method === 'DELETE' ? 'st-rejected'
        : ['POST', 'PUT', 'PATCH'].includes(l.method) ? 'st-pending' : '';
      return `
      <tr>
        <td>${esc(logTime(l.created_at))}<br><span class="hint">${esc(tanggal(l.created_at))}</span></td>
        <td>${esc(l.username || '—')}</td>
        <td><span class="badge ${kelas}">${esc(l.method)}</span></td>
        <td class="hint">${esc(l.path || '')}</td>
        <td>${esc(String(l.status ?? ''))}</td>
        <td class="hint">${esc(l.ip || '—')}</td>
      </tr>`;
    }).join('');
  }

  async function muatLogSistem() {
    const tb = document.querySelector('#tbl-syslog tbody');
    if (!tb) return;
    const cat = document.getElementById('filter-syslog-cat')?.value || '';
    const lvl = document.getElementById('filter-syslog-lvl')?.value || '';
    const q = (document.getElementById('cari-syslog')?.value || '').trim();

    const qs = new URLSearchParams();
    if (cat) qs.set('category', cat);
    if (lvl) qs.set('level', lvl);
    if (q) qs.set('q', q);

    const d = await api('/api/admin/system-logs?' + qs.toString());
    const logs = d?.logs || [];
    tb.innerHTML = '';
    if (!logs.length) {
      tb.innerHTML = '<tr><td colspan="7" class="kosong">Belum ada catatan log sistem.</td></tr>';
      return;
    }

    const catBadge = {
      auth: 'style="background:rgba(59,130,246,.12);color:#3b82f6;"',
      admin: 'style="background:rgba(245,158,11,.12);color:#f59e0b;"',
      cron: 'style="background:rgba(168,85,247,.12);color:#a855f7;"',
      billing: 'style="background:rgba(16,185,129,.12);color:#10b981;"',
      bot: 'style="background:rgba(6,182,212,.12);color:#06b6d4;"'
    };

    const lvlBadge = {
      info: 'style="background:rgba(148,163,184,.12);color:#94a3b8;"',
      success: 'style="background:rgba(16,185,129,.15);color:#10b981;font-weight:700;"',
      warn: 'style="background:rgba(245,158,11,.15);color:#f59e0b;font-weight:700;"',
      error: 'style="background:rgba(239,68,68,.15);color:#ef4444;font-weight:700;"'
    };

    logs.forEach((l) => {
      const tr = document.createElement('tr');
      const cStyle = catBadge[l.category] || '';
      const lStyle = lvlBadge[l.level] || '';
      tr.innerHTML =
        '<td style="white-space:nowrap;font-size:12px;color:var(--mute);">' + tanggal(l.created_at) + ' ' + logTime(l.created_at) + '</td>' +
        '<td><span class="badge" ' + cStyle + '>' + esc(l.category.toUpperCase()) + '</span></td>' +
        '<td><span class="badge" ' + lStyle + '>' + esc(l.level.toUpperCase()) + '</span></td>' +
        '<td><b>' + esc(l.actor || 'system') + '</b></td>' +
        '<td><code>' + esc(l.action) + '</code></td>' +
        '<td style="font-size:13px;line-height:1.45;">' + esc(l.message) + '</td>' +
        '<td><small style="color:var(--mute);">' + esc(l.ip || '—') + '</small></td>';
      tb.appendChild(tr);
    });
  }

  async function muatPendapatan() {
    const dari = document.getElementById('rp-tgl-dari')?.value;
    const sampai = document.getElementById('rp-tgl-sampai')?.value;
    let url = '/api/admin/pendapatan';
    if (dari && sampai) {
      url += `?from=${encodeURIComponent(dari)}&to=${encodeURIComponent(sampai)}`;
    }
    const d = await api(url);
    if (!d?.ok) return;
    const r = d.ringkas || {};
    document.getElementById('rp-ringkas').innerHTML =
      kotak('Total lunas', rupiah(r.total_lunas), `${r.jumlah_lunas} pesanan`) +
      kotak('Menunggu', String(r.jumlah_pending ?? 0), 'belum dibayar') +
      kotak('Rata-rata', r.jumlah_lunas ? rupiah(Math.round(r.total_lunas / r.jumlah_lunas)) : rupiah(0), 'per pesanan');

    // Grafik batang CSS
    const seri = d.seri || [];
    const puncak = Math.max(1, ...seri.map((s) => s.total));
    document.getElementById('grafik-pendapatan').innerHTML = seri.map((s) => {
      const persen = s.total > 0 ? Math.max(4, Math.round((s.total / puncak) * 100)) : 2;
      const tgl = String(s.tgl).slice(8) + '/' + String(s.tgl).slice(5, 7);
      return `<div class="bar-wrap" title="${esc(s.tgl)} — ${esc(rupiah(s.total))} (${s.jumlah})">
        <div class="bar" style="height:${persen}%"></div>
        <div class="bar-lbl">${esc(tgl)}</div>
      </div>`;
    }).join('');
  }

  // ── Tab Saldo & Dompet ─────────────────────────────────────────
  async function muatSaldo() {
    const cari = (document.getElementById('cari-saldo')?.value || '').trim();
    const [d, k, p] = await Promise.all([
      api('/api/admin/wallet/users' + (cari ? '?q=' + encodeURIComponent(cari) : '')),
      api('/api/admin/wallet/konsistensi'),
      api('/api/admin/wallet/pendapatan'),
    ]);

    // ── Rincian pendapatan ──
    if (p?.ok) {
      const t = p.topup || { jumlah: 0, total: 0 };
      const l = p.paket_langsung || { jumlah: 0, total: 0 };
      document.getElementById('saldo-pendapatan').innerHTML =
        kotak('Dari top up saldo', rupiah(t.total), `${t.jumlah} transaksi`) +
        kotak('Dari paket langsung', rupiah(l.total), `${l.jumlah} transaksi`);
      const noteEl = document.getElementById('saldo-pendapatan-note');
      if (noteEl && p.catatan) noteEl.textContent = p.catatan;
    } else {
      document.getElementById('saldo-pendapatan').innerHTML = '<p class="m-sub" style="margin:0">Gagal memuat.</p>';
    }

    // ── Saldo beredar ──
    if (k?.ok) {
      document.getElementById('saldo-beredar').innerHTML =
        `<div style="font-size:28px;font-weight:800;color:var(--ink);letter-spacing:-0.5px;margin:8px 0;">${esc(k.saldo_beredar_text || rupiah(k.saldo_beredar))}</div>`;

      const kk = document.getElementById('saldo-konsistensi');
      if (k.konsisten) {
        kk.innerHTML = '<p style="margin:0;color:#059669;font-weight:600;display:flex;align-items:center;gap:6px;">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>' +
          'Semua saldo pengguna cocok dengan riwayat mutasi.</p>';
      } else {
        kk.innerHTML = '<p style="margin:0 0 8px;color:#b91c1c;font-weight:700">' +
          `⚠ Terdeteksi ${k.menyimpang.length} pengguna dengan selisih saldo vs mutasi</p>` +
          '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
          '<th>User</th><th style="text-align:right">Saldo Akun</th><th style="text-align:right">Total Mutasi</th>' +
          '<th style="text-align:right">Selisih</th></tr></thead><tbody>' +
          k.menyimpang.map((u) => '<tr>' +
            `<td><b>${esc(u.username)}</b></td>` +
            `<td style="text-align:right">${rupiah(u.saldo)}</td>` +
            `<td style="text-align:right">${rupiah(u.jurnal_total)}</td>` +
            `<td style="text-align:right;color:#b91c1c;font-weight:700">${rupiah(u.selisih)}</td>` +
            '</tr>').join('') +
          '</tbody></table></div>';
      }
    }

    // ── Tabel user ──
    const tbody = document.querySelector('#tbl-saldo tbody');
    if (!d?.ok) { tbody.innerHTML = '<tr><td colspan="7" class="kosong">Gagal memuat saldo.</td></tr>'; return; }
    if (!d.users.length) { tbody.innerHTML = '<tr><td colspan="7" class="kosong">Tidak ada user.</td></tr>'; return; }

    tbody.innerHTML = d.users.map((u) => {
      const auto = u.auto_renew
        ? (u.auto_renew_status === 'saldo_kurang'
            ? '<span class="badge st-rejected">saldo kurang</span>'
            : u.auto_renew_status === 'sukses'
              ? '<span class="badge st-paid">sukses</span>'
              : '<span class="badge">aktif</span>')
        : '<span class="muted">mati</span>';
      const selisih = Number(u.selisih || 0);
      const selisihBadge = selisih === 0
        ? '<span class="badge" style="background:rgba(16,185,129,.12);color:#059669;border:1px solid rgba(16,185,129,.25);font-size:11px;padding:2px 8px;font-weight:600;">Rp0 (Cocok)</span>'
        : `<span class="badge" style="background:rgba(239,68,68,.12);color:#ef4444;border:1px solid rgba(239,68,68,.25);font-size:11px;padding:2px 8px;font-weight:700;">Selisih ${rupiah(selisih)}</span>`;
      return '<tr>' +
        `<td><b>${esc(u.username)}</b></td>` +
        `<td>${esc(u.plan || '—')}</td>` +
        `<td style="text-align:right;font-weight:700">${rupiah(u.saldo)}</td>` +
        `<td style="text-align:right" class="muted">${rupiah(u.jurnal_total)}<br><span style="font-size:11px">${u.jurnal_baris} baris</span></td>` +
        `<td style="text-align:right">${selisihBadge}</td>` +
        `<td>${auto}</td>` +
        `<td class="aksi" style="text-align:right;"><button type="button" class="btn btn-outline btn-sm" onclick="bukaSaldo(${u.id}, '${esc(u.username)}')" style="height:28px;padding:0 12px;font-size:12px;border-radius:8px;">Atur Saldo</button></td>` +
        '</tr>';
    }).join('');
  }

  let saldoAktif = null;

  async function bukaSaldo(userId, username) {
    saldoAktif = userId;
    document.getElementById('ms-judul').textContent = 'Saldo — ' + username;
    document.getElementById('f-adj-jumlah').value = '';
    document.getElementById('f-adj-alasan').value = '';
    document.getElementById('modal-saldo').classList.add('open');
    await muatLedgerSaldo();
  }

  async function muatLedgerSaldo() {
    const ringkas = document.getElementById('ms-ringkas');
    const tbody = document.querySelector('#tbl-ms-ledger tbody');
    const d = await api('/api/admin/wallet/users/' + saldoAktif + '/ledger?limit=100');
    if (!d?.ok) { ringkas.innerHTML = '<p class="m-sub">Gagal memuat.</p>'; tbody.innerHTML = ''; return; }
    ringkas.innerHTML = `<div class="m-sub">Saldo sekarang</div>` +
      `<div style="font-size:24px;font-weight:800">${rupiah(d.saldo)}</div>`;
    tbody.innerHTML = d.ledger.length
      ? d.ledger.map((r) => {
          const naik = Number(r.jumlah) >= 0;
          return '<tr>' +
            `<td class="muted">${esc(logTime(r.created_at))}</td>` +
            `<td>${esc(r.tipe)}</td>` +
            `<td style="text-align:right;font-weight:700;color:${naik ? '#059669' : '#b91c1c'}">` +
              `${naik ? '+' : '−'}${rupiah(Math.abs(r.jumlah))}</td>` +
            `<td class="muted">${esc(r.alasan || '—')}</td>` +
            '</tr>';
        }).join('')
      : '<tr><td colspan="4" class="kosong">Belum ada pergerakan.</td></tr>';
  }

  function tutupSaldo() {
    document.getElementById('modal-saldo').classList.remove('open');
    saldoAktif = null;
  }

  async function simpanAdjust() {
    if (!saldoAktif) return;
    const jumlah = parseInt(String(document.getElementById('f-adj-jumlah').value || '').replace(/[^\d-]/g, ''), 10);
    const alasan = (document.getElementById('f-adj-alasan').value || '').trim();

    if (!Number.isInteger(jumlah) || jumlah === 0) {
      showToast('Jumlah harus bilangan bulat dan tidak nol.', 'error');
      return;
    }
    if (!alasan) {
      showToast('Alasan penyesuaian wajib diisi.', 'error');
      return;
    }
    const ok = await customConfirm({
      title: 'Sesuaikan Saldo',
      message: `Ubah saldo user ini sebesar ${jumlah > 0 ? '+' : ''}${rupiah(jumlah)}?\n\nAlasan: ${alasan}`,
      okText: 'Simpan Saldo'
    });
    if (!ok) return;

    const d = await api('/api/admin/wallet/users/' + saldoAktif + '/adjust', {
      method: 'POST', body: JSON.stringify({ jumlah, alasan }),
    });
    if (!d?.ok) { showToast(d?.message || 'Gagal menyimpan saldo.', 'error'); return; }
    showToast(d.message || 'Saldo berhasil disesuaikan.', 'success');
    document.getElementById('f-adj-jumlah').value = '';
    document.getElementById('f-adj-alasan').value = '';
    await muatLedgerSaldo();
    muatSaldo();
  }

  async function kirimBroadcast() {
    const teks = (document.getElementById('bc-teks').value || '').trim();
    const hasil = document.getElementById('bc-hasil');
    if (!teks) { hasil.textContent = 'Pesan masih kosong.'; return; }
    const ok = await customConfirm({
      title: 'Kirim Pesan Siaran',
      message: 'Kirim pesan siaran ini ke SEMUA pengguna aktif?',
      okText: 'Kirim Sekarang'
    });
    if (!ok) return;

    hasil.textContent = 'Mengirim…';
    const d = await api('/api/admin/broadcast', {
      method: 'POST',
      body: JSON.stringify({ teks }),
    });
    if (!d?.ok) { hasil.textContent = d?.message || 'Gagal mengirim.'; return; }
    hasil.textContent = d.message;
    if (d.gagal === 0) document.getElementById('bc-teks').value = '';
    muatAudit();
  }

  async function hapusBot(id) {
    const nama = namaBot(id);
    const ok = await customConfirm({
      title: 'Hapus Bot',
      message: `Hapus bot "${nama}" secara permanen?\n\nFolder sesi ikut dihapus dan bot harus scan QR ulang jika dibuat lagi. Tindakan ini tidak bisa dibatalkan.`,
      okText: 'Hapus Bot',
      danger: true
    });
    if (!ok) return;

    const d = await api('/api/bots/' + id, { method: 'DELETE' });
    if (!d?.ok) return showToast(d?.message || 'Gagal menghapus bot', 'error');
    showToast('Bot berhasil dihapus', 'success');
    muatBot();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const segmen = location.pathname.split('/').filter(Boolean)[1] || (location.hash || '').replace('#', '') || 'users';
    tab(segmen);

    const d = await api('/api/auth/me');
    if (!d?.ok) { location.href = '/'; return; }
    if (!d.user.is_admin) {
      alert('Halaman ini cuma untuk Administrator (' + (d.user.role_label || d.user.role) + '). Kalau role kamu baru diubah, login ulang dulu.');
      location.href = '/dashboard';
      return;
    }
    const topAv = document.getElementById('top-avatar-txt');
    if (topAv) topAv.textContent = (d.user.username || '?')[0].toUpperCase();
    document.getElementById('greeting').textContent = 'Administrator';
    document.getElementById('nav-admin').style.display = '';

    const pl = await api('/api/plans');
    if (pl?.ok) paket = pl.plans;

    muatSetelan();

    let syslogDebounce = null;
    document.getElementById('cari-syslog')?.addEventListener('input', () => {
      clearTimeout(syslogDebounce);
      syslogDebounce = setTimeout(muatLogSistem, 350);
    });

    document.getElementById('btn-filter-rp')?.addEventListener('click', () => {
      muatPendapatan();
    });
    document.getElementById('btn-reset-rp')?.addEventListener('click', () => {
      const d1 = document.getElementById('rp-tgl-dari');
      const d2 = document.getElementById('rp-tgl-sampai');
      if (d1) d1.value = '';
      if (d2) d2.value = '';
      muatPendapatan();
    });
    document.getElementById('cari-saldo')?.addEventListener('input', () => {
      muatSaldo();
    });
  });

  window.tab = tab;
  window.muatUser = muatUser;
  window.muatPendapatan = muatPendapatan;
  window.muatSaldo = muatSaldo;
  window.toggleAktif = toggleAktif;
  window.bukaUser = bukaUser;
  window.tutupUser = tutupUser;
  window.simpanUser = simpanUser;
  window.hapusUser = hapusUser;
  window.bukaSaldo = bukaSaldo;
  window.muatBot = muatBot;
  window.aturKuota = aturKuota;
  window.resetKuota = resetKuota;
  window.bukaLog = bukaLog;
  window.tutupLog = tutupLog;
  window.muatLog = muatLog;
  window.muatOrder = muatOrder;
  window.konfirmasi = konfirmasi;
  window.tolak = tolak;
  window.tambahPaket = tambahPaket;
  window.hapusPaket = hapusPaket;
  window.simpanPaket = simpanPaket;
  window.simpanSetelan = simpanSetelan;
  window.simpanPengumuman = simpanPengumuman;
  window.hapusBot = hapusBot;
  window.muatSistem = muatSistem;
  window.muatAudit = muatAudit;
  window.muatLogSistem = muatLogSistem;
  window.muatPendapatan = muatPendapatan;
  window.muatSaldo = muatSaldo;
  window.bukaSaldo = bukaSaldo;
  window.tutupSaldo = tutupSaldo;
  window.simpanAdjust = simpanAdjust;
  window.kirimBroadcast = kirimBroadcast;
})();
