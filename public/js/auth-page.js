// Halaman /login, /register, /forgot-password, dan /reset-password pakai SATU file (public/login.html) — server
// menyajikan file yang sama untuk rute auth, pane-nya dipilih dari pathname.
// CSP nggak ngebolehin script inline, jadi logikanya di sini.
(function () {
  const path = location.pathname;
  const isDaftar = path === '/register';
  const isForgot = path === '/forgot-password';
  const isReset = path === '/reset-password';

  document.body.dataset.mode = isDaftar ? 'register' : (isForgot ? 'forgot' : (isReset ? 'reset' : 'login'));
  document.title = (isDaftar ? 'Daftar' : (isForgot ? 'Lupa Password' : (isReset ? 'Reset Password' : 'Masuk'))) + ' — qwertygate';

  document.getElementById('auth-login').style.display = (!isDaftar && !isForgot && !isReset) ? 'block' : 'none';
  document.getElementById('auth-register').style.display = isDaftar ? 'block' : 'none';
  document.getElementById('auth-forgot').style.display = isForgot ? 'block' : 'none';
  document.getElementById('auth-reset').style.display = isReset ? 'block' : 'none';

  // Tampilkan pesan error jika redirect dari OAuth (misal ?err=...)
  const params = new URLSearchParams(location.search);
  const errParam = params.get('err');
  if (errParam) {
    const errBox = document.getElementById(isDaftar ? 'reg-error' : 'login-error');
    if (errBox) {
      errBox.textContent = errParam;
      errBox.classList.add('show');
    }
  }

  // Token reset password dari URL
  const resetToken = params.get('token');
  if (isReset) {
    if (!resetToken) {
      const rErr = document.getElementById('reset-error');
      if (rErr) {
        rErr.textContent = 'Token reset tidak ditemukan di tautan. Silakan minta tautan baru dari halaman Lupa Password.';
        rErr.classList.add('show');
      }
      const rBtn = document.getElementById('reset-submit-btn');
      if (rBtn) rBtn.disabled = true;
    } else {
      const tokInput = document.getElementById('reset-token');
      if (tokInput) tokInput.value = resetToken;
    }
  }

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

  // Forgot password handler
  const forgotForm = document.getElementById('forgot-form');
  if (forgotForm) {
    forgotForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById('forgot-error');
      const ok = document.getElementById('forgot-ok');
      const btn = document.getElementById('forgot-submit-btn');
      err.classList.remove('show');
      ok.style.display = 'none';
      btn.disabled = true;
      btn.textContent = 'Mengirim...';

      try {
        const data = await kirim('/api/auth/forgot-password', {
          email: document.getElementById('forgot-email').value.trim()
        });
        if (data.ok) {
          ok.textContent = 'Instruksi reset password telah dikirim ke email kamu! Silakan cek kotak masuk / spam.';
          ok.style.display = 'block';
          forgotForm.reset();
        } else {
          err.textContent = data.message || 'Gagal mengirim email reset';
          err.classList.add('show');
        }
      } catch {
        err.textContent = 'Gagal terhubung ke server';
        err.classList.add('show');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Send Reset Link';
      }
    });
  }

  // Reset password handler
  const resetForm = document.getElementById('reset-form');
  if (resetForm) {
    resetForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById('reset-error');
      const ok = document.getElementById('reset-ok');
      const btn = document.getElementById('reset-submit-btn');
      err.classList.remove('show');
      ok.style.display = 'none';

      const pass = document.getElementById('reset-pass').value;
      const token = document.getElementById('reset-token').value;

      if (!token) {
        err.textContent = 'Token reset tidak ditemukan.';
        err.classList.add('show');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Menyimpan...';

      try {
        const data = await kirim('/api/auth/reset-password', { token, password: pass });
        if (data.ok) {
          ok.textContent = 'Password berhasil diperbarui! Mengalihkan ke login...';
          ok.style.display = 'block';
          setTimeout(() => { location.href = '/login'; }, 1800);
        } else {
          err.textContent = data.message || 'Gagal mereset password';
          err.classList.add('show');
          btn.disabled = false;
          btn.textContent = 'Update Password';
        }
      } catch {
        err.textContent = 'Gagal terhubung ke server';
        err.classList.add('show');
        btn.disabled = false;
        btn.textContent = 'Update Password';
      }
    });
  }
})();
