(function(){try{if((localStorage.getItem('yb-theme')||'light')==='dark')document.documentElement.classList.add('dark');}catch(e){}})
function toggleTheme(){var d=document.documentElement.classList.toggle('dark');try{localStorage.setItem('yb-theme',d?'dark':'light');}catch(e){}}

// Sidebar (partials/topbar + sidebar) — dipakai dua halaman, jadi taruh di sini
// biar nggak dobel di dashboard.js dan bot-detail.js.
window.toggleSidebar = function () {
  document.getElementById('sidebar')?.classList.toggle('-translate-x-full');
  document.getElementById('sidebar-overlay')?.classList.toggle('hidden');
};
window.closeSidebar = function () {
  document.getElementById('sidebar')?.classList.add('-translate-x-full');
  document.getElementById('sidebar-overlay')?.classList.add('hidden');
};
