// Halaman ini dulunya inline <script>, jadi fungsi-fungsinya global.
// CSP sekarang nggak ngebolehin script inline, jadi dibungkus fungsi biasa —
// yang perlu dipanggil HTML diekspor ke window di bawah.
(function () {
// ── FAQ ─────────────────────────────────────────────────────────
  const faqs = [
    { q: 'Berapa batas bot per akun?', a: 'Setiap akun user mendapat 2 slot bot secara default. King (admin) tidak ada batasnya.' },
    { q: 'Platform apa saja yang didukung?', a: 'WhatsApp (via Baileys) dan Telegram (via Bot API). Bisa tambah platform lain lewat plugin.' },
    { q: 'Apakah sesi WhatsApp tersimpan?', a: 'Ya, setiap bot punya file SQLite session tersendiri di folder /sessions/bot_<id>/. Data tidak bercampur antar bot.' },
    { q: 'Bagaimana cara login WhatsApp?', a: 'Kamu bisa memilih Scan QR Code atau Pairing Code (8 digit) yang langsung ditampilkan di dashboard.' },
    { q: 'Apakah bisa custom prefix dan footer?', a: 'Bisa. Setiap bot bisa dikonfigurasi dengan prefix, footer text, nama bot, nomor owner, dan deskripsi sendiri.' },
    { q: 'Apa itu role King?', a: 'King adalah super admin dengan akses penuh: manajemen semua user, semua bot, dan command owner seperti broadcast dan ban.' }
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
