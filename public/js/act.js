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

function parseArgs(raw) {
  if (raw === undefined || !raw.trim()) return [];
  const args = [];
  let cur = '';
  let inQuote = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if ((c === "'" || c === '"') && (i === 0 || raw[i - 1] !== '\\')) {
      if (inQuote === c) inQuote = null;
      else if (!inQuote) inQuote = c;
    }
    if (c === ',' && !inQuote) {
      args.push(bacaArg(cur));
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim()) args.push(bacaArg(cur));
  return args;
}

if (!window.__actInit) {
  window.__actInit = true;
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const cocok = /^([A-Za-z_$][\w$]*)(?:\((.*)\))?$/.exec(el.dataset.act.trim());
    if (!cocok) return;
    const fn = window[cocok[1]];
    if (typeof fn !== 'function') { console.warn('[act] nggak ada fungsinya:', el.dataset.act); return; }
    e.preventDefault();
    const args = parseArgs(cocok[2]);
    args.push(el, e);
    fn(...args);
  });
}

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

// Isi kartu paket — SATU tempat untuk landing `/` dan halaman bayar `/pricing`.
// Dulu dua-duanya menulis daftarnya sendiri, jadi isinya beda walau paketnya
// sama: landing bilang "Jumlah Fitur : 100", /pricing bilang "100 fitur" +
// "30 pesan / hari". Sekarang satu sumber, satu urutan, satu ejaan.
//
// `fitur` = jumlah command yang tersedia. Paket TIDAK membatasi fitur (semua
// paket dapat semua command), jadi angkanya sama untuk tiap paket — dikirim
// pemanggil karena cuma dia yang tahu total dari /api/command.
window.daftarPaket = function (p, fitur) {
  const angka = (n) => Number(n || 0).toLocaleString('id-ID');
  return {
    baris: [
      (p.slots || 1) + ' Slot Bot Aktif',
      angka(p.receive_limit) + ' Kuota Respon',
      p.owner_max + ' Owner Bot',
      'Masa aktif ' + p.days + ' hari',
      'Online 24 Jam',
    ],
    extra: 'Custom Bot (Nama & Prefix)',
  };
};
