# Laporan Audit Keamanan — Qwertygate / yaparbots

**Tanggal:** 13 Okt 2026
**Repo:** `pariiee/jadibo-qwerty` (yaparbots)
**HEAD produksi:** `e664689` — "merge: audit tahap 1 & 1b — atomic money, cooldown, 3 kolom hidup"
**Server:** Box D `/var/www/jadibot`, PM2 `jadibot` — online, unstable restarts 0
**Status:** Tahap 1 & 1b SELESAI, ter-deploy, terverifikasi di DB produksi

---

## 1. Ringkasan

| | |
|---|---|
| Temuan audit awal | **27** (4 🔴 / 6 🟠 / 10 🟡 / 7 🟢) |
| Sudah diperbaiki & deploy | **9** |
| Belum dikerjakan | **18** |
| Tes | 58 file lolos |
| Perubahan | 21 file, +2138 / -152 |

**Yang paling penting hari ini:** ditemukan **bug produksi yang membuat 10 fitur RPG mati total** — bukan karena kode rusak, tapi karena **3 kolom database lupa dibuat**. Sekarang hidup.

---

## 2. 🔴 Yang sudah diperbaiki (deploy: `e664689`)

### 2.1 Bug produksi — 3 kolom hilang, 10 fitur mati

**Masalah.** Kode menulis kolom `rpg_members` yang tidak pernah ada di `schema.sql` maupun `scripts/sync-schema.js`. Setiap command yang menulisnya langsung error `Unknown column`, dan pesannya tidak sampai ke user (kena catch) — jadi fiturnya cuma **diam**.

| Kolom hilang | Fitur yang mati |
|---|---|
| `energi` | `.mancing` `.kerja` `.berburu` `.tambang` `.kebon` `.tebang` `.maling` `.adventure` `.koboy` |
| `last_energi` | (cooldown regenerasi energi, dipakai fitur yang sama) |
| `last_bertarung` | `.bertarung` / `.fight` |

**Perbaikan.** Ditambahkan ke `schema.sql` **dan** `scripts/sync-schema.js` (instalasi baru dapat, DB lama ikut migrasi saat deploy).

**Verifikasi di DB produksi:**
```
rpg_members.energi:          ADA (int(11), default 100)
rpg_members.last_energi:     ADA (datetime, default NULL)
rpg_members.last_bertarung:  ADA (datetime, default NULL)
command hidup: mancing, kerja, berburu, bertarung, maling, adventure, koboy
```

**Kenapa bisa lolos selama ini:** tidak ada satu pun tes yang membandingkan **kolom yang ditulis kode** dengan **kolom yang ada di skema**. Bug kelas ini tidak akan pernah ketahuan lewat pembacaan kode biasa.

---

### 2.2 Race condition pada uang (duplikasi saldo)

**Masalah.** Pola baca-lalu-tulis: `SELECT money` → hitung di JS → `UPDATE money = <hasil>`. Dua request bersamaan dua-duanya lolos → saldo dobel.

**Bukti (tes konkurensi MySQL, sebelum diperbaiki):**
```
100× paralel -1 (harusnya 64 menang)
  menang: 64, saldo: 10280  ← vs ekspektasi 10028 (selisih 252)
```
Saldo bertambah dari sumber yang tidak ada. Uang palsu.

**Perbaikan.** Semua jalur kritis jadi **UPDATE bersyarat** — MySQL yang memutuskan pemenang, bukan JS:

```js
// SEBELUM (race)
const s = await bacaSaldo(); if (s >= 100) await tulis(s - 100);

// SESUDAH (atomic — syarat jadi bagian WHERE)
UPDATE rpg_members SET money = money - 100 WHERE id = ? AND money >= 100
// affectedRows === 0 → kalah, tidak ada perubahan
```

**Verifikasi:** 100× paralel `-1` → saldo tepat `9900`; 100× transfer bolak-balik A↔B → total A+B konstan `20000`.

**Fitur yang dikonversi:**
- `updateMoneyDelta` — helper atomic baru (dipakai slot, gacha, coinflip, transfer)
- `transferMoney` — transfer antar user
- `klaimBerkala` — claim/daily, hourly, weekly, dailymisi
- `klaimBerEnergi` — mancing, kerja (**sekali query: potong energi + kasih reward**; dulu energi dipotong duluan, kalau reward gagal energi terlanjur hilang)
- `berburu` — transaksi + `FOR UPDATE` (read-modify-write JSON, tidak bisa pakai `col = col + ?`)
- `gajian` — UPDATE bersyarat

---

### 2.3 Kredensial admin default

**Masalah.** `server.js` punya fallback `KING_PASSWORD = 'king123'` dan `KING_USERNAME` tidak dijaga. Kalau `.env` tidak lengkap, admin dibuat dengan sandi yang bisa ditebak.

**Perbaikan.** Guard boot: server **menolak start** kalau `KING_USERNAME`/`KING_PASSWORD` kosong. Placeholder di `.env.example` diganti instruksi jelas.

**Kunci:** `test/guard-boot.js`

---

### 2.4 Bot hidup tanpa bayar (`stop_reason`)

**Masalah.** Setelah paket kedaluwarsa, `stop_reason='expired'`. User bisa klik **Start** manual → bot hidup ~1 menit → cron mematikan → klik lagi. Bot hidup ~50–60% waktu **tanpa bayar**.

**Perbaikan.** `terapkanPaket()` mereset `stop_reason=NULL` **sebelum** `engineBus.start()`, hanya untuk nilai `'expired'`. Bayar → hidup; belum bayar → mati.

**Kunci:** `test/stop-reason-bayar.js`

---

### 2.5 Kebocoran nama env / path / errno ke pesan user

