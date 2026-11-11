if (window.__HEAD_JS_LOADED__) {
} else {
  window.__HEAD_JS_LOADED__ = true;
}
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

function appShell() { return document.querySelector('.shell, .app'); }

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

(function () {
  var WA_PATH =
    '<path fill="#25D366" d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>';
  window.waIcon = function (s) {
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" aria-hidden="true">' + WA_PATH + '</svg>';
  };
  var TG_PATH = '<path fill="#229ED9" d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.161l-1.97 9.288c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.022c.24-.213-.054-.333-.373-.12L7.94 13.428l-2.943-.92c-.64-.203-.652-.64.133-.948l11.5-4.432c.534-.194 1-.12.932.633z"/>';
  var DC_PATH = '<path fill="#5865F2" d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.894.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>';
  window.tgIcon = function (s) {
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" aria-hidden="true">' + TG_PATH + '</svg>';
  };
  window.dcIcon = function (s) {
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" aria-hidden="true">' + DC_PATH + '</svg>';
  };
  window.platIcon = function (platform, s) {
    if (platform === 'telegram') return window.tgIcon(s);
    if (platform === 'discord') return window.dcIcon(s);
    return window.waIcon(s);
  };
})();

window.botHref = function (bot) {
  if (!bot) return '';
  return bot.slug || bot.public_id || bot.id || (bot.bot && (bot.bot.slug || bot.bot.id)) || '';
};

