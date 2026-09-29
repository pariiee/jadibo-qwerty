/**
 * config/beban.js — nyatet naik/turunnya beban host.
 *
 * VPS B itu box berbagi (disk image /dev/loop27): pernah ke-load 168 padahal
 * nggak satu pun proses kita yang boros CPU — murni I/O wait tetangga. Pas itu
 * web ikut mati ~20 menit, dan pm2 cuma nyimpen "[NODE-CRON] missed execution",
 * nggak ada satu baris pun yang nyebut sebabnya. Fungsi ini yang nyatet, jadi
 * kalau mau komplain ke hosting ada garis waktunya.
 *
 * Ditulis cuma pas status BERUBAH — kalau tiap menit ditulis, log-nya 1440
 * baris/hari dan yang penting malah tenggelam.
 */
const os = require('os');

const CORES = os.cpus().length;

// 4x jumlah core = udah jelas rebutan, bukan sekadar ramai. Bisa ditimpa lewat
// env biar bisa diuji tanpa harus bikin box-nya benar-benar sekarat.
const batas = () => Number(process.env.LOAD_BATAS) || CORES * 4;

let tinggiSebelumnya = false;

/** Baris log kalau status berubah; null kalau masih sama seperti sebelumnya. */
function cek(beban = os.loadavg()[0]) {
  const tinggi = beban > batas();
  if (tinggi === tinggiSebelumnya) return null;
  tinggiSebelumnya = tinggi;
  const mb = Math.round(os.freemem() / 1048576);
  return `[Beban] ${tinggi ? 'NAIK' : 'turun'} load=${beban.toFixed(1)} ` +
         `(batas ${batas()}, ${CORES} core) free=${mb}MB`;
}

/** Buat tes: balikin state ke "normal". */
function reset() { tinggiSebelumnya = false; }

module.exports = { cek, reset, CORES };
