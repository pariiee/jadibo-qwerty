// Delegasi klik buat [data-act] — pengganti handler inline.
// CSP ketat nggak nge-blokir ini (file eksternal), jadi nggak ada
// 'unsafe-inline' buat script.
// data-act isinya nama fungsi yang di-export tiap halaman ke window
// (lihat bagian `window.x = x` di index/dashboard/bot-detail/head).
// Argumennya literal sederhana: 'teks', true/false, angka. Kalau nanti butuh
// objek, bikin fungsi khususnya — jangan tambah parser.
function bacaArg(teks) {
  const t = teks.trim();
  if (!t) return undefined;
  if ((t[0] === "'" && t.endsWith("'")) || (t[0] === '"' && t.endsWith('"'))) return t.slice(1, -1);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  return Number.isNaN(Number(t)) ? t : Number(t);
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const cocok = /^([A-Za-z_$][\w$]*)(?:\((.*)\))?$/.exec(el.dataset.act.trim());
  if (!cocok) return;
  const fn = window[cocok[1]];
  if (typeof fn !== 'function') { console.warn('[act] nggak ada fungsinya:', el.dataset.act); return; }
  e.preventDefault();
  fn(cocok[2] === undefined ? undefined : bacaArg(cocok[2]), el, e);
});

window.showToast = function (msg, tipe) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  // gaya dari CSS (#toast) — jangan pakai kelas Tailwind, Tailwind nggak dimuat
  t.className = tipe === 'error' ? 'toast-error' : tipe === 'success' ? 'toast-success' : '';
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => t.classList.remove('on'), 2500);
};