window.botIdDariPath = function (pathname) {
  const m = String(pathname || '').match(/^\/(?:bot|config)\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
};

document.addEventListener('DOMContentLoaded', function () {
  if (window.__SIDEBAR_BOUND__) return;
  window.__SIDEBAR_BOUND__ = true;

  siapkanDrawer();

  var s = appShell();
  if (s) {
    var mq = matchMedia('(max-width:760px)');
    var setMini = setSidebarMini;   // satu jalur, jadi `aria-expanded` ikut benar
    setMini(mq.matches);
    mq.addEventListener('change', function (e) { setMini(e.matches); });
    var utama = document.querySelector('main');
    if (utama) utama.addEventListener('click', function (e) {
      if (mq.matches && !s.classList.contains('mini') &&
          !(e.target.closest && e.target.closest('[data-act="toggleSidebar"]'))) setMini(true);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && mq.matches) setMini(true);
    });
  }

  var kini = (location.pathname.replace(/\/+$/, '') || '/');
  var nama = kini === '/' ? 'index' : kini.split('/').pop().replace(/\.html$/, '');
  if (/^\/bot\//.test(kini)) nama = 'dashboard';   // halaman detail bot = anak Dashboard
  document.querySelectorAll('#sidebar nav a[href], aside nav a[href]').forEach(function (a) {
    var h = (a.getAttribute('href') || '/').replace(/\/+$/, '') || '/';
    var hn = h === '/' ? 'index' : h.split('/').pop().replace(/\.html$/, '');
    var match = (h === kini || hn === nama);
    a.classList.toggle('active', match);
    a.classList.toggle('on', match);
  });

  var topAv = document.getElementById('top-avatar-txt');
  var pName = document.getElementById('pop-name');
  var pEmail = document.getElementById('pop-email');
  var pRole = document.getElementById('pop-role');
  fetch('/api/auth/me').then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.ok && d.user) {
      var u = d.user;
      if (topAv && u.username) topAv.textContent = u.username[0].toUpperCase();
      var tn = document.getElementById('top-name');
      if (tn && u.username) tn.textContent = 'Hai, ' + u.username + '!';
      var tr = document.getElementById('top-role');
      if (tr) tr.textContent = u.role_label || (u.is_admin ? 'Admin' : (u.slots ? u.slots + ' Slot' : 'Member'));
      var dAv = document.getElementById('drawer-user-av');
      if (dAv && u.username) dAv.textContent = u.username[0].toUpperCase();
      var dName = document.getElementById('drawer-user-name');
      if (dName && u.username) dName.textContent = 'Hai, ' + u.username + '!';
      var dRole = document.getElementById('drawer-user-role');
      if (dRole) dRole.textContent = u.role_label || (u.is_superadmin ? 'Super Admin' : (u.is_admin ? 'Staff' : (u.slots ? u.slots + ' Slot' : 'Member')));
      if (pName) pName.textContent = u.username || 'User';
      if (pEmail) pEmail.textContent = u.email || (u.username + '@gmail.com');
      if (pRole) pRole.textContent = u.role_label || (u.is_superadmin ? 'Super Admin' : (u.is_admin ? 'Staff' : (u.slots ? u.slots + ' Slot' : 'User')));
      if (u.is_admin) {
        localStorage.setItem('yb-is-admin', '1');
        document.documentElement.classList.add('is-admin');
        if (document.body) document.body.classList.add('is-admin');
        if (!u.is_superadmin) {
          document.documentElement.classList.add('is-staff');
          if (document.body) document.body.classList.add('is-staff');
          var superOnly = ['/kountole/users', '/kountole/orders', '/kountole/saldo', '/kountole/harga'];
          superOnly.forEach(function (href) {
            document.querySelectorAll('a[href="' + href + '"]').forEach(function (el) { el.remove(); });
          });
        }
        var elNav = document.getElementById('nav-admin');
        if (elNav) elNav.style.display = '';
        var elDrwAdmin = document.getElementById('drawer-admin-group');
        if (elDrwAdmin) elDrwAdmin.style.display = 'block';

        var popMenu = document.querySelector('.pop-menu');
        if (popMenu) {
          ['/billing', '/saldo', '/pricing'].forEach(function (href) {
            var el = popMenu.querySelector('a[href="' + href + '"]');
            if (el) el.remove();
          });
          var elStaffBot = document.getElementById('pop-staff-bot');
          if (elStaffBot) elStaffBot.remove();
        }

        // Hapus link retail dari mobile drawer untuk admin/staff
        ['/billing', '/saldo', '/pricing'].forEach(function (href) {
          document.querySelectorAll('.mobile-drawer a[href="' + href + '"], #drw-billing, #drw-saldo, #drw-pricing, .retail-only').forEach(function (el) {
            el.remove();
          });
        });

        ['nav-saldo', 'nav-pricing', 'nav-billing', 'drw-saldo', 'drw-pricing', 'drw-billing'].forEach(function (id) {
          var el = document.getElementById(id);
          if (el) el.style.display = 'none';
        });

        var cp = location.pathname;
        if (cp === '/saldo' || cp.indexOf('/saldo/') === 0) {
          location.replace('/kountole/saldo');
          return;
        }
        if (cp === '/pricing' || cp.indexOf('/pricing/') === 0) {
          location.replace('/kountole/harga');
          return;
        }
        if (cp === '/billing' || cp.indexOf('/billing/') === 0 || cp === '/invoice' || cp.indexOf('/invoice/') === 0) {
          location.replace('/kountole/orders');
          return;
        }
      } else {
        localStorage.removeItem('yb-is-admin');
        document.documentElement.classList.remove('is-admin', 'is-staff');
        if (document.body) document.body.classList.remove('is-admin', 'is-staff');
        var elNav = document.getElementById('nav-admin');
        if (elNav) elNav.remove();

        var pProfil = document.querySelector('.pop-menu a[href="/profil"]');
        if (pProfil && !document.getElementById('pop-billing')) {
          var items = [
            { href: '/billing', id: 'pop-billing', label: 'Riwayat', icon: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6"/>' },
            { href: '/saldo', id: 'pop-saldo', label: 'Saldo', icon: '<path d="M3 7a2 2 0 0 1 2-2h13v4M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2zM16 14h2"/>' },
            { href: '/pricing', id: 'pop-pricing', label: 'Pricing', icon: '<path d="M3 12V4h8l10 10-8 8zM7.5 7.5h.01"/>' }
          ];
          items.forEach(function (it) {
            var a = document.createElement('a');
            a.href = it.href; a.id = it.id; a.className = 'pop-item';
            a.innerHTML = '<svg class="nv-i" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + it.icon + '</svg><span>' + it.label + '</span>';
            pProfil.parentNode.insertBefore(a, pProfil);
          });
        }

        var dProfil = document.getElementById('drw-profil');
        if (dProfil && !document.getElementById('drw-billing')) {
          var dItems = [
            { href: '/billing', id: 'drw-billing', label: 'Riwayat', icon: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6"/>' },
            { href: '/saldo', id: 'drw-saldo', label: 'Saldo', icon: '<path d="M3 7a2 2 0 0 1 2-2h13v4M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2zM16 14h2"/>' },
            { href: '/pricing', id: 'drw-pricing', label: 'Pricing', icon: '<path d="M3 12V4h8l10 10-8 8zM7.5 7.5h.01"/>' }
          ];
          dItems.forEach(function (it) {
            var a = document.createElement('a');
            a.href = it.href; a.id = it.id; a.className = 'drawer-nav-item';
            a.innerHTML = '<svg class="drw-i" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + it.icon + '</svg>' + it.label;
            dProfil.parentNode.insertBefore(a, dProfil);
          });
        }
      }
    }
  }).catch(function () {});

  if (!window.logout) {
    window.logout = function () {
      localStorage.removeItem('yb-is-admin');
      fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).finally(function () {
        location.href = '/login';
      });
    };
  }

  var navAdminGroup = document.getElementById('nav-admin');
  var btnNavManage = document.getElementById('btn-nav-manage');
  if (btnNavManage && navAdminGroup) {
    btnNavManage.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
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
    document.addEventListener('click', function (e) {
      if (navAdminGroup.classList.contains('open') && !navAdminGroup.contains(e.target)) {
        navAdminGroup.classList.remove('open');
        btnNavManage.setAttribute('aria-expanded', 'false');
      }
    });
  }

  function $d(id) { return document.getElementById(id); }

  function syncDrawer() {
    function txt(id) { var el = $d(id); return el ? el.textContent.trim() : ''; }
    function put(id, v) { var el = $d(id); if (el) el.textContent = v; }
    put('drawer-user-av', txt('top-avatar-txt') || '?');
    put('drawer-user-name', txt('top-name') || 'Akun');
    put('drawer-user-role', txt('top-role'));
    var adm = $d('nav-admin'), grp = $d('drawer-admin-group');
    if (grp) grp.style.display = (adm && adm.style.display !== 'none') ? '' : 'none';
  }

  function setMobileDrawer(open) {
    var b = $d('cx-burger-btn'), d = $d('mobile-drawer');
    var was = document.body.classList.contains('drawer-open');
    if (open) syncDrawer();
    document.body.classList.toggle('drawer-open', open);
    if (b) b.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (d) d.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) { var c = $d('drawer-close-btn'); if (c) setTimeout(function () { c.focus(); }, 60); }
    else if (was && b) b.focus();
  }

  function initDrawer() {
    var drawer = $d('mobile-drawer'), overlay = $d('mobile-drawer-overlay');
    if (!drawer || !overlay) return;

    if (overlay.parentNode !== document.body) document.body.appendChild(overlay);
    if (drawer.parentNode !== document.body) document.body.appendChild(drawer);

    var n = 0;
    var uc = drawer.querySelector('.drawer-user-card');
    if (uc) uc.style.setProperty('--n', n++);
    drawer.querySelectorAll('.drawer-nav > *').forEach(function (el) { el.style.setProperty('--n', n++); });
    var lo = drawer.querySelector('.drawer-logout-btn');
    if (lo) lo.style.setProperty('--n', n);

    drawer.querySelectorAll('.drawer-nav-item[href], .drawer-sub-item[href]').forEach(function (a) {
      var h = a.getAttribute('href');
      if (location.pathname === h || location.pathname.indexOf(h + '/') === 0) {
        a.classList.add('on');
        if (a.classList.contains('drawer-sub-item')) {
          var acc = $d('drawer-accordion'), ab = $d('drawer-acc-btn');
          if (acc) acc.classList.add('open');
          if (ab) ab.setAttribute('aria-expanded', 'true');
        }
      }
    });

    var mo = new MutationObserver(syncDrawer);
    ['top-name', 'top-role', 'top-avatar-txt'].forEach(function (id) {
      var el = $d(id);
      if (el) mo.observe(el, { childList: true, characterData: true, subtree: true });
    });
    var adm = $d('nav-admin');
    if (adm) mo.observe(adm, { attributes: true, attributeFilter: ['style'] });
    syncDrawer();

    window.matchMedia('(min-width: 901px)').addEventListener('change', function (e) {
      if (e.matches) setMobileDrawer(false);
    });

    drawer.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var items = Array.prototype.filter.call(
        drawer.querySelectorAll('a[href], button:not([disabled])'),
        function (el) { return el.offsetParent !== null; });
      if (!items.length) return;
      var first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    var touchStartX = 0, touchStartY = 0;
    drawer.addEventListener('touchstart', function (e) {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });
    drawer.addEventListener('touchend', function (e) {
      var dx = touchStartX - e.changedTouches[0].clientX;
      var dy = Math.abs(touchStartY - e.changedTouches[0].clientY);
      if (dx > 45 && dx > dy) setMobileDrawer(false);
    }, { passive: true });
  }

  initDrawer();

  document.addEventListener('click', function (e) {
    if (e.target.closest('#cx-burger-btn')) {
      e.preventDefault(); e.stopPropagation(); setMobileDrawer(true); return;
    }
    if (e.target.closest('#drawer-close-btn') || e.target.closest('#mobile-drawer-overlay')) {
      e.preventDefault(); setMobileDrawer(false); return;
    }
    var ab = e.target.closest('#drawer-acc-btn');
    if (ab) {
      var acc = $d('drawer-accordion');
      if (acc) ab.setAttribute('aria-expanded', String(acc.classList.toggle('open')));
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && document.body.classList.contains('drawer-open')) setMobileDrawer(false);
  });

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

  document.querySelectorAll('.cx-nav-item[href]').forEach(function (a) {
    var h = a.getAttribute('href');
    if (location.pathname === h || location.pathname.startsWith(h + '/')) a.classList.add('on', 'active');
  });

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
