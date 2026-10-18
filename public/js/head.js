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

// ── Ikon platform (§7) ───────────────────────────────────────────────
// Satu definisi untuk halaman mana pun lewat `window.waIcon(s)` /
// `window.tgIcon(s)`. Sebelumnya SVG-nya ditulis ulang di bot-stats.js,
// bot-detail.js, config.js, dan dashboard.js — dan salinannya sudah berbeda:
// dashboard.html punya versi bergaris putih (`.plat-btn`, ikon besar),
// sisanya versi satu-lapis. Perbedaan itu yang bikin ikon WhatsApp di satu
// halaman kelihatan beda dari halaman lain.
//
// Ikon di `.plat-btn` dashboard.html DIBIARKAN inline: ukurannya 34px, dan
// versi bergaris putih memang lebih enak dilihat di ukuran itu.
(function () {
  var WA_PATH =
    '<path d="M12.012 2c-5.506 0-9.989 4.478-9.99 9.984 0 1.76.459 3.478 1.333 4.992L2 22l5.133-1.345c1.458.796 3.1 1.214 4.872 1.215h.004c5.505 0 9.988-4.479 9.989-9.985 0-2.667-1.037-5.176-2.922-7.062A9.927 9.927 0 0 0 12.012 2zm5.834 14.164c-.247.692-1.244 1.344-1.737 1.411-.492.066-1.127.112-3.626-.925-2.986-1.238-4.9-4.275-5.049-4.474-.148-.198-1.213-1.616-1.213-3.08 0-1.464.767-2.186 1.039-2.484.272-.298.594-.372.793-.372.198 0 .396.002.57.01.184.008.434-.07.679.52.247.594.841 2.054.915 2.203.074.149.124.322.025.52-.099.198-.149.322-.297.495-.148.174-.312.389-.446.523-.148.148-.303.309-.13.606.173.297.77 1.272 1.651 2.058 1.134 1.011 2.091 1.325 2.388 1.474.297.148.471.124.645-.074.173-.198.742-.866.94-1.163.198-.297.396-.247.669-.148.272.099 1.73.816 2.027.965.297.148.495.223.569.347.074.124.074.717-.173 1.409z" fill="currentColor"/>';
  window.waIcon = function (s) {
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' + WA_PATH + '</svg>';
  };
  // Telegram: lingkaran penuh, jadi logo aslinya pakai warna latar. Dipakai
  // satu lapis supaya seragam dengan waIcon di ukuran kecil (13–18px).
  var TG_PATH = '<path fill="#229ED9" d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.161l-1.97 9.288c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.022c.24-.213-.054-.333-.373-.12L7.94 13.428l-2.943-.92c-.64-.203-.652-.64.133-.948l11.5-4.432c.534-.194 1-.12.932.633z"/>';
  window.tgIcon = function (s) {
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" aria-hidden="true">' + TG_PATH + '</svg>';
  };
  /** Ikon sesuai platform bot. */
  window.platIcon = function (platform, s) {
    return platform === 'telegram' ? window.tgIcon(s) : window.waIcon(s);
  };
})();

// ── Alamat bot untuk URL halaman ─────────────────────────────────────
// Link memakai `slug` (acak, dari `bots.public_id`) supaya `/bot/4` tidak
// gampang ditebak bot auto-scanner. `id` tetap jadi cadangan untuk bot lama
// yang belum sempat punya slug — server menerima dua-duanya.
window.botHref = function (bot) {
  if (!bot) return '';
  return bot.slug || bot.public_id || bot.id || (bot.bot && (bot.bot.slug || bot.bot.id)) || '';
};

/**
 * Ambil id/slug bot dari pathname halaman.
 *
 * WAJIB dipakai semua halaman /bot/:id & /config/:id — JANGAN tulis regex
 * sendiri. Versi lama masing-masing file cuma cocok angka (`\/(\d+)\/?$`),
 * jadi begitu URL-nya jadi slug, hasilnya `undefined` dan halaman langsung
 * mental ke /dashboard tanpa pesan apa pun.
 *
 * `(?:bot|config)` sengaja disebut eksplisit: tanpa itu, `/dashboard` ikut
 * cocok sebagai "slug" dan halaman mengirim permintaan ke bot bernama
 * "dashboard".
 */
