// Halaman ini dulunya inline <script>, jadi fungsi-fungsinya global.
// CSP sekarang nggak ngebolehin script inline, jadi dibungkus fungsi biasa —
// yang perlu dipanggil HTML diekspor ke window di bawah.
(function () {
  // ── Live stats ──────────────────────────────────────────────────
  function updateStats(s) {
    const short = n => n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };
    set('stat-bots', (s.total_bots_online ?? 0).toLocaleString('id-ID'));
    set('stat-users', (s.total_users ?? 0).toLocaleString('id-ID'));
    set('stat-messages', (s.total_messages ?? 0).toLocaleString('id-ID'));
    if (s.total_commands) {
      set('stat-commands', Number(s.total_commands).toLocaleString('id-ID'));
      set('mk-cmds', Number(s.total_commands).toLocaleString('id-ID'));
      set('rfc-cmds', Number(s.total_commands).toLocaleString('id-ID'));
    }
    set('mk-msgs', short(s.total_messages ?? 0));
    set('mk-bots', short(s.total_bots_online ?? 0));
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
        '<a class="btn ' + (isPop ? 'btn-dark' : 'btn-outline') + ' pc-btn" href="/register">Get Started <svg class="arr-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg></a>' +
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

    if (window.gsap && window.ScrollTrigger) {
      gsap.from('#price-grid .price-card', {
        scrollTrigger: { trigger: '#harga', start: 'top 82%' },
        y: 50, opacity: 0, stagger: 0.14, duration: 0.85, ease: 'power3.out'
      });
      ScrollTrigger.refresh();
    }
  }).catch(() => {});

  // ── Testimoni ───────────────────────────────────────────────────
  const tst = [
    { n: "Michael Grant", r: "Content Creator", t: "It's not just about followers, it's about building a real community that supports each other." },
    { n: "David Kim", r: "Social Media Strategist", t: "I've grown my audience faster here than on any other messaging platform I've tried." },
    { n: "Emma Rodriguez", r: "Digital Marketer at SocialLift", t: "User-friendly, engaging, and built for growth. Every connection you make here is meaningful." },
    { n: "Rizky Pratama", r: "Store Bot Community Lead", t: "Bot online 24 jam nonstop dan stabil banget. Pelanggan toko senang karena semua respon instan tanpa delay." }
  ];
  const g = document.getElementById("tst-grid");
  const starSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="#f59e0b" stroke="#f59e0b"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  const starBlock = '<div class="tst-head"><div class="tst-stars">' + starSvg.repeat(5) + '</div><span class="tst-rating-tag">Rating</span></div>';
  tst.forEach(x => {
    const el = document.createElement("div");
    el.className = "tst";
    el.innerHTML =
      starBlock +
      '<p class="tst-t">“' + x.t + '”</p>' +
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

  // ── Lenis Smooth Momentum Inertia Scroll (Opsi 2) ────────────────
  if (window.Lenis) {
    const lenis = new Lenis({
      duration: 1.25,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      orientation: 'vertical',
      smoothWheel: true,
      wheelMultiplier: 1.05,
      touchMultiplier: 1.5,
    });
    window.lenis = lenis;

    function raf(time) {
      lenis.raf(time);
      requestAnimationFrame(raf);
    }
    requestAnimationFrame(raf);

    if (window.ScrollTrigger) {
      lenis.on('scroll', ScrollTrigger.update);
      gsap.ticker.add((time) => {
        lenis.raf(time * 1000);
      });
      gsap.ticker.lagSmoothing(0);
    }
  }

  // ── GSAP + ScrollTrigger Animations ──────────────────────────────
  if (window.gsap && window.ScrollTrigger) {
    gsap.registerPlugin(ScrollTrigger);

    // ── Opsi 3: Multi-Layer Parallax Depth (Stripe / Raycast style) ──
    // A. Hero Parallax: visual orbit kosmik melayang lebih lambat saat di-scroll
    if (document.querySelector('.hero-visual')) {
      gsap.to('.hero-visual', {
        y: 110,
        ease: 'none',
        scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: 0.5 }
      });
    }
    if (document.querySelector('.hero-l')) {
      gsap.to('.hero-l', {
        y: 50,
        ease: 'none',
        scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: 0.5 }
      });
    }

    // B. Features Bento Grid Differential Parallax (layer kartu bergerak beda kedalaman)
    if (window.innerWidth > 768) {
      document.querySelectorAll('#features .card').forEach(function (card, i) {
        gsap.fromTo(card,
          { y: (i % 2 === 0 ? 25 : -25) },
          {
            y: (i % 2 === 0 ? -25 : 25),
            ease: 'none',
            scrollTrigger: { trigger: '#features', start: 'top bottom', end: 'bottom top', scrub: 0.8 }
          }
        );
      });

      // C. How-to Steps Floating Parallax
      document.querySelectorAll('#howto .step').forEach(function (step, i) {
        gsap.fromTo(step,
          { y: 20 * (i - 1) },
          {
            y: -20 * (i - 1),
            ease: 'none',
            scrollTrigger: { trigger: '#howto', start: 'top bottom', end: 'bottom top', scrub: 0.7 }
          }
        );
      });
    }

    // 1. Section Headings & Labels Reveal
    document.querySelectorAll('body.page-index section .wrap > h2, body.page-index section .sec-label, body.page-index section .sub').forEach(function (el) {
      gsap.from(el, {
        scrollTrigger: { trigger: el, start: 'top 88%' },
        y: 35, opacity: 0, duration: 0.75, ease: 'power3.out'
      });
    });

    // 2. Stats cards stagger
    gsap.from('#stats .stat', {
      scrollTrigger: { trigger: '#stats', start: 'top 84%' },
      y: 45, opacity: 0, stagger: 0.1, duration: 0.8, ease: 'power3.out'
    });

    // 3. Testimonials cards stagger & left box
    gsap.from('#testimoni .tst', {
      scrollTrigger: { trigger: '#testimoni', start: 'top 80%' },
      y: 45, opacity: 0, stagger: 0.1, duration: 0.8, ease: 'power3.out'
    });
    const tstLeft = document.querySelector('.tst-left-box');
    if (tstLeft) {
      gsap.from(tstLeft, {
        scrollTrigger: { trigger: '#testimoni', start: 'top 82%' },
        y: 40, opacity: 0, duration: 0.85, ease: 'power3.out'
      });
    }
  }

window.toggleTheme = toggleTheme; window.openAuth = openAuth; window.closeAuth = closeAuth;
window.switchAuth = switchAuth;

})();
