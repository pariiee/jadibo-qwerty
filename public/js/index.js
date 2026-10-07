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
    { q: 'Bagaimana cara bayar paket?', a: 'Pilih paket di halaman Pricing, lalu bayar otomatis lewat QRIS atau transfer manual dengan QR. Paket aktif setelah pembayaran terkonfirmasi.' },
    { q: 'Ada trial?', a: 'Ada. Trial 5 hari gratis: 1 slot bot, 5.000 pesan, masa aktif 5 hari — cuma bisa diklaim sekali seumur akun.' }
  ];
  // §7.11 FAQ: <details>/<summary> bawaan browser — accordion + operasi
  // keyboard didapat gratis, jadi nol JS. Dulu tiap item dibangun manual
  // dengan tombol dan kelas `.open`, jadi butuh listener + penanda sendiri.
  // Item PERTAMA dibuka sesuai spec.
  const faqBox = document.getElementById('faq-list');
  faqs.forEach((f, i) => {
    const item = document.createElement('details');
    item.className = 'faq-item';
    if (i === 0) item.open = true;
    const q = document.createElement('summary');
    q.className = 'faq-q';
    q.textContent = f.q;
    const ans = document.createElement('p');
    ans.className = 'faq-a';
    ans.textContent = f.a;
    item.append(q, ans);
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
  // Isi kartunya dari `daftarPaket()` (act.js) — sama persis dengan /pricing.
  fetch('/api/plans').then(r => r.json()).then(d => {
    if (!d?.ok) return;
    const rupiah = n => 'Rp' + Number(n || 0).toLocaleString('id-ID');
    const grid = document.getElementById('price-grid');
    d.plans.forEach((p, idx) => {
      const k = daftarPaket(p, d.fitur || 0);
      const isPop = idx === 1 || p.name.toLowerCase().includes('pro') || p.name.toLowerCase().includes('premium');
      const el = document.createElement('div');
      el.className = 'price-card' + (isPop ? ' price-card-popular' : '');
      el.innerHTML =
        (isPop ? '<div class="pc-badge">Popular</div>' : '') +
        '<div class="pc-top">' +
          '<div class="pc-nama">' + p.name + '</div>' +
          '<div class="pc-desc">Solusi otomatisasi andal untuk operasional bot kamu.</div>' +
          '<div class="pc-harga">' + rupiah(p.price) + '<span>/ ' + p.days + ' hari</span></div>' +
        '</div>' +
        '<a class="btn ' + (isPop ? 'btn-dark' : 'btn-outline') + ' pc-btn" href="/register">Get Started ↗</a>' +
        '<div class="pc-divider"></div>' +
        '<div class="pc-feat-label">Fitur &amp; Kapasitas:</div>' +
        '<ul class="pc-li">' +
          k.baris.map(t => '<li><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> ' + t + '</li>').join('') +
        '</ul>' +
        (k.extra ? '<div class="pc-extra"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg> ' + k.extra + '</div>' : '');
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
  // ── Scroll-spy navbar ───────────────────────────────────────────
  // Nggak mindahin apa pun, cuma nandain tautan yang lagi dibaca.
  // Batasnya sempit (-45% atas, -50% bawah) = pita tipis di tengah layar,
  // jadi cuma satu bagian yang "menang" walaupun dua section kelihatan.
  const tautan = Array.prototype.slice.call(document.querySelectorAll('.nav-links a[href^="#"]'));
  if (tautan.length && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting) return;
        tautan.forEach(function (a) { a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id); });
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    tautan.forEach(function (a) { const s = document.querySelector(a.getAttribute('href')); if (s) io.observe(s); });
  }

window.toggleTheme = toggleTheme; window.openAuth = openAuth; window.closeAuth = closeAuth;
window.switchAuth = switchAuth;

})();