window.botIdDariPath = function (pathname) {
  const m = String(pathname || '').match(/^\/(?:bot|config)\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
};

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
  document.querySelectorAll('#sidebar nav a[href], aside nav a[href]').forEach(function (a) {
    var h = (a.getAttribute('href') || '/').replace(/\/+$/, '') || '/';
    var hn = h === '/' ? 'index' : h.split('/').pop().replace(/\.html$/, '');
    var match = (h === kini || hn === nama);
    a.classList.toggle('active', match);
    a.classList.toggle('on', match);
  });

  // Isi avatar topbar jika ada & popover user data
  var topAv = document.getElementById('top-avatar-txt');
  var pName = document.getElementById('pop-name');
  var pEmail = document.getElementById('pop-email');
  var pRole = document.getElementById('pop-role');
  fetch('/api/auth/me').then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.ok && d.user) {
      var u = d.user;
      if (topAv && u.username) topAv.textContent = u.username[0].toUpperCase();
      if (pName) pName.textContent = u.username || 'User';
      if (pEmail) pEmail.textContent = u.email || (u.username + '@gmail.com');
      if (pRole) pRole.textContent = u.is_admin ? 'Admin' : (u.slots ? u.slots + ' Slot' : 'User');
      if (u.is_admin) {
        var elNav = document.getElementById('nav-admin');
        if (elNav) elNav.style.display = '';
      }
    }
  }).catch(function () {});

  // Dropdown Accordion Manage di Sidebar
  var navAdminGroup = document.getElementById('nav-admin');
  var btnNavManage = document.getElementById('btn-nav-manage');
  if (btnNavManage && navAdminGroup) {
    btnNavManage.addEventListener('click', function (e) {
      e.preventDefault();
      var buka = navAdminGroup.classList.toggle('open');
      btnNavManage.setAttribute('aria-expanded', buka ? 'true' : 'false');
    });
    if (location.pathname.indexOf('/kountole') === 0) {
      navAdminGroup.classList.add('open');
      btnNavManage.setAttribute('aria-expanded', 'true');
      var seg = location.pathname.split('/').filter(Boolean)[1] || 'users';
      var activeSub = document.getElementById('sub-manage-' + seg);
      if (activeSub) activeSub.classList.add('active');
    }
  }

  function toggleUserMenu() {
    var pop = document.getElementById('user-popover');
    var btn = document.getElementById('top-avatar-btn');
    if (!pop) return;
    var buka = pop.style.display !== 'none';
    pop.style.display = buka ? 'none' : 'flex';
    if (btn) btn.setAttribute('aria-expanded', buka ? 'false' : 'true');
  }
  window.toggleUserMenu = toggleUserMenu;

  document.addEventListener('click', function (e) {
    var pop = document.getElementById('user-popover');
    var btn = document.getElementById('top-avatar-btn');
    if (pop && pop.style.display !== 'none' && !pop.contains(e.target) && (!btn || !btn.contains(e.target))) {
      pop.style.display = 'none';
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }
  });

  // ── Custom Select Dropdown (§Obsidian Glassmorphic) ─────────────────
  function enhanceCustomSelect(sel) {
    if (!sel || sel.dataset.csInit === '1') return;
    sel.dataset.csInit = '1';
    sel.style.display = 'none';

    var wrap = document.createElement('div');
    wrap.className = 'custom-select-wrap';
    if (sel.id) wrap.dataset.for = sel.id;
    if (sel.style.maxWidth) wrap.style.maxWidth = sel.style.maxWidth;

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'cs-trigger';
    if (sel.className) {
      sel.className.split(' ').filter(Boolean).forEach(function (c) {
        if (c !== 'inp') trigger.classList.add(c);
      });
    }
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    var label = document.createElement('span');
    label.className = 'cs-label';

    var arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.setAttribute('class', 'cs-arrow');
    arrow.setAttribute('viewBox', '0 0 24 24');
    arrow.setAttribute('fill', 'none');
    arrow.setAttribute('stroke', 'currentColor');
    arrow.setAttribute('stroke-width', '2');
    arrow.setAttribute('stroke-linecap', 'round');
    arrow.setAttribute('stroke-linejoin', 'round');
    var poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('points', '6 9 12 15 18 9');
    arrow.appendChild(poly);

    trigger.appendChild(label);
    trigger.appendChild(arrow);

    var menu = document.createElement('div');
    menu.className = 'cs-menu';
    menu.setAttribute('role', 'listbox');

    wrap.appendChild(trigger);
    wrap.appendChild(menu);
    sel.parentNode.insertBefore(wrap, sel.nextSibling);

    function syncOptions() {
      menu.innerHTML = '';
      var opts = sel.options;
      var curIdx = sel.selectedIndex >= 0 ? sel.selectedIndex : 0;
      label.textContent = opts[curIdx] ? opts[curIdx].textContent : (sel.getAttribute('placeholder') || 'Pilih...');

      for (var i = 0; i < opts.length; i++) {
        (function (idx) {
          var o = opts[idx];
          if (o.hidden) return;
          var item = document.createElement('div');
          item.className = 'cs-option' + (idx === curIdx ? ' on' : '');
          item.textContent = o.textContent;
          item.dataset.val = o.value;
          item.addEventListener('click', function (e) {
            e.stopPropagation();
            if (sel.selectedIndex === idx && sel.options[0] && sel.options[0].hidden) {
              sel.selectedIndex = 0;
              sel.value = sel.options[0].value;
              label.textContent = sel.options[0].textContent;
              menu.querySelectorAll('.cs-option').forEach(function (el) { el.classList.remove('on'); });
            } else {
              sel.selectedIndex = idx;
              sel.value = o.value;
              label.textContent = o.textContent;
              menu.querySelectorAll('.cs-option').forEach(function (el) {
                el.classList.toggle('on', el.dataset.val === o.value);
              });
            }
            close();
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            if (typeof sel.onchange === 'function') sel.onchange();
            if (sel.dataset && sel.dataset.act) {
              var act = sel.dataset.act.trim();
              var m = /^([A-Za-z_$][\w$]*)(?:\((.*)\))?$/.exec(act);
              if (m && typeof window[m[1]] === 'function') {
                window[m[1]](m[2] === undefined ? undefined : m[2], sel);
              }
            }
          });
          menu.appendChild(item);
        })(i);
      }
    }

    function open() {
      document.querySelectorAll('.cs-menu.open').forEach(function (m) {
        if (m !== menu) {
          m.classList.remove('open');
          var tr = m.previousElementSibling;
          if (tr) { tr.classList.remove('open'); tr.setAttribute('aria-expanded', 'false'); }
        }
      });
      menu.classList.add('open');
      trigger.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
    }

    function close() {
      menu.classList.remove('open');
      trigger.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
    }

    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.classList.contains('open') ? close() : open();
    });

    sel.addEventListener('change', function () {
      var curIdx = sel.selectedIndex >= 0 ? sel.selectedIndex : 0;
      if (sel.options[curIdx]) label.textContent = sel.options[curIdx].textContent;
      menu.querySelectorAll('.cs-option').forEach(function (el, j) {
        el.classList.toggle('on', j === curIdx);
      });
    });

    var mo = new MutationObserver(syncOptions);
    mo.observe(sel, { childList: true, subtree: true });

    syncOptions();
  }

  function initCustomSelects() {
    document.querySelectorAll('select.inp, select').forEach(enhanceCustomSelect);
  }
  window.initCustomSelects = initCustomSelects;
  initCustomSelects();

  document.addEventListener('click', function (e) {
    if (!e.target.closest('.custom-select-wrap')) {
      document.querySelectorAll('.cs-menu.open').forEach(function (m) {
        m.classList.remove('open');
        var tr = m.previousElementSibling;
        if (tr) { tr.classList.remove('open'); tr.setAttribute('aria-expanded', 'false'); }
      });
    }
  });
});
