(() => {
  const params = new URLSearchParams(location.search);
  const token = params.get('token') || '';

  const stateLoading = document.getElementById('state-loading');
  const stateValid = document.getElementById('state-valid');
  const stateError = document.getElementById('state-error');
  const errorMsg = document.getElementById('error-message');
  const userName = document.getElementById('user-name');
  const userEmail = document.getElementById('user-email');
  const btnConfirm = document.getElementById('btn-confirm');

  if (!token) {
    showError('Token verifikasi tidak ditemukan di tautan.');
    return;
  }

  function showError(msg) {
    stateLoading.style.display = 'none';
    stateValid.style.display = 'none';
    stateError.style.display = 'block';
    errorMsg.textContent = msg;
  }

  fetch('/api/auth/verify-info?token=' + encodeURIComponent(token))
    .then(r => r.json())
    .then(data => {
      stateLoading.style.display = 'none';
      if (!data.ok) {
        showError(data.message || 'Link verifikasi tidak valid atau sudah kadaluarsa.');
        return;
      }
      if (data.already_active) {
        location.href = '/login?verified=1';
        return;
      }
      userName.textContent = data.username;
      userEmail.textContent = data.email;
      stateValid.style.display = 'block';
    })
    .catch(() => {
      showError('Gagal memeriksa data verifikasi. Coba muat ulang halaman.');
    });

  btnConfirm.addEventListener('click', async () => {
    btnConfirm.disabled = true;
    btnConfirm.textContent = 'Memverifikasi...';
    try {
      const res = await fetch('/api/auth/verify-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        location.href = data.redirect || '/register/success';
      } else {
        showError(data.message || 'Gagal memverifikasi akun.');
      }
    } catch {
      showError('Gagal terhubung ke server saat memverifikasi.');
    }
  });
})();
