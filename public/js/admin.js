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

  // ── Navigasi tab ───────────────────────────────────────────────
  function tab(nama) {
    ['user', 'bot', 'order', 'harga', 'sistem'].forEach((t) => {
      document.getElementById('pane-' + t).style.display = t === nama ? '' : 'none';
    });
    document.querySelectorAll('#tabs .tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.act === "tab('" + nama + "')");
    });
    if (nama === 'bot') muatBot();
    if (nama === 'order') { muatPendapatan(); muatOrder(); }
    if (nama === 'harga') muatSetelan();
    if (nama === 'sistem') { muatSistem(); muatAudit(); }
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
        '<td><b>' + esc(b.bot_name || '—') + '</b><br><small>' + esc(b.prefix || '.') + 'cmd</small></td>' +
        '<td>' + esc(b.username || 'user#' + b.user_id) + '</td>' +
        '<td>' + esc(b.platform || 'whatsapp') + '</td>' +
        '<td>' + (b.is_running ? '<span class="dot on"></span> Jalan' : '<span class="dot off"></span> Mati') + '</td>' +
        '<td>' + (b.received_count ?? 0) + ' / ' + (b.receive_limit || '∞') + '</td>' +
        '<td>' + (b.bonus_kuota > 0 ? '+' + b.bonus_kuota + ' <small>bonus</small>' : '<small>—</small>') + '</td>' +
        '<td>' + (b.cmd_count ?? 0) + '</td>' +
        '<td class="aksi">' +
          '<button class="btn btn-outline btn-sm" data-act="bukaLog(' + b.id + ')">Lihat Log</button> ' +
          '<button class="btn btn-outline btn-sm" data-act="aturKuota(' + b.id + ')">Kuota</button> ' +
          '<button class="btn btn-outline btn-sm" data-act="resetKuota(' + b.id + ')">Reset</button> ' +
          '<button class="btn btn-stop btn-sm" data-act="hapusBot(' + b.id + ')">Hapus</button>' +
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
    const jawab = prompt(
      'Kuota tambahan untuk "' + nama + '" (dalam pesan).\n\n' +
      '• Isi angka  → set kuota bonus sebanyak itu (di ATAS jatah paket)\n' +
      '• Isi 0      → hapus kuota bonus\n' +
      '• Kosongkan  → batal\n\n' +
      'Catatan: ini TIDAK mengubah jatah paket dan tidak menghapus pemakaian.',
      ''
    );
    if (jawab === null || jawab.trim() === '') return;

    const jumlah = parseInt(jawab, 10);
    if (!Number.isFinite(jumlah) || jumlah < 0) return showToast('Angka tidak valid', 'error');

    const d = await api('/api/admin/bots/' + id + '/kuota', {
      method: 'POST',
      body: JSON.stringify({ jumlah }),
    });
    showToast(d?.message || 'Gagal', d?.ok ? 'success' : 'error');
    if (d?.ok) muatBot();
  }

  /** Nolkan pemakaian kuota tanpa mengubah jatah paket maupun bonus. */
  async function resetKuota(id) {
    const nama = namaBot(id);
    if (!confirm('Reset pemakaian kuota "' + nama + '"?\n\n' +
      'Pesan yang sudah terpakai dianggap 0 lagi. Jatah paket & bonus tidak berubah.')) return;

    const d = await api('/api/admin/bots/' + id + '/reset-kuota', { method: 'POST' });
    showToast(d?.message || 'Gagal', d?.ok ? 'success' : 'error');
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
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td><b>' + u.username + '</b><br><small>' + (u.email || '—') + '</small></td>' +
        '<td><span class="badge role-' + (u.role_efektif || u.role) + '">' + (u.role_label || u.role) + '</span></td>' +
        '<td>' + (u.plan_name || u.plan || 'Gratis') + '</td>' +
        '<td>' + tanggal(u.plan_expired_at) + '</td>' +
        '<td>' + (u.plan_slots ?? 'paket') + '</td>' +
        '<td>' + (u.bot_count ?? u.slots_used ?? 0) + '</td>' +
        '<td>' + (u.is_active ? '<span class="dot on"></span> Aktif' : '<span class="dot off"></span> Nonaktif') + '</td>' +
        '<td class="aksi">' +
          '<button class="btn btn-sm btn-outline" data-act="bukaUser(' + u.id + ')" title="Atur paket & masa aktif">Paket</button>' +
          '<button class="btn btn-sm btn-outline" data-act="toggleAktif(' + u.id + ',' + (u.is_active ? 0 : 1) + ')">' +
            (u.is_active ? 'Matikan' : 'Aktifkan') + '</button>' +
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
    document.getElementById('mu-judul').textContent = 'Paket: ' + u.username;

    const sel = document.getElementById('mu-plan');
    // value tetap id paket (`user` = paket gratis, ikut enum DB) — cuma
    // tulisannya yang ikut label role yang sekarang ("Basic").
    sel.innerHTML = '<option value="user">Gratis (turun jadi Basic)</option>';
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
    document.getElementById('mu-error').textContent = '';
    document.getElementById('modal-user').classList.add('show');
  }

  function tutupUser() {
    document.getElementById('modal-user').classList.remove('show');
    userAktif = null;
  }

  async function simpanUser() {
    if (!userAktif) return;
    const plan = document.getElementById('mu-plan').value;
    const exp = document.getElementById('mu-exp').value;
    const slot = document.getElementById('mu-slot').value;
    const err = document.getElementById('mu-error');

    // Paket gratis = cabut langganan. Server juga memaksa ini, tapi lebih
    // enak kalau UI tidak mengirim nilai yang bakal ditolak.
    const body = plan === 'user'
      ? { plan: 'user', plan_expired_at: null, plan_slots: null }
      : { plan, plan_expired_at: exp ? exp + ' 23:59:59' : null, plan_slots: slot === '' ? null : Number(slot) };

    const d = await api('/api/admin/users/' + userAktif.id, { method: 'PATCH', body: JSON.stringify(body) });
    if (!d?.ok) { err.textContent = d?.message || 'Gagal menyimpan'; return; }
    tutupUser();
    showToast('Paket diperbarui', 'success');
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
      tr.innerHTML =
        '<td><code>' + o.order_id + '</code></td>' +
        '<td>' + (o.username || '—') + '</td>' +
        '<td>' + (o.plan_name || o.plan) + '</td>' +
        '<td>' + rupiah(o.amount) + '</td>' +
        '<td>' + (o.method === 'manual' ? 'Manual' : 'QRISku') + '</td>' +
        '<td><span class="badge st-' + o.status + '">' + o.status + '</span></td>' +
        '<td>' + tanggal(o.created_at) + '</td>' +
        '<td class="aksi">' + tombol + '</td>';
      tb.appendChild(tr);
    });
    if (!d.orders?.length) tb.innerHTML = '<tr><td colspan="8" class="kosong">Belum ada pesanan.</td></tr>';
  }

  async function konfirmasi(orderId) {
    if (!confirm('Konfirmasi pembayaran ' + orderId + '? Paket langsung aktif.')) return;
    const d = await api('/api/admin/billing/orders/' + orderId + '/confirm', { method: 'POST' });
    if (!d?.ok) return showToast(d?.message || 'Gagal konfirmasi', 'error');
    showToast('Pembayaran dikonfirmasi', 'success');
    muatOrder();
  }

  async function tolak(orderId) {
    const alasan = prompt('Alasan penolakan (opsional):') ?? null;
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
    document.getElementById('f-mode').value = d.settings?.pay_mode || 'both';
    document.getElementById('f-qris').value = d.settings?.qris_static_url || '';
    document.getElementById('f-trial').value = d.settings?.trial_days ?? 5;
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
      trial_days: Number(document.getElementById('f-trial').value || 5)
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
    alasan.textContent = (h.alasan || []).length ? '⚠️ ' + h.alasan.join(' • ') : '';

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

  async function muatPendapatan() {
    const d = await api('/api/admin/pendapatan');
    if (!d?.ok) return;
    const r = d.ringkas || {};
    document.getElementById('rp-ringkas').innerHTML =
      kotak('Total lunas', rupiah(r.total_lunas), `${r.jumlah_lunas} pesanan`) +
      kotak('Menunggu', String(r.jumlah_pending ?? 0), 'belum dibayar') +
      kotak('Rata-rata', r.jumlah_lunas ? rupiah(Math.round(r.total_lunas / r.jumlah_lunas)) : rupiah(0), 'per pesanan');

    // Grafik batang CSS, 14 hari terakhir. Tinggi relatif terhadap hari
    // terbesar; kalau semua nol, semua batang nol — bukan dipalsukan.
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

  async function kirimBroadcast() {
    const teks = (document.getElementById('bc-teks').value || '').trim();
    const hasil = document.getElementById('bc-hasil');
    if (!teks) { hasil.textContent = 'Pesan masih kosong.'; return; }
    if (!confirm('Kirim pesan ini ke SEMUA user aktif?')) return;

    hasil.textContent = 'Mengirim…';
    const d = await api('/api/admin/broadcast', {
      method: 'POST',
      body: JSON.stringify({ teks }),
    });
    if (!d?.ok) { hasil.textContent = d?.message || 'Gagal mengirim.'; return; }
    // Laporkan apa adanya — termasuk yang TIDAK sampai, dan alasannya.
    hasil.textContent = d.message;
    if (d.gagal === 0) document.getElementById('bc-teks').value = '';
    muatAudit(); // aksi ini ikut terekam; tampilkan segera
  }

  // ── Hapus bot (admin) ──────────────────────────────────────────
  // Endpoint-nya sudah ada sejak dulu (`DELETE /api/bots/:id`) dan
  // `assertOwnership` di botController SUDAH admin-aware; yang hilang cuma
  // tombolnya.
  async function hapusBot(id) {
    const nama = namaBot(id);
    if (!confirm(
      `Hapus bot "${nama}"?\n\n` +
      `Folder sesinya ikut dihapus — bot ini harus scan QR ulang kalau dibuat lagi.\n` +
      `Tindakan ini tidak bisa dibatalkan.`
    )) return;

    const d = await api('/api/bots/' + id, { method: 'DELETE' });
    if (!d?.ok) { alert(d?.message || 'Gagal menghapus bot'); return; }
    muatBot();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const d = await api('/api/auth/me');
    if (!d?.ok) { location.href = '/'; return; }
    if (!d.user.is_admin) {
      alert('Halaman ini cuma untuk Administrator (' + (d.user.role_label || d.user.role) + '). Kalau role kamu baru diubah, login ulang dulu.');
      location.href = '/dashboard';
      return;
    }
    document.getElementById('side-avatar').textContent = (d.user.username || '?')[0].toUpperCase();
    document.getElementById('side-name').textContent = d.user.username;
    document.getElementById('side-role').textContent = d.user.role_label || d.user.role;
    document.getElementById('greeting').textContent = 'Administrator';
    document.getElementById('nav-admin').style.display = '';

    const pl = await api('/api/plans');
    if (pl?.ok) paket = pl.plans;
    await muatUser();
    muatSetelan();
  });

  window.tab = tab;
  window.muatUser = muatUser;
  window.toggleAktif = toggleAktif;
  window.bukaUser = bukaUser;
  window.tutupUser = tutupUser;
  window.simpanUser = simpanUser;
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
  window.muatPendapatan = muatPendapatan;
  window.kirimBroadcast = kirimBroadcast;
})();
