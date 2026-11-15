(() => {
  const boxEmail = document.getElementById('box-email');
  const elEmail = document.getElementById('pending-email');
  const btnResend = document.getElementById('btn-resend');
  const statusEl = document.getElementById('resend-status');

  // Ambil email dari cookie session yang aman (anti-tampering attacker via query string)
  fetch('/api/auth/pending-info')
    .then(r => r.json())
    .then(data => {
      if (!data.ok || !data.email) {
        location.href = '/register';
        return;
      }
      elEmail.textContent = data.email;
      boxEmail.style.display = 'block';
    })
    .catch(() => {
      location.href = '/register';
    });

  btnResend.addEventListener('click', async () => {
    btnResend.disabled = true;
    btnResend.textContent = 'Mengirim...';
    statusEl.style.display = 'none';

    try {
      const res = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (res.ok) {
        statusEl.style.background = 'rgba(16,185,129,.1)';
        statusEl.style.border = '1px solid rgba(16,185,129,.25)';
        statusEl.style.color = 'var(--green, #10b981)';
        statusEl.textContent = data.message || 'Email verifikasi baru sudah dikirim ke inbox kamu.';
        statusEl.style.display = 'block';
        btnResend.textContent = 'Email Terkirim';
        setTimeout(() => {
          btnResend.disabled = false;
          btnResend.textContent = 'Kirim ulang email verifikasi';
        }, 15000);
      } else {
        statusEl.style.background = 'rgba(239,68,68,.1)';
        statusEl.style.border = '1px solid rgba(239,68,68,.25)';
        statusEl.style.color = 'var(--red, #ef4444)';
        statusEl.textContent = data.message || 'Gagal mengirim ulang email.';
        statusEl.style.display = 'block';
        btnResend.disabled = false;
        btnResend.textContent = 'Kirim ulang email verifikasi';
      }
    } catch {
      statusEl.style.background = 'rgba(239,68,68,.1)';
      statusEl.style.border = '1px solid rgba(239,68,68,.25)';
      statusEl.style.color = 'var(--red, #ef4444)';
      statusEl.textContent = 'Gagal terhubung ke server.';
      statusEl.style.display = 'block';
      btnResend.disabled = false;
      btnResend.textContent = 'Kirim ulang email verifikasi';
    }
  });
})();
