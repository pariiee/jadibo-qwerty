// Halaman /login dan /register pakai SATU file (public/login.html) — server
// menyajikan file yang sama untuk dua rute, pane-nya dipilih dari pathname.
// CSP nggak ngebolehin script inline, jadi logikanya di sini.
(function () {
  const daftar = location.pathname === '/register';
  document.body.dataset.mode = daftar ? 'register' : 'login';
  document.title = (daftar ? 'Daftar' : 'Masuk') + ' — YaaParBot';
  document.getElementById('auth-login').style.display = daftar ? 'none' : 'block';
  document.getElementById('auth-register').style.display = daftar ? 'block' : 'none';

  // Sama seperti index.js — kalau sesi masih hidup, nggak ada gunanya lihat form.
  fetch('/api/auth/me', { credentials: 'include' }).then(r => r.json()).then(d => {
    if (d.ok) location.href = '/dashboard';
  }).catch(() => {});

  async function kirim(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body)
    });
    return res.json();
  }

  function pasang(formId, errId, url, ambil) {
    document.getElementById(formId).addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById(errId);
      err.classList.remove('show');
      try {
        const data = await kirim(url, ambil());
        if (data.ok) location.href = '/dashboard';
        else { err.textContent = data.message; err.classList.add('show'); }
      } catch { err.textContent = 'Gagal terhubung ke server'; err.classList.add('show'); }
    });
  }

  pasang('login-form', 'login-error', '/api/auth/login', () => ({
    username: document.getElementById('login-username').value.trim(),
    password: document.getElementById('login-password').value
  }));

  pasang('register-form', 'reg-error', '/api/auth/register', () => ({
    username: document.getElementById('reg-username').value.trim(),
    password: document.getElementById('reg-password').value
  }));
})();
