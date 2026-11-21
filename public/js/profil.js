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

  function pasangProfilSkel() {
    ['pf-user', 'pf-sejak', 'pf-role', 'pf-paket', 'pf-exp', 'pf-exp-sub', 'pf-bot', 'pf-bot-sub'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('bt-skel');
    });
  }
  function lepasProfilSkel() {
    ['pf-user', 'pf-sejak', 'pf-role', 'pf-paket', 'pf-exp', 'pf-exp-sub', 'pf-bot', 'pf-bot-sub'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('bt-skel');
    });
  }

  async function muatProfil() {
    pasangProfilSkel();
    const [me, bots] = await Promise.all([api('/api/auth/me'), api('/api/bots')]);
    lepasProfilSkel();
    if (!me?.ok) return;
    const u = me.user;

    const tn = document.getElementById('top-name');
    if (tn) tn.textContent = 'Hai, ' + u.username + '!';
    const tr = document.getElementById('top-role');
    if (tr) tr.textContent = u.role_label || '—';

    document.getElementById('pf-user').textContent = u.username;
    document.getElementById('hp-nomor').value = u.phone || '';
    document.getElementById('em-alamat').value = u.email || '';
    document.getElementById('pf-sejak').textContent = 'Daftar ' + tanggal(u.created_at);
    document.getElementById('pf-role').textContent = u.role_label || '—';
    document.getElementById('pf-paket').textContent = u.plan_name + ' · limit ' + u.daily_limit + '/hari';

    const hari = sisaHari(u.plan_expired_at);
    document.getElementById('pf-exp').textContent = u.is_admin ? 'Tanpa masa aktif'
      : (u.plan_aktif ? (hari + ' hari') : 'Habis');
    document.getElementById('pf-exp-sub').textContent = u.is_admin ? 'Berlaku selama jadi admin'
      : u.plan_expired_at ? 'Berakhir ' + tanggal(u.plan_expired_at)
      : 'Belum pernah berlangganan';

    const jml = (bots?.bots || []).length;
    document.getElementById('pf-bot').textContent = jml;
    document.getElementById('pf-bot-sub').textContent =
      'Slot terpakai ' + u.slots_used + ' dari ' + u.slots_max;

    renderAvatar(u.avatar_url, u.username);
  }

  function renderAvatar(url, username) {
    const box = document.getElementById('pf-avatar-box');
    const btnHapus = document.getElementById('btn-hapus-avatar');
    if (!box) return;

    if (url) {
      box.innerHTML = '<img src="' + url + '" style="width:100%;height:100%;object-fit:cover;display:block;" alt="Avatar" />';
      if (btnHapus) btnHapus.style.display = 'inline-block';
    } else {
      box.innerHTML = '';
      const s = document.createElement('span');
      s.id = 'pf-avatar-initial';
      s.textContent = (username || '?')[0].toUpperCase();
      box.appendChild(s);
      if (btnHapus) btnHapus.style.display = 'none';
    }
  }

  const inpAvatar = document.getElementById('avatar-input');
  const btnPilih = document.getElementById('btn-pilih-avatar');
  const btnHapus = document.getElementById('btn-hapus-avatar');
  const avErr = document.getElementById('avatar-error');
  const avOk = document.getElementById('avatar-ok');

  if (btnPilih && inpAvatar) {
    btnPilih.addEventListener('click', () => inpAvatar.click());
    inpAvatar.addEventListener('change', async function () {
      pesan(avErr, ''); pesan(avOk, '');
      const file = this.files && this.files[0];
      if (!file) return;

      if (file.size > 500 * 1024) {
        pesan(avErr, 'Ukuran foto terlalu besar (' + Math.round(file.size / 1024) + ' KB). Maksimal 500 KB.');
        this.value = '';
        return;
      }

      btnPilih.disabled = true;
      btnPilih.textContent = 'Mengunggah…';

      const reader = new FileReader();
      reader.onload = async function (ev) {
        const d = await api('/api/user/avatar', {
          method: 'POST',
          body: JSON.stringify({ image: ev.target.result })
        });
        btnPilih.disabled = false;
        btnPilih.textContent = 'Pilih Foto';
        inpAvatar.value = '';

        if (!d?.ok) {
          pesan(avErr, d?.message || 'Gagal mengunggah foto.');
          return;
        }

        renderAvatar(d.avatar_url);
        pesan(avOk, d.message || 'Foto profil diperbarui!');
        showToast('Foto profil diperbarui', 'success');

        const topAv = document.getElementById('top-avatar-txt');
        if (topAv) topAv.innerHTML = '<img src="' + d.avatar_url + '" style="width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;" />';
      };
      reader.onerror = function () {
        btnPilih.disabled = false;
        btnPilih.textContent = 'Pilih Foto';
        pesan(avErr, 'Gagal membaca berkas gambar.');
      };
      reader.readAsDataURL(file);
    });
  }

  if (btnHapus) {
    btnHapus.addEventListener('click', async function () {
      pesan(avErr, ''); pesan(avOk, '');
      btnHapus.disabled = true;
      const d = await api('/api/user/avatar', { method: 'DELETE' });
      btnHapus.disabled = false;
      if (!d?.ok) {
        pesan(avErr, d?.message || 'Gagal menghapus foto.');
        return;
      }
      const uName = document.getElementById('pf-user')?.textContent || '?';
      renderAvatar(null, uName);
      pesan(avOk, d.message || 'Foto profil dihapus.');
      showToast('Foto profil dihapus', 'info');

      const topAv = document.getElementById('top-avatar-txt');
      if (topAv) topAv.textContent = uName[0].toUpperCase();
    });
  }

  // .err / .ok disembunyikan CSS (display:none). Tanpa toggling display, pesan
  // yang sudah diisi tetap tak terlihat — user cuma lihat tombol balik normal.
  function pesan(el, text) {
    if (!el) return;
    el.textContent = text || '';
    el.style.display = text ? 'block' : 'none';
  }

  function tampilError(msg) {
    pesan(document.getElementById('pw-error'), msg);
  }

  // Satu kolom saja: password baru. Skor 0-5, dipetakan ke 4 label.
  // ponytail: logika skor diduplikasi dari auth-page.js (10 baris) — jadikan
  // modul bersama kalau nanti ada halaman ketiga yang butuh.
  const pwBaru   = document.getElementById('pw-baru');
  const pwStr    = document.getElementById('pw-strength');
  const pwStrTxt = document.getElementById('pw-strength-txt');
  const pwOk     = document.getElementById('pw-ok');

  function cekKekuatan(p) {
    if (!p) return { level: '', label: 'Belum diisi' };
    let skor = 0;
    if (p.length >= 8) skor++;
    if (p.length >= 10) skor++;
    if (p.length >= 14) skor++;
    if (/[a-z]/.test(p) && /[A-Z]/.test(p)) skor++;
    if (/\d/.test(p)) skor++;
    if (/[^a-zA-Z0-9]/.test(p)) skor++;
    if (p.length < 8 || skor <= 2) return { level: 'weak',   label: 'Lemah' };
    if (skor <= 4)                  return { level: 'medium', label: 'Kuat' };
    return { level: 'strong', label: 'Sangat kuat' };
  }

  function updateStrength() {
    const { level, label } = cekKekuatan(pwBaru.value);
    pwStr.className = 'pass-strength' + (level ? ' ' + level : '');
    pwStrTxt.textContent = label;
  }

  pwBaru?.addEventListener('input', updateStrength);

  document.getElementById('pw-eye')?.addEventListener('click', (ev) => {
    const btn = ev.currentTarget;
    const buka = pwBaru.type === 'password';
    pwBaru.type = buka ? 'text' : 'password';
    btn.querySelector('.eye-off').style.display = buka ? 'none' : '';
    btn.querySelector('.eye-on').style.display  = buka ? '' : 'none';
  });

  async function simpanPassword(e) {
    e.preventDefault();
    tampilError(''); pesan(pwOk, '');
    const baru = pwBaru.value;

    // Dicek di sini biar nggak bolak-balik ke server buat salah ketik.
    // Server tetap memvalidasi ulang (klien nggak boleh jadi satu-satunya penjaga).
    if (baru.length < 6) return tampilError('Password baru minimal 6 karakter.');

    const tombol = document.getElementById('pw-btn');
    tombol.disabled = true;
    const d = await api('/api/auth/password', {
      method: 'POST', body: JSON.stringify({ baru }),
    });
    tombol.disabled = false;

    if (!d?.ok) return tampilError(d?.message || 'Gagal ganti password.');
    pesan(pwOk, d.message || 'Password diperbarui.');
    pwBaru.value = ''; pwBaru.type = 'password'; updateStrength();
  }

  async function simpanPhone(e) {
    e.preventDefault();
    const err = document.getElementById('hp-error');
    const ok = document.getElementById('hp-ok');
    const tombol = document.getElementById('hp-btn');
    pesan(err, ''); pesan(ok, '');

    const nomor = document.getElementById('hp-nomor').value.trim();
    if (!nomor) { pesan(err, 'Nomor HP wajib diisi.'); return; }
    tombol.disabled = true; tombol.textContent = 'Menyimpan…';
    const d = await api('/api/auth/phone', {
      method: 'POST', body: JSON.stringify({ phone: nomor }),
    });
    tombol.disabled = false; tombol.textContent = 'Simpan';
    if (!d?.ok) { pesan(err, d?.message || 'Gagal menyimpan nomor.'); return; }

    // Server yang menormalkan (08xx -> 628xx) — tampilkan balik hasilnya biar
    // user lihat bentuk yang benar-benar dipakai buat kirim notif.
    if (d.phone) document.getElementById('hp-nomor').value = d.phone;
    pesan(ok, d.message || 'Nomor disimpan.');
    showToast(d.message || 'Nomor HP disimpan', 'success');
  }

  /** Email — jalur kabar yang TIDAK lewat bot (lihat engine/email.js). */
  async function simpanEmail(e) {
    e.preventDefault();
    const err = document.getElementById('em-error');
    const ok = document.getElementById('em-ok');
    pesan(err, ''); pesan(ok, '');

    const alamat = document.getElementById('em-alamat').value.trim();
    const d = await api('/api/auth/email', {
      method: 'POST', body: JSON.stringify({ email: alamat }),
    });
    if (!d?.ok) { pesan(err, d?.message || 'Gagal menyimpan email.'); return; }

    if (d.email) document.getElementById('em-alamat').value = d.email;
    pesan(ok, d.message || 'Email disimpan.');
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
