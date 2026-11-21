// ui-popup.js — dialog & toast bertema, pengganti alert()/confirm() bawaan browser.
// alert() di-override jadi toast (tidak memblokir). Kalau pesan harus terbaca sebelum
// pindah halaman, pakai `await uiToast('...')` baru navigasi.
(function () {
  var CSS = [
    '.uip-bd{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(12,12,12,.45);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);opacity:0;transition:opacity .16s ease}',
    '.uip-bd.show{opacity:1}',
    '.uip-card{width:100%;max-width:400px;background:var(--bt-card,#fff);color:var(--bt-text,#151515);border:2px solid var(--bt-line,#151515);border-radius:22px;padding:22px;box-shadow:7px 7px 0 rgba(21,21,21,.85);transform:translateY(10px) scale(.98);transition:transform .2s cubic-bezier(.16,1,.3,1);font-family:inherit}',
    '.uip-bd.show .uip-card{transform:none}',
    '.uip-k{font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;opacity:.55;margin:0 0 9px}',
    '.uip-m{font-size:15.5px;font-weight:600;line-height:1.5;margin:0;white-space:pre-line}',
    '.uip-a{display:flex;gap:10px;margin-top:20px;justify-content:flex-end;flex-wrap:wrap}',
    '.uip-b{font:inherit;font-size:14px;font-weight:800;padding:10px 18px;border-radius:999px;border:2px solid var(--bt-line,#151515);background:transparent;color:inherit;cursor:pointer;transition:transform .12s}',
    '.uip-b:active{transform:translateY(1px)}',
    '.uip-ok{background:var(--bt-lime,#c8f36a);color:#111}',
    '.uip-danger{background:#ff6b6b;color:#1a0a0a}',
    '.uip-b:focus-visible{outline:3px solid var(--bt-sky,#7cc4ff);outline-offset:2px}',
    '.uip-toast{position:fixed;left:50%;bottom:26px;transform:translate(-50%,20px);z-index:99999;max-width:min(92vw,420px);padding:13px 18px;border:2px solid #151515;border-radius:16px;background:#151515;color:#fff;font:700 14px/1.45 inherit;box-shadow:5px 5px 0 rgba(21,21,21,.35);opacity:0;transition:opacity .2s ease,transform .2s ease}',
    '.uip-toast.show{opacity:1;transform:translate(-50%,0)}',
  ].join('');

  function inject() {
    if (document.getElementById('uip-style')) return;
    var s = document.createElement('style');
    s.id = 'uip-style';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function toast(msg, ms) {
    inject();
    var t = document.createElement('div');
    t.className = 'uip-toast';
    t.setAttribute('role', 'status');
    t.textContent = msg == null ? '' : String(msg);
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    return new Promise(function (res) {
      setTimeout(function () {
        t.classList.remove('show');
        setTimeout(function () { t.remove(); res(true); }, 220);
      }, ms || 2600);
    });
  }

  function dialog(msg, opts) {
    inject();
    opts = opts || {};
    return new Promise(function (resolve) {
      var prev = document.activeElement;
      var wrap = document.createElement('div');
      wrap.className = 'uip-bd';
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-modal', 'true');

      var card = document.createElement('div');
      card.className = 'uip-card';

      var k = document.createElement('p');
      k.className = 'uip-k';
      k.textContent = opts.title || 'Konfirmasi';

      var m = document.createElement('p');
      m.className = 'uip-m';
      m.textContent = msg == null ? '' : String(msg);

      var acts = document.createElement('div');
      acts.className = 'uip-a';

      function done(v) {
        document.removeEventListener('keydown', onKey);
        wrap.remove();
        if (prev && prev.focus) { try { prev.focus(); } catch (e) {} }
        resolve(v);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); done(false); }
        else if (e.key === 'Enter') { e.preventDefault(); done(true); }
      }

      var ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'uip-b uip-ok';
      ok.textContent = opts.ok || 'Ya, lanjut';
      ok.onclick = function () { done(true); };

      if (!opts.oneButton) {
        var no = document.createElement('button');
        no.type = 'button';
        no.className = 'uip-b';
        no.textContent = opts.cancel || 'Batal';
        no.onclick = function () { done(false); };
        acts.appendChild(no);
        ok.className += opts.danger ? ' uip-danger' : '';
      }
      acts.appendChild(ok);

      card.appendChild(k);
      card.appendChild(m);
      card.appendChild(acts);
      wrap.appendChild(card);

      wrap.addEventListener('mousedown', function (e) { if (e.target === wrap) done(false); });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(wrap);
      requestAnimationFrame(function () { wrap.classList.add('show'); ok.focus(); });
    });
  }

  window.uiToast = toast;
  window.uiConfirm = function (msg, opts) { return dialog(msg, opts); };
  window.uiAlert = function (msg, opts) {
    return dialog(msg, Object.assign({ ok: 'Oke', oneButton: true }, opts || {}));
  };
  window.alert = function (msg) { toast(msg); };
})();