**Masalah.** Pesan error mentah sampai ke WA/chat/panel, membocorkan nama variabel `.env`, path server, dan kode errno — peta gratis untuk penyerang. Contoh nyata: *"Tanpa teks = pakai default dari .env (DEFAULT_SETCLOSE)"*.

**Perbaikan.** Helper terpusat:
- `rapikanError(e)` — bot
- `pesanUntukUser(msg, fallback)` — BE

Diterapkan di **81 tempat** (7 plugin bot) + **25 file BE**. Detail teknis tetap masuk `console.*` (PM2) supaya bisa di-debug.

**Kunci:** `test/tanpa-bocor-env.js` (scan statis — gagal kalau ada `${e.message}` baru)

---

### 2.6 Cooldown terpusat

**Masalah.** Command berat (downloader, judi, RPG) bisa di-spam tanpa batas.

**Perbaikan.** `config/cooldown.js` + `engine/cooldown.js`. Kelompok: `umum`, `berat`, `upload`, `judi`, `admin-grup`, `owner-destructive`. Balasan "⏳ Tunggu ..." hanya sekali per jendela (tidak spam).

**Kunci:** `test/cooldown-perilaku.js`, `test/cooldown-tersentral.js`

**⚠️ Tersisa (butuh keputusan Pak):** owner/dev **tidak** dikecualikan di kelompok `berat` (cuma `umum`). Perlu ditentukan: (A) kecualikan hanya di `umum`, atau (B) kecualikan di semua kecuali `owner-destructive`.

---

## 3. 🟠 Belum dikerjakan

| # | Temuan | Lokasi | Risiko |
|---|---|---|---|
| 1 | `.kickall` tanpa konfirmasi ganda | `plugins/02-group.js` | Admin salah klik → semua anggota keluar |
| 2 | `.viewonce` menyimpan & meneruskan media tanpa izin | `plugins/04-tools.js` | Pelanggaran privasi pengirim |
| 3 | `JARVIS` `DENY_CMD` bisa dilewati | `plugins/09-jarvis.js` | Batasan tidak berlaku |
| 4 | `copet`, `maling` masih baca-lalu-tulis | `plugins/03-fun-rpg.js` | Race uang (pola lama) |
| 5 | `bank`/`atm` multi-field belum atomic | `plugins/03-fun-rpg.js` | Race saldo bank |
| 6 | `dungeon`, `adventure`, `koboy` belum atomic | `plugins/03-fun-rpg.js` | Race reward |

---

## 4. 🟡 & 🟢 (18 temuan sisa)

Lihat `docs/audit-1b-risiko.md` untuk inventaris lengkap call site. Ringkasnya: validasi input upload, batas ukuran beberapa jalur, konsistensi error handling, hardening header, logging audit untuk aksi owner.

---

## 5. Tes yang ditinggalkan (dan kenapa)

| File | Mengunci apa |
|---|---|
| `skema-vs-kode.js` | Kolom ditulis kode harus ada di skema — **langsung menemukan `last_bertarung`** |
| `konkurensi-uang.js` | 100× paralel → saldo eksak (race uang) |
| `konkurensi-klaim.js` | 50× paralel → tepat 1 menang, energi tidak negatif |
| `konkurensi-judi.js` | Slot & gacha atomic |
| `uang-atomik.js` | `updateMoneyDelta`/`transferMoney` |
| `cooldown-perilaku.js` | Cooldown perilaku per kelompok |
| `cooldown-tersentral.js` | Peta command → kelompok |
| `guard-boot.js` | Server tolak start tanpa kredensial admin |
| `stop-reason-bayar.js` | Reset `stop_reason` sebelum start |
| `tanpa-bocor-env.js` | Tidak ada nama env/path/errno bocor |

**Tes konkurensi wajib `DB_NAME_TEST`** — belum diisi = SKIP, sama dengan DB produksi = GAGAL. DB produksi tidak boleh disentuh tes.

---

## 6. Sudah aman (tidak perlu diubah)

`requireAuth`/`requireKing` · cookie httpOnly + sameSite=lax + secure · boot guard `JWT_SECRET`/`INTERNAL_KEY` · helmet + CSP · rate-limit (20 auth/15m, 120 API/min) · `sessions/` tidak di-static · webhook `crypto.timingSafeEqual` · body mentah sebelum `express.json` · `token_version` kill switch · slug anti-scanner · cleanup file sementara · bcrypt cost 12.

---

## 7. Rekomendasi berikutnya (urut prioritas)

1. **Sisa Cluster A/B** — `copet`, `maling`, `bank`/`atm`, `dungeon`, `adventure`, `koboy` (pola race yang sama, tinggal pakai helper yang sudah ada)
2. **Keputusan cooldown owner/dev** — butuh jawaban Pak (A) atau (B)
3. **`.kickall` konfirmasi ganda**
4. **`.viewonce` privasi**
5. **Temuan 🟡/🟢** — hardening & konsistensi

---

## 8. Catatan jujur

- Waktu merge, `deploy.py` saya jalankan **2×** tanpa sengaja. Efek: restart PM2 ganda saja. Tidak ada kerusakan.
- Sempat **salah curiga** kolom energi tidak dibuat, padahal output deploy cuma terpotong di tampilan. Pelajaran: baca log lengkap sebelum melapor.
- `test/cooldown-perilaku.js` menemukan owner/dev tidak dikecualikan di kelompok `berat` — **masih menunggu keputusan Pak**, belum saya ubah.
- 3 file `.bak` di VPS (`.env.bak-1790673167`, `.env.bak-20261002-104810`, `plugins/02-group.js.bak-sebelum-tagall`) **tidak dihapus** — berisi kredensial, menunggu izin Pak.
