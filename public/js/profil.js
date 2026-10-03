// Halaman Profil Saya (/profil). Semua angka dari /api/auth/me + /api/bots —
// dua endpoint yang sudah dipakai halaman lain, jadi nol request baru.
(function () {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  async function api(path, opts = {}) {
    try {
      const res = await fetch(path, {
        ...opts, credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      });
      if (res.status === 401) { location.href = '/'; return null; }
      return res.json();
    } catch { return null; }
  }

  const tanggal = (v) => {
    if (!v) return '—';
    const s = /Z|[+-]\d\d:?$/.test(String(v)) ? v : String(v).replace(' ', 'T') + 'Z';
    const d = new Date(s);
    return isNaN(d) ? String(v) : d.toLocaleDateString('id-ID',
      { day: '2-digit', month: 'long', year: 'numeric' });
  };

  const sisaHari = (v) => {
    if (!v) return null;
    const d = new Date(/Z|[+-]\d\d:?$/.test(String(v)) ? v : String(v).replace(' ', 'T') + 'Z');
    if (isNaN(d)) return null;
    return Math.ceil((d - Date.now()) / 86400000);
  };

  async function muatProfil() {
    const [me, bots] = await Promise.all([api('/api/auth/me'), api('/api/bots')]);
    if (!me?.ok) return;
    const u = me.user;

    document.getElementById('pf-user').textContent = u.username;
    document.getElementById('hp-nomor').value = u.phone || '';
    document.getElementById('em-alamat').value = u.email || '';
    document.getElementById('pf-sejak').textContent = 'Daftar ' + tanggal(u.created_at);
    document.getElementById('pf-role').textContent = u.role_label || '—';
    document.getElementById('pf-paket').textContent = u.plan_name + ' · limit ' + u.daily_limit + '/hari';

    const hari = sisaHari(u.plan_expired_at);
    document.getElementById('pf-exp').textContent = u.plan_aktif ? (hari + ' hari') : 'Habis';
    document.getElementById('pf-exp-sub').textContent = u.plan_expired_at
      ? 'Berakhir ' + tanggal(u.plan_expired_at)
      : 'Belum pernah berlangganan';

    const jml = (bots?.bots || []).length;
    document.getElementById('pf-bot').textContent = jml;
    document.getElementById('pf-bot-sub').textContent =
      'Slot terpakai ' + u.slots_used + ' dari ' + u.slots_max;
  }

  function tampilError(msg) {
    const el = document.getElementById('pw-error');
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
  }

  async function simpanPassword(e) {
    e.preventDefault();
    tampilError('');
    const lama = document.getElementById('pw-lama').value;
    const baru = document.getElementById('pw-baru').value;
    const ulang = document.getElementById('pw-ulang').value;

    // Dicek di sini juga biar nggak bolak-balik ke server buat salah ketik.
    // Server tetap memvalidasi ulang (klien nggak boleh jadi satu-satunya penjaga).
    if (baru.length < 6) return tampilError('Password baru minimal 6 karakter.');
    if (baru !== ulang) return tampilError('Ulangi password baru belum sama.');

    const tombol = e.target.querySelector('button[type="submit"]');
    tombol.disabled = true;
    const d = await api('/api/auth/password', {
      method: 'POST', body: JSON.stringify({ lama, baru }),
    });
    tombol.disabled = false;

    if (!d?.ok) return tampilError(d?.message || 'Gagal ganti password.');
    e.target.reset();
    showToast(d.message || 'Password diganti', 'success');
  }

  async function simpanPhone(e) {
    e.preventDefault();
    const err = document.getElementById('hp-error');
    const ok = document.getElementById('hp-ok');
    err.textContent = ''; ok.textContent = '';

    const nomor = document.getElementById('hp-nomor').value.trim();
    const d = await api('/api/auth/phone', {
      method: 'POST', body: JSON.stringify({ phone: nomor }),
    });
    if (!d?.ok) { err.textContent = d?.message || 'Gagal menyimpan nomor.'; return; }

    // Server yang menormalkan (08xx -> 628xx) — tampilkan balik hasilnya biar
    // user lihat bentuk yang benar-benar dipakai buat kirim notif.
    if (d.phone) document.getElementById('hp-nomor').value = d.phone;
    ok.textContent = d.message || 'Nomor disimpan.';
    showToast(d.message || 'Nomor HP disimpan', 'success');
  }

  /** Email — jalur kabar yang TIDAK lewat bot (lihat engine/email.js). */
  async function simpanEmail(e) {
    e.preventDefault();
    const err = document.getElementById('em-error');
    const ok = document.getElementById('em-ok');
    err.textContent = ''; ok.textContent = '';

    const alamat = document.getElementById('em-alamat').value.trim();
    const d = await api('/api/auth/email', {
      method: 'POST', body: JSON.stringify({ email: alamat }),
    });
    if (!d?.ok) { err.textContent = d?.message || 'Gagal menyimpan email.'; return; }

    if (d.email) document.getElementById('em-alamat').value = d.email;
    ok.textContent = d.message || 'Email disimpan.';
    showToast(d.message || 'Email disimpan', 'success');
  }

  const sapaan = document.getElementById('greeting');
  if (sapaan) sapaan.textContent = 'Profil Saya';
  window.openAddBot = () => { location.href = '/dashboard'; };

  document.getElementById('pw-form').addEventListener('submit', simpanPassword);
  document.getElementById('hp-form').addEventListener('submit', simpanPhone);
  document.getElementById('em-form').addEventListener('submit', simpanEmail);
  muatProfil();
})();
