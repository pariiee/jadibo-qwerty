// ── Tema (§10) ───────────────────────────────────────────────────────
// Spec: mengikuti `prefers-color-scheme`, tombol tema menimpa lewat
// `data-theme="light|dark"` di <html>. Kelas `dark` IKUT di-set karena
// page.css/theme.css/motion.css masih punya 24 selector `html.dark ...`;
// kalau cuma atributnya yang di-set, aturan-aturan itu berhenti jalan.
(function () {
  try {
    var simpan = localStorage.getItem('yb-theme');
    if (simpan === 'dark' || simpan === 'light') {
      document.documentElement.dataset.theme = simpan;
      if (simpan === 'dark') document.documentElement.classList.add('dark');
    }
  } catch (e) { /* localStorage bisa dimatikan browser — ikut sistem saja */ }
})();
function toggleTheme() {
  var r = document.documentElement;
  var gelap = r.dataset.theme
    ? r.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  var baru = gelap ? 'light' : 'dark';
  r.dataset.theme = baru;
  r.classList.toggle('dark', baru === 'dark');
  try { localStorage.setItem('yb-theme', baru); } catch (e) { /* abaikan */ }
}

// ── Sidebar aplikasi (§8.1) ──────────────────────────────────────────
// >760px : penuh ↔ mini (230px ↔ 76px) saat burger diklik
// ≤760px : mulai MINI; burger membuka overlay (lihat palette.css §7)
// Kelas penanda = `mini` di `.app`. Ini menggantikan mekanisme lama
// (`aside.open` + `#sidebar-overlay`) yang cuma bisa buka/tutup, bukan
// mengecilkan — spec minta dua keadaan berbeda per breakpoint.
function appShell() { return document.querySelector('.shell, .app'); }

// `aria-expanded` diurus DI SINI saja, satu tempat, mengikuti keadaan nyata.
function setSidebarMini(mini) {
  var s = appShell();
  if (s) s.classList.toggle('mini', mini);
  var b = document.querySelector('[data-act="toggleSidebar"]');
  if (b) b.setAttribute('aria-expanded', String(!mini));
}
window.toggleSidebar = function () {
  var s = appShell();
  if (s) setSidebarMini(!s.classList.contains('mini'));
};
window.closeSidebar = function () { setSidebarMini(true); };

// ── Drawer navbar landing (§8.2) ─────────────────────────────────────
function siapkanDrawer() {
  var menu = document.getElementById('nav-burger');
  var drawer = document.getElementById('drawer');
  if (!menu || !drawer) return;
  function setMenu(buka) {
    drawer.classList.toggle('open', buka);
    menu.setAttribute('aria-expanded', String(buka));
    menu.setAttribute('aria-label', buka ? 'Tutup menu' : 'Buka menu');
  }
  menu.addEventListener('click', function (e) {
    e.stopPropagation();
    setMenu(!drawer.classList.contains('open'));
  });
  drawer.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', function () { setMenu(false); });
  });
  document.addEventListener('click', function (e) {
    if (!drawer.contains(e.target) && !menu.contains(e.target)) setMenu(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') setMenu(false);
  });
  matchMedia('(min-width:981px)').addEventListener('change', function (e) {
    if (e.matches) setMenu(false);
  });
}

// ── Menu aktif ikut halaman yang sedang dibuka ───────────────────────
// Dulu `active` ditulis mati di sidebar.html (selalu "Dashboard"), jadi di
// /pricing & /admin salah nyala.
document.addEventListener('DOMContentLoaded', function () {
  siapkanDrawer();

  // §8.1: keadaan awal sidebar. Di HP mulai mini; di desktop mulai penuh.
  // Breakpoint diubah (HP diputar / jendela diubah) → keadaan di-reset.
  var s = appShell();
  if (s) {
    var mq = matchMedia('(max-width:760px)');
    var setMini = setSidebarMini;   // satu jalur, jadi `aria-expanded` ikut benar
    setMini(mq.matches);
    mq.addEventListener('change', function (e) { setMini(e.matches); });
    // Klik area konten menutup overlay (mobile).
    var utama = document.querySelector('main');
    if (utama) utama.addEventListener('click', function (e) {
      if (mq.matches && !s.classList.contains('mini') &&
          !(e.target.closest && e.target.closest('[data-act="toggleSidebar"]'))) setMini(true);
    });
    // §8.1: overlay juga ditutup dengan Esc.
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && mq.matches) setMini(true);
    });
  }

  var kini = (location.pathname.replace(/\/+$/, '') || '/');
  // cocokkan nama halamannya saja, biar jalan juga saat diakses sebagai
  // /pricing.html (preview) maupun /pricing (rute server.js)
  var nama = kini === '/' ? 'index' : kini.split('/').pop().replace(/\.html$/, '');
  if (/^\/bot\//.test(kini)) nama = 'dashboard';   // halaman detail bot = anak Dashboard
  document.querySelectorAll('#sidebar .nav a[href]').forEach(function (a) {
    var h = (a.getAttribute('href') || '/').replace(/\/+$/, '') || '/';
    var hn = h === '/' ? 'index' : h.split('/').pop().replace(/\.html$/, '');
    a.classList.toggle('active', h === kini || hn === nama);
  });
});
