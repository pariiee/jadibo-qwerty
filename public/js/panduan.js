// Halaman Panduan (/panduan). Isinya statis — nol endpoint, nol tabel, nol JS
// buat buka-tutup (pakai <details> bawaan browser, yang sudah bisa diakses
// keyboard & screen reader tanpa satu baris kode pun). File ini cuma benerin
// topbar yang default-nya menulis "Dashboard".
(function () {
  const sapaan = document.getElementById('greeting');
  if (sapaan) sapaan.textContent = 'Panduan';
  // Tombol "Tambah Bot" di topbar nggak nyambung ke halaman ini; arahkan ke
  // Dashboard, sama seperti billing.js/profil.js/command.js.
  window.openAddBot = () => { location.href = '/dashboard'; };
})();
