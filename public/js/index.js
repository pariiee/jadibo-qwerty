// Halaman ini dulunya inline <script>, jadi fungsi-fungsinya global.
// CSP sekarang nggak ngebolehin script inline, jadi dibungkus fungsi biasa —
// yang perlu dipanggil HTML diekspor ke window di bawah.
(function () {
// ── FAQ ─────────────────────────────────────────────────────────
  const faqs = [
    { q: 'Berapa batas bot per akun?', a: 'Satu bot per paket yang aktif. Akun gratis belum dapat slot — slot terbuka setelah kamu klaim Trial atau bayar paket.' },
    { q: 'Platform apa saja yang didukung?', a: 'WhatsApp (via Baileys) dan Telegram (via Bot API). Bisa tambah platform lain lewat plugin.' },
    { q: 'Apakah sesi WhatsApp tersimpan?', a: 'Ya, setiap bot punya file SQLite session tersendiri di folder /sessions/bot_<id>/. Data tidak bercampur antar bot.' },
    { q: 'Bagaimana cara login WhatsApp?', a: 'Kamu bisa memilih Scan QR Code atau Pairing Code (8 digit) yang langsung ditampilkan di dashboard.' },
    { q: 'Apakah bisa custom prefix dan footer?', a: 'Bisa. Setiap bot bisa dikonfigurasi dengan prefix, footer text, nama bot, nomor owner, dan deskripsi sendiri.' },
    { q: 'Apa beda role user, premium, dan admin?', a: 'User dibatasi kuota paketnya. Premium mendapat jatah lebih. Admin punya akses penuh: kelola semua user, bot, dan harga paket.' },
    { q: 'Bagaimana cara bayar paket?', a: 'Pilih paket di halaman Langganan, lalu bayar otomatis lewat QRIS atau transfer manual dengan QR. Paket aktif setelah pembayaran terkonfirmasi.' },
    { q: 'Ada trial?', a: 'Ada. Trial 5 hari gratis: 1 slot bot, 5.000 pesan, masa aktif 5 hari — cuma bisa diklaim sekali seumur akun.' }
  ];
  const faqBox = document.getElementById('faq-list');
  faqs.forEach((f, i) => {
    const item = document.createElement('div');
    item.className = 'faq-item';
    const qBtn = document.createElement('button');
    qBtn.className = 'faq-q';
    qBtn.type = 'button';
    const span = document.createElement('span');
    span.textContent = f.q;
    const chev = document.createElement('span');
    chev.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    qBtn.append(span, chev);
    const ans = document.createElement('div');
    ans.className = 'faq-a';
    ans.textContent = f.a;
    qBtn.addEventListener('click', () => {
      const open = ans.classList.contains('open');
      faqBox.querySelectorAll('.faq-a').forEach(a => a.classList.remove('open'));
      if (!open) ans.classList.add('open');
    });
    item.append(qBtn, ans);
    faqBox.appendChild(item);
  });

  // ── Live stats ──────────────────────────────────────────────────
  function updateStats(s) {
    const short = n => n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
    document.getElementById('stat-bots').textContent     = (s.total_bots_online ?? 0).toLocaleString('id-ID');
    document.getElementById('stat-users').textContent    = (s.total_users ?? 0).toLocaleString('id-ID');
    document.getElementById('stat-messages').textContent = (s.total_messages ?? 0).toLocaleString('id-ID');
    document.getElementById('mk-msgs').textContent = short(s.total_messages ?? 0);
    document.getElementById('mk-bots').textContent = short(s.total_bots_online ?? 0);
  }
  try {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host);
    ws.onmessage = e => { try { const d = JSON.parse(e.data); if (d.type === 'stats') updateStats(d.payload); } catch {} };
    ws.onclose = () => setTimeout(() => { try { location.reload(); } catch {} }, 15000);
  } catch {}
  fetch('/api/stats').then(r => r.json()).then(d => { if (d.ok) updateStats(d.stats); }).catch(() => {});

  // ── Harga ───────────────────────────────────────────────────────
  // Diambil dari /api/plans, bukan ditulis ulang di HTML — kalau admin ubah
  // harga di /admin, landing ikut berubah (nggak ada angka yang bisa basi).
  fetch('/api/plans').then(r => r.json()).then(d => {
    if (!d?.ok) return;
    const rupiah = n => 'Rp' + Number(n || 0).toLocaleString('id-ID');
    const grid = document.getElementById('price-grid');
    d.plans.forEach(p => {
      const el = document.createElement('div');
      el.className = 'price-card';
      el.innerHTML =
        '<div class="pc-nama">' + p.name + '</div>' +
        '<div class="pc-harga">' + rupiah(p.price) + '<small> / ' + p.days + ' hari</small></div>' +
        '<ul class="pc-li">' +
          '<li>Jumlah Fitur : ' + (p.max_fitur || 0) + '</li>' +
          '<li>Owner Number : ' + (p.owner_max || 0) + '</li>' +
          '<li>Received Limit : ' + (p.receive_limit || 0).toLocaleString('id-ID') + '</li>' +
          '<li>Masa Aktif : ' + (p.days || 0) + ' Hari</li>' +
          '<li>' + (p.slots || 0) + ' slot bot</li>' +
        '</ul>' +
        '<p class="pc-extra">Customize Bot</p>' +
        '<a class="btn btn-dark" href="/register">Pilih Paket</a>';
      grid.appendChild(el);
    });
    // Trial = dimensinya sama dengan paket (fitur/owner/received/masa aktif),
    // tapi slotnya baru kelihatan setelah diklaim, jadi angkanya dari /api/plans.
    if (d.trial) document.getElementById('price-note').textContent =
      'Belum yakin? Klaim Trial ' + d.trial.days + ' hari gratis dulu — ' + d.trial.slots +
      ' slot bot, cuma sekali seumur akun.';
  }).catch(() => {});

  // ── Testimoni ───────────────────────────────────────────────────
  const tst = [
    { n: 'Rizky', r: 'Owner Store Bot', t: 'Bot on 24 jam, jarang delay. Pelanggan senang karena balasannya cepat.' },
    { n: 'Nadia', r: 'Admin Grup Jualan', t: 'Setup-nya cuma scan QR, nggak sampai semenit. Fiturnya banyak banget.' },
    { n: 'Bagas', r: 'Reseller Bot', t: 'Bisa atur prefix dan footer sendiri, jadi tiap bot klien kelihatan beda.' },
    { n: 'Sari', r: 'Owner Komunitas', t: 'Limit pesannya jelas kelihatan di dashboard, jadi nggak kaget pas kena batas.' },
    { n: 'Dimas', r: 'Freelancer', t: 'Harga paketnya masuk akal buat yang baru mulai. Naik paket tinggal bayar lagi.' },
    { n: 'Putri', r: 'Owner Toko Online', t: 'Menu dan fiturnya kepotong sesuai paket, jadi nggak bingung milih yang mana.' }
  ];
  const g = document.getElementById('tst-grid');
  tst.forEach(x => {
    const el = document.createElement('div');
    el.className = 'tst';
    el.innerHTML =
      '<p class="tst-t">' + x.t + '</p>' +
      '<div class="tst-f"><i>' + x.n[0] + '</i><div><b>' + x.n + '</b><span>' + x.r + '</span></div></div>';
    g.appendChild(el);
  });

  // ── Auth modal ──────────────────────────────────────────────────
  function openAuth(mode) {
    document.getElementById('auth-overlay').classList.add('show');
    switchAuth(mode);
  }
  function closeAuth() { document.getElementById('auth-overlay').classList.remove('show'); }
  function switchAuth(mode) {
    const show = mode === 'register' ? 'auth-register' : 'auth-login';
    document.getElementById('auth-login').style.display  = show === 'auth-login'  ? 'block' : 'none';
    document.getElementById('auth-register').style.display = show === 'auth-register' ? 'block' : 'none';
  }
  document.getElementById('auth-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeAuth(); });

  async function authFetch(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body)
    });
    return res.json();
  }

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('login-error');
    err.classList.remove('show');
    try {
      const data = await authFetch('/api/auth/login', {
        username: document.getElementById('login-username').value.trim(),
        password: document.getElementById('login-password').value
      });
      if (data.ok) location.href = '/dashboard';
      else { err.textContent = data.message; err.classList.add('show'); }
    } catch { err.textContent = 'Gagal terhubung ke server'; err.classList.add('show'); }
  });

  document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('reg-error');
    err.classList.remove('show');
    try {
      const data = await authFetch('/api/auth/register', {
        username: document.getElementById('reg-username').value.trim(),
        password: document.getElementById('reg-password').value
      });
      if (data.ok) location.href = '/dashboard';
      else { err.textContent = data.message; err.classList.add('show'); }
    } catch { err.textContent = 'Gagal terhubung ke server'; err.classList.add('show'); }
  });

  // Cek sesi via cookie — kalau sudah login, langsung ke dashboard
  fetch('/api/auth/me', { credentials: 'include' }).then(r => r.json()).then(d => {
    if (d.ok) location.href = '/dashboard';
  }).catch(() => {});
window.toggleTheme = toggleTheme; window.openAuth = openAuth; window.closeAuth = closeAuth;
window.switchAuth = switchAuth; window.openFaq = openFaq; window.toggleFaq = toggleFaq;

})();
