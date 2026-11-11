// Halaman Pricing — daftar paket, klaim trial, dan 2 opsi bayar.
// Aturan main: semua keputusan (harga, slot, masa aktif) datang dari server.
// Halaman ini cuma menampilkan dan mengirim pilihan.
(function () {
  let me = null;
  let paket = [];
  let bayar = null;     // { plan, order }
  let timerCek = null;

  async function api(path, opts = {}) {
    try {
      const res = await fetch(path, {
        ...opts,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
      });
      if (res.status === 401) { location.href = '/'; return null; }
      return res.json();
    } catch { return null; }
  }

  const rupiah = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');
  const tanggal = (s) => s ? new Date(s).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) : '';

  async function whoami() {
    const d = await api('/api/auth/me');
    if (!d?.ok) { location.href = '/'; return null; }
    me = d.user;
    const topAv = document.getElementById('top-avatar-txt');
    if (topAv) topAv.textContent = (me.username || '?')[0].toUpperCase();
    const sapaan = document.getElementById('greeting');
    if (sapaan) sapaan.textContent = 'Pricing & Paket';
    if (me.is_admin) document.getElementById('nav-admin').style.display = '';
    renderStatus();
    return me;
  }

  function renderStatus() {
    const elBadge = document.getElementById('plan-badge');
    if (elBadge) elBadge.textContent = me.plan_name ? me.plan_name : (me.slots ? me.slots + ' Slot' : 'Belum Ada Slot');
    const elUntil = document.getElementById('plan-until');
    if (elUntil) elUntil.textContent = me.plan_aktif ? 'aktif sampai ' + tanggal(me.plan_expired_at) : 'tanpa masa aktif';

    const btn = document.getElementById('btn-trial');
    const note = document.getElementById('trial-note');
    if (btn) btn.style.display = 'none';
    if (note) note.style.display = 'none';
  }

  async function loadPaket() {
    const grid = document.getElementById('plan-grid');
    if (grid && !grid.children.length) {
      grid.innerHTML = [1, 2, 3].map(() => `
        <div class="plan-card" style="pointer-events:none">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div class="bt-skel" style="width:100px;height:22px;border-radius:6px"></div>
            <div class="bt-skel" style="width:60px;height:18px;border-radius:999px"></div>
          </div>
          <div class="bt-skel" style="width:140px;height:38px;border-radius:8px;margin:12px 0"></div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <div class="bt-skel" style="width:100%;height:16px;border-radius:4px"></div>
            <div class="bt-skel" style="width:85%;height:16px;border-radius:4px"></div>
            <div class="bt-skel" style="width:70%;height:16px;border-radius:4px"></div>
          </div>
          <div class="bt-skel" style="width:100%;height:44px;border-radius:999px;margin-top:16px"></div>
        </div>
      `).join('');
    }
    const d = await api('/api/plans');
    if (!d?.ok) return;
    paket = d.plans || [];
    const jumlahFitur = d.fitur || 0;
    grid.innerHTML = '';

    // Card 1: Free Trial
    const trialData = d.trial || { days: 5, slots: 1, owner_max: 1, receive_limit: 5000 };
    const kTrial = daftarPaket({
      name: 'Free Trial',
      slots: trialData.slots || 1,
      receive_limit: trialData.receive_limit || 5000,
      owner_max: trialData.owner_max || 1,
      days: trialData.days || 5,
    }, jumlahFitur);

    const isCurrentTrial = me.plan_id === 'trial' && me.plan_aktif;
    const elTrial = document.createElement('div');
    elTrial.className = 'plan-card' + (isCurrentTrial ? ' aktif' : '');
    
    let trialBtnHtml = '';
    if (!me.trial_used_at) {
      trialBtnHtml = '<button class="btn btn-dark" data-act="klaimTrial">Klaim Trial Gratis</button>';
    } else if (isCurrentTrial) {
      trialBtnHtml = '<button class="btn btn-outline" disabled style="opacity:0.85;cursor:default">Trial Sedang Aktif</button>';
    } else {
      trialBtnHtml = '<button class="btn btn-outline" disabled style="opacity:0.5;cursor:not-allowed">Sudah Pernah Klaim</button>';
    }

    elTrial.innerHTML =
      '<div class="pc-head"><span class="pc-name">Free Trial</span>' +
      (isCurrentTrial ? '<span class="pc-tag">Paket kamu</span>' : '<span class="pc-tag" style="background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3)">Gratis</span>') + '</div>' +
      '<div class="pc-price">Rp 0<small> / ' + (trialData.days || 5) + ' hari</small></div>' +
      '<ul class="pc-list">' + kTrial.baris.map((t) => '<li>' + t + '</li>').join('') + '</ul>' +
      '<div class="muted small">' + kTrial.extra + '</div>' +
      trialBtnHtml;
    grid.appendChild(elTrial);

    // Cards 2..N: Paid Plans
    paket.forEach((p) => {
      // Isi kartu dari `daftarPaket()` (act.js) — SATU sumber dengan landing `/`.
      // Dulu dua halaman menulis daftarnya sendiri dan isinya jadi beda.
      const k = daftarPaket(p, jumlahFitur);
      const el = document.createElement('div');
      el.className = 'plan-card' + (p.id === me.plan_id ? ' aktif' : '');
      el.innerHTML =
        '<div class="pc-head"><span class="pc-name">' + p.name + '</span>' +
        (p.id === me.plan_id ? '<span class="pc-tag">Paket kamu</span>' : '') + '</div>' +
        '<div class="pc-price">' + rupiah(p.price) + '<small> / ' + p.days + ' hari</small></div>' +
        '<ul class="pc-list">' + k.baris.map((t) => '<li>' + t + '</li>').join('') + '</ul>' +
        '<div class="muted small">' + k.extra + '</div>' +
        '<button class="btn btn-dark" data-act="bukaBayar(\'' + p.id + '\')">Pilih Paket</button>';
      grid.appendChild(el);
    });
  }

  // ── Klaim trial ────────────────────────────────────────────────
  async function klaimTrial() {
    const d = await api('/api/billing/trial', { method: 'POST' });
    if (!d?.ok) return showToast(d?.message || 'Tidak bisa klaim trial', 'error');
    showToast('Trial ' + d.hari + ' hari aktif!', 'success');
    await whoami();
    await loadPaket();
  }

  // ── Alur bayar ─────────────────────────────────────────────────
  function bukaBayar(planId) {
    const p = paket.find((x) => x.id === planId);
    if (!p) return;
    bayar = { plan: p, order: null };
    document.getElementById('bayar-judul').textContent = 'Paket ' + p.name;
    document.getElementById('bayar-harga').textContent =
      rupiah(p.price) + ' untuk ' + p.days + ' hari · ' + p.slots + ' slot';
    document.getElementById('step-metode').style.display = '';
    document.getElementById('step-bayar').style.display = 'none';
    document.getElementById('bayar-overlay').classList.add('show');
  }

  function closeBayar() {
    document.getElementById('bayar-overlay').classList.remove('show');
    clearInterval(timerCek);
    timerCek = null;
  }

  async function pilihMetode(method) {
    if (!bayar) return;
    const d = await api('/api/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ plan: bayar.plan.id, method })
    });
    if (!d?.ok) return showToast(d?.message || 'Gagal membuat tagihan', 'error');

    bayar.order = d.order_id;
    document.getElementById('step-metode').style.display = 'none';
    document.getElementById('step-bayar').style.display = '';
    document.getElementById('bayar-judul2').textContent =
      method === 'manual' ? 'Bayar via QRIS Manual' : 'Bayar via QRIS Otomatis';
    document.getElementById('bayar-kode').textContent = 'Kode tagihan: ' + d.order_id;
    document.getElementById('bayar-info').textContent = (d.instruksi || []).join(' ');

    const qr = document.getElementById('bayar-qr');
    qr.src = d.qris_image || '';
    qr.style.display = d.qris_image ? '' : 'none';

    const tautan = document.getElementById('bayar-tautan');
    if (d.pay_url) { tautan.href = d.pay_url; tautan.style.display = ''; }
    else tautan.style.display = 'none';

    // Cek berkala cuma untuk jalur otomatis, dan jarang: tiap 20 detik,
    // maksimal 15 kali. Server tetap punya cooldown sendiri, jadi tidak ada
    // kemungkinan menghajar API QRISku.
    if (method === 'gateway') mulaiCekBerkala();
  }

  function mulaiCekBerkala() {
    clearInterval(timerCek);
    let sisa = 15;
    timerCek = setInterval(() => {
      if (--sisa <= 0) { clearInterval(timerCek); return; }
      cekStatus(true);
    }, 20000);
  }

  async function cekStatus(senyap) {
    if (!bayar?.order) return;
    const d = await api('/api/billing/orders/' + bayar.order + '/check', { method: 'POST' });
    if (!d?.ok) return senyap ? null : showToast(d?.message || 'Gagal cek status', 'error');

    if (d.status === 'paid') {
      clearInterval(timerCek);
      showToast('Pembayaran diterima! Paket aktif.', 'success');
      closeBayar();
      await whoami();
      await loadPaket();
      return;
    }
    if (!senyap) showToast(d.message || 'Belum ada pembayaran masuk.', 'info');
  }

  (async () => {
    try { await whoami(); } catch (e) { console.warn('whoami:', e); }
    try { await loadPaket(); } catch (e) { console.error('loadPaket:', e); }
  })();

  window.klaimTrial = klaimTrial;
  window.bukaBayar = bukaBayar;
  window.closeBayar = closeBayar;
  window.pilihMetode = pilihMetode;
  window.cekStatus = () => cekStatus(false);
})();
