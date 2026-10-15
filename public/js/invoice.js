// public/js/invoice.js — Halaman Invoice Tagihan QRIS
(function () {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const rupiah = (v) => 'Rp ' + Number(v || 0).toLocaleString('id-ID');

  const waktu = (v) => {
    if (!v) return '—';
    const s = /Z|[+-]\d\d:?$/.test(String(v)) ? v : String(v).replace(' ', 'T') + 'Z';
    const d = new Date(s);
    return isNaN(d) ? String(v) : d.toLocaleString('id-ID', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
  };

  const pathParts = location.pathname.split('/invoice/');
  const orderId = (pathParts[1] || '').split('/')[0].split('?')[0];

  if (!orderId) {
    alert('Kode tagihan tidak valid.');
    location.href = '/saldo';
    return;
  }

  let timerInterval = null;
  let pollingInterval = null;
  let expiredTime = 0;

  async function api(path, opts = {}) {
    try {
      const res = await fetch(path, {
        ...opts, credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      });
      if (res.status === 401) { location.href = '/login'; return null; }
      return res.json();
    } catch { return null; }
  }

  function updateBadge(status) {
    const b = document.getElementById('inv-status-badge');
    if (status === 'paid') {
      b.innerHTML = '<span class="badge-status badge-paid">✅ LUNAS</span>';
    } else if (status === 'expired' || status === 'cancelled') {
      b.innerHTML = '<span class="badge-status badge-expired">❌ KEDALUWARSA</span>';
    } else {
      b.innerHTML = '<span class="badge-status badge-pending">⏳ MENUNGGU BAYAR</span>';
    }
  }

  function startCountdown(expiredAtStr) {
    if (!expiredAtStr) return;
    const s = /Z|[+-]\d\d:?$/.test(String(expiredAtStr)) ? expiredAtStr : String(expiredAtStr).replace(' ', 'T') + 'Z';
    expiredTime = new Date(s).getTime();
    if (isNaN(expiredTime)) return;

    clearInterval(timerInterval);
    const timerEl = document.getElementById('inv-timer');

    function tick() {
      const remaining = Math.max(0, Math.floor((expiredTime - Date.now()) / 1000));
      const m = Math.floor(remaining / 60);
      const sec = remaining % 60;
      timerEl.textContent = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;

      if (remaining <= 0) {
        clearInterval(timerInterval);
        clearInterval(pollingInterval);
        updateBadge('expired');
        timerEl.textContent = '00:00 (Waktu Habis)';
      }
    }

    tick();
    timerInterval = setInterval(tick, 1000);
  }

  function handleLunas() {
    clearInterval(timerInterval);
    clearInterval(pollingInterval);
    updateBadge('paid');
    document.getElementById('inv-countdown-box').style.display = 'none';
    document.getElementById('inv-qr-container').style.display = 'none';
    document.getElementById('inv-actions').style.display = 'none';
    document.getElementById('inv-success-box').style.display = '';

    setTimeout(() => {
      location.href = '/saldo';
    }, 2800);
  }

  async function muatDetail() {
    const d = await api('/api/billing/orders/' + encodeURIComponent(orderId));
    if (!d || !d.ok || !d.order) {
      alert('Order tidak ditemukan atau sudah dihapus.');
      location.href = '/saldo';
      return;
    }

    const o = d.order;
    document.getElementById('inv-order-id').textContent = o.order_id;
    document.getElementById('inv-amount').textContent = rupiah(o.amount);
    document.getElementById('inv-plan-name').textContent = o.plan === 'topup' ? 'Top up Saldo' : `Paket ${o.plan.toUpperCase()}`;
    document.getElementById('inv-created-at').textContent = waktu(o.created_at);

    if (o.qr_image) {
      document.getElementById('inv-qr-img').src = o.qr_image;
    }

    if (o.pay_url) {
      const linkBtn = document.getElementById('btn-pay-link');
      linkBtn.href = o.pay_url;
      linkBtn.style.display = '';
    }

    updateBadge(o.status);

    if (o.status === 'paid') {
      handleLunas();
      return;
    }

    if (o.status === 'pending') {
      startCountdown(o.expired_at);
      // Polling berkala setiap 7 detik
      if (!pollingInterval) {
        pollingInterval = setInterval(async () => {
          const res = await api('/api/billing/orders/' + encodeURIComponent(orderId));
          if (res?.ok && res?.order?.status === 'paid') {
            handleLunas();
          }
        }, 7000);
      }
    }
  }

  window.cekStatusManual = async function (btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Memeriksa…'; }
    try {
      const d = await api('/api/billing/orders/' + encodeURIComponent(orderId) + '/check', { method: 'POST' });
      if (d?.status === 'paid') {
        handleLunas();
      } else {
        alert(d?.message || 'Belum terkonfirmasi. Silakan scan QRIS dan bayar.');
        await muatDetail();
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🔄 Cek Status Pembayaran'; }
    }
  };

  const sapaan = document.getElementById('greeting');
  if (sapaan) sapaan.textContent = 'Invoice Tagihan';

  muatDetail();
})();
