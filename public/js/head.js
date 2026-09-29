(function(){try{if((localStorage.getItem('yb-theme')||'light')==='dark')document.documentElement.classList.add('dark');}catch(e){}})
function toggleTheme(){var d=document.documentElement.classList.toggle('dark');try{localStorage.setItem('yb-theme',d?'dark':'light');}catch(e){}}

// Sidebar (partials/topbar + sidebar) — dipakai dua halaman, jadi taruh di sini
// biar nggak dobel di dashboard.js dan bot-detail.js.
// Kelas pembuka = `open` (lihat page.css `aside.open{transform:none}` di
// media query mobile). Jangan pakai kelas Tailwind — Tailwind nggak dimuat.
window.toggleSidebar = function () {
  document.getElementById('sidebar')?.classList.toggle('open');
  document.getElementById('sidebar-overlay')?.classList.toggle('hidden');
};
window.closeSidebar = function () {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.add('hidden');
};

// Menu aktif ikut halaman yang sedang dibuka. Dulu `active` ditulis mati di
// sidebar.html (selalu "Dashboard"), jadi di /pricing & /admin salah nyala.
document.addEventListener('DOMContentLoaded', function () {
  var kini = (location.pathname.replace(/\/+$/, '') || '/');
  // cocokkan nama halamannya saja, biar jalan juga waktu diakses sebagai
  // /pricing.html (preview) maupun /pricing (rute server.js)
  var nama = kini === '/' ? 'index' : kini.split('/').pop().replace(/\.html$/, '');
  if (/^\/bot\//.test(kini)) nama = 'dashboard';   // halaman detail bot = anak Dashboard
  document.querySelectorAll('#sidebar .nav a[href]').forEach(function (a) {
    var h = (a.getAttribute('href') || '/').replace(/\/+$/, '') || '/';
    var hn = h === '/' ? 'index' : h.split('/').pop().replace(/\.html$/, '');
    a.classList.toggle('active', h === kini || hn === nama);
  });
});
