/**
 * Regresi: jam log harus dibaca sebagai UTC dari server, bukan waktu lokal.
 *
 * Kenapa ada: bot_logs.created_at itu kolom MySQL TIMESTAMP yang diserialisasi
 * mysql2 sebagai UTC tanpa penanda zona (mis. "2026-09-14 13:21:12").
 * new Date("2026-09-14 13:21:12") di JS dibaca sebagai waktu LOKAL — di WIB
 * (UTC+7) itu bikin jam log meleset 7 jam, jadi log sesi lama keliatan kayak
 * barusan terjadi. Bug yg dilaporkan user.
 */

// Salinan fungsi dari public/bot-detail.html — biar tes nggak butuh DOM.
function logTime(v, now = new Date()) {
  if (!v) return now.toLocaleTimeString('id-ID', { hour12: false });
  const s = /Z|[+-]\d\d:?\d\d$/.test(v) ? v : String(v).replace(' ', 'T') + 'Z';
  const d = new Date(s);
  return isNaN(d) ? String(v) : d.toLocaleTimeString('id-ID', { hour12: false });
}

const ok = (label, got, want) => {
  const pass = got === want;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${label}: ${got}${pass ? '' : ` (harusnya ${want})`}`);
  if (!pass) process.exitCode = 1;
};

// 13:21:12 UTC -> 20:21:12 WIB
ok('UTC tanpa penanda -> WIB', logTime('2026-09-14 13:21:12'), '20.21.12');
// Yang udah ada 'Z' jangan ditambahin lagi (double-Z = Invalid Date)
ok('sudah ISO+Z tetap benar', logTime('2026-09-14T13:21:12Z'), '20.21.12');
// Offset eksplisit jangan diutak-atik
ok('offset +07:00 dihormati', logTime('2026-09-14T13:21:12+07:00'), '13.21.12');
// Tanpa timestamp (log live dari WS) -> pakai jam sekarang
const now = new Date('2026-09-14T13:21:12Z');
ok('tanpa timestamp -> jam sekarang', logTime(null, now), '20.21.12');
// Sampah jangan bikin 'Invalid Date'
ok('nilai rusak tidak jadi Invalid Date', logTime('bukan-tanggal'), 'bukan-tanggal');

// Bukti bug lama: new Date() polos baca sebagai lokal
const naive = new Date('2026-09-14 13:21:12');
const real = new Date('2026-09-14T13:21:12Z');
console.log(
  `cek  naive vs UTC selisih ${Math.abs(naive - real) / 3600000} jam` +
  ` (${naive.getTime() === real.getTime() ? 'kebetulan sama di TZ ini' : 'BEDA -> bug nyata di TZ ini'})`
);
