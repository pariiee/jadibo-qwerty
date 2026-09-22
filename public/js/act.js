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

window.showToast = function (msg, tipe = 'info') {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'fixed bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg text-white text-sm shadow-lg transition-opacity z-[100]';
    document.body.appendChild(t);
  }
  t.className = t.className.replace(/bg-\S+/g, '') + (tipe === 'error' ? ' bg-red-600' : tipe === 'success' ? ' bg-green-600' : ' bg-gray-800');
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 2500);
};
