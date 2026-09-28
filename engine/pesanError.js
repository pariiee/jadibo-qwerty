'use strict';

/**
 * engine/pesanError.js
 * Helper: ubah pesan error mentah dari Node/axios jadi kalimat yang user awam ngerti.
 *
 * Contoh yang mau dibunuh:
 *   `connect ETIMEDOUT 172.64.80.1:443; connect ENETUNREACH 2606:4700::443 - Local (:::0)`
 *   → `koneksi ke servernya timeout`
 *   `Cannot read properties of undefined (reading 'replace')`
 *   → `ada gangguan teknis di sisi server`
 *
 * Aturan penting: yang diterjemahin cuma teks yang BAU TEKNIS. Kalimat yang udah
 * manusia (mis. error buatan kita sendiri: "Format data soal tidak valid dari API")
 * dibiarin apa adanya — jangan diganti jadi "gangguan teknis".
 *
 * Log/console TIDAK pakai helper ini: di sana error mentah tetap ditulis utuh
 * biar masih bisa di-debug.
 */

const RULES = [
  // Urutan penting: pesan nyata Node sering bawa DUA kegagalan sekaligus
  // (`connect ETIMEDOUT 172.64.80.1:443; connect ENETUNREACH 2606:4700::443`).
  // Timeout ditaruh dulu supaya yang kebaca user = yang dia rasain.
  [/ETIMEDOUT|ESOCKETTIMEDOUT|timeout of \d+ms|timed? ?out/i, 'koneksi ke servernya timeout'],
  [/ENOTFOUND|EAI_AGAIN/,                          'alamat servernya nggak ketemu (cek koneksi internet)'],
  [/ECONNREFUSED/,                                 'servernya nolak koneksi'],
  [/ERR_FR_TOO_MANY_REDIRECTS|too many redirects/, 'link-nya muter-muter terus (redirect kebanyakan)'],
  [/ENETUNREACH|EHOSTUNREACH|ENETDOWN/,            'jaringan bot nggak punya jalur ke servernya'],
  [/ECONNRESET|socket hang up|ECONNABORTED/,       'koneksi putus di tengah jalan'],
  [/network|getaddrinfo/i,                         'jaringan bot lagi bermasalah'],
  [/certificate|self.signed|CERT_/,                'sertifikat keamanan servernya bermasalah'],
  [/status code 4\d\d|HTTP 4\d\d/i,                'link-nya nggak valid atau udah nggak bisa diakses'],
  [/status code 5\d\d|HTTP 5\d\d/i,                'server sumbernya lagi error'],
  [/quota|rate.?limit|too many requests|429/i,     'lagi kena limit dari server sumbernya'],
  [/ffmpeg|ffprobe/,                               'gagal proses medianya (ffmpeg error)'],
  [/ENOSPC/,                                       'penyimpanan server penuh'],
  [/EACCES|EPERM/,                                 'server nggak dikasih izin buat itu'],
  [/entity too large|413|payload too large/i,      'file-nya kebesaran'],
  // yt-dlp/ffmpeg balikin "Command failed: /usr/local/bin/yt-dlp …" — itu bocorin
  // isi server, user cukup tahu link-nya nggak didukung.
  [/Unsupported URL|Command failed|No such file|ENOENT/i, 'link-nya belum didukung'],
  // Error runtime JS (bug di kode kita) — user nggak perlu lihat stack-nya.
  [/Cannot read propert|is not a function|is not defined|undefined \(reading|of null|TypeError|ReferenceError/i,
                                                   'ada gangguan teknis di sisi server'],
];

/** Teks yang "bau teknis" = kode error, alamat IP, status HTTP, error runtime JS,
 *  atau jejak isi server (path absolut, nama binary, stack frame).
 *  PENTING: kode errno dicek case-SENSITIVE — `E[A-Z]{3,}` kalau pakai flag `i`
 *  ikut nangkep kata biasa ("b**elum**"), jadi pesan ramah malah dianggap mentah. */
const TEKNIS = [
  /\bE[A-Z]{3,}\b/,                                   // ETIMEDOUT, ENOTFOUND, … (case-sensitive)
  /connect |status code|timeout of|too many requests|payload too large|Command failed|Unsupported URL|Cannot read propert|is not a function|is not defined|undefined \(reading|ffmpeg|ffprobe|\b4\d\d\b|\b5\d\d\b|\d+\.\d+\.\d+\.\d+|\/usr\/local\/bin|\/var\/www|node_modules|[A-Z]:\\|\bat\s+[\w.$<>]+\s*\(/i,
];
const bauTeknis = (teks) => TEKNIS.some((pola) => pola.test(teks));

function rapikanError(err) {
  if (!err) return 'ada gangguan yang nggak diketahui';

  // Error dari API kita sendiri (axios): server sudah nerjemahin pesannya
  // (BE api/_lib/pesanaman.js) — pakai itu biar user dapat alasan yang jelas,
  // bukan "server sumbernya lagi error".
  const dariApi = err?.response?.data?.message;
  if (typeof dariApi === 'string' && dariApi.trim() && !bauTeknis(dariApi)) return dariApi.trim();

  const mentah = typeof err === 'string' ? err : (err.message || String(err));
  if (!mentah) return 'ada gangguan yang nggak diketahui';

  // Kalimat yang udah manusia → biarin apa adanya.
  if (!bauTeknis(mentah)) return mentah;

  // URUTAN PENTING: kode HTTP mentah dicek DULU. Kalau tidak, `Request failed with
  // status code 429` (kena limit) dan `…408` (server ngadat) ketangkep aturan
  // umum `status code 4\d\d` di bawah dan member dikasih "link-nya nggak valid" —
  // padahal LINKNYA SAH. Terukur 2026-09-28: satu perintah `.tt` gagal dijawab
  // "linknya nggak valid" tiga kali padahal linknya jalan. Status itu yang paling
  // jujur soal siapa yang salah: 400/404 = link, 401/403 = kunci/akses,
  // 408/429/5xx = server sumber yang rewel, bukan link member.
  const httpStatus = /status code\s*(\d{3})|HTTP (\d{3})/i.exec(mentah);
  if (httpStatus) {
    const kode = Number(httpStatus[1] || httpStatus[2]);
    const perKode = {
      400: 'link-nya nggak valid atau udah nggak bisa diakses',
      401: 'izin akses ke server sumbernya ditolak',
      403: 'server sumbernya nolak akses ke link ini',
      404: 'link-nya nggak valid atau udah nggak bisa diakses',
      408: 'server sumbernya kelewat lama balesnya',
      413: 'file-nya kebesaran',
      429: 'lagi kena limit dari server sumbernya',
    };
    return perKode[kode] || (kode >= 500 ? 'server sumbernya lagi error' : 'lagi ada gangguan di server sumbernya');
  }

  for (const [pola, pesan] of RULES) if (pola.test(mentah)) return pesan;

  // Teknis tapi nggak ketemu aturannya → jangan bocorin raw error ke user.
  return 'ada gangguan teknis di sisi server';
}

/** Bikin string balasan siap kirim: `❌ Gagal download TikTok: <pesan ramah>.` */
function gagalError(aksi, err) {
  return `❌ Gagal ${aksi}: ${rapikanError(err)}.`;
}

module.exports = { rapikanError, gagalError };
