// Halaman /login dan /register pakai SATU file (public/login.html) — server
// menyajikan file yang sama untuk dua rute, pane-nya dipilih dari pathname.
// CSP nggak ngebolehin script inline, jadi logikanya di sini.
(function () {
  const daftar = location.pathname === '/register';
  document.body.dataset.mode = daftar ? 'register' : 'login';
  document.title = (daftar ? 'Daftar' : 'Masuk') + ' — parigate';
  document.getElementById('auth-login').style.display = daftar ? 'none' : 'block';
  document.getElementById('auth-register').style.display = daftar ? 'block' : 'none';

  // Toggle mata password
  document.querySelectorAll('.btn-toggle-pass').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-target');
      const inp = document.getElementById(id);
      if (!inp) return;
      const buka = inp.type === 'password';
      inp.type = buka ? 'text' : 'password';
      const off = btn.querySelector('.eye-off');
      const on = btn.querySelector('.eye-on');
      if (off && on) {
        off.style.display = buka ? 'none' : '';
        on.style.display = buka ? '' : 'none';
      }
    });
  });

  // Indikator kekuatan password pada register
  const regPass = document.getElementById('reg-password');
  const regStr = document.getElementById('reg-strength');
  const regStrTxt = document.getElementById('reg-strength-txt');

  function cekKekuatan(pass) {
    if (!pass) return { level: '', label: 'Belum diisi' };
    let skor = 0;
    if (pass.length >= 8) skor++;
    if (pass.length >= 10) skor++;
    if (/[a-z]/.test(pass) && /[A-Z]/.test(pass)) skor++;
    if (/\d/.test(pass)) skor++;
    if (/[^a-zA-Z0-9]/.test(pass)) skor++;

    if (pass.length < 8 || skor <= 2) return { level: 'weak', label: 'Lemah' };
    if (skor === 3) return { level: 'medium', label: 'Sedang' };
    return { level: 'strong', label: 'Kuat' };
  }

  if (regPass && regStr && regStrTxt) {
    regPass.addEventListener('input', () => {
      const { level, label } = cekKekuatan(regPass.value);
      regStr.className = 'pass-strength' + (level ? ' ' + level : '');
      regStrTxt.textContent = label;
    });
  }

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

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('login-error');
    err.classList.remove('show');
    try {
      const data = await kirim('/api/auth/login', {
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

    const pass = document.getElementById('reg-password').value;
    const { level } = cekKekuatan(pass);
    if (level !== 'strong') {
      err.textContent = 'Password harus berstatus Kuat (min. 8 karakter, kombinasi huruf besar, kecil & angka)';
      err.classList.add('show');
      return;
    }

    try {
      const data = await kirim('/api/auth/register', {
        username: document.getElementById('reg-username').value.trim(),
        email: document.getElementById('reg-email').value.trim(),
        password: pass
      });
      if (data.ok) location.href = '/dashboard';
      else { err.textContent = data.message; err.classList.add('show'); }
    } catch { err.textContent = 'Gagal terhubung ke server'; err.classList.add('show'); }
  });
})();
