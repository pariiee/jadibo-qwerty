# Laporan Risiko — Tahap 1b (audit #1 race condition money)

> **Status: BELUM DIUBAH** — Pak meminta "tampilkan dulu daftar lengkap call site baca-lalu-tulis lain yang kamu temukan beserta tingkat risikonya, jangan langsung ubah semuanya."
>
> Tahap 1 sudah menutup `transfer` (antar-user) dan `coinflip` (judi 50/50) di file `plugins/03-fun-rpg.js`. Tersisa handler lain yang juga baca-lalu-tulis `money`/`xp`/kolom lain — beberapa punya window eksploitasi yang sama.

## Inventaris call site (semua di `plugins/03-fun-rpg.js` kecuali disebut lain)

| # | Command | Baris | Pola | Risiko | Penjelasan |
|---|---|---|---|---|---|
| 1 | `claim` / `daily` | 1201 | cek `m.last_claim` → +reward 500 | 🟠 Tinggi | Cooldown 24 jam, tapi 2 request dalam 1 ms lolos cek → reward dobel. Eksploitasi rendah (butuh timing presisi), tapi kerugian = duplikasi uang gratis. |
| 2 | `berburu` / `hunt` | 1508 | cek senjata/HP → tambah xp+duit+HP | 🟠 Tinggi | Cek `healt` & `money`, tambah reward. 2 request bersamaan bisa 2x reward. Sama dengan `claim`. |
| 3 | `gajian` | 1735 | cek `last_gajian` → +duit | 🟠 Tinggi | Cooldown 24 jam. Eksploitasi identik `claim`. |
| 4 | `job` | 1714 | cek `last_kerja` → set job | 🟡 Sedang | Perubahan `job`/`jobexp` saja, duplikasi tidak punya nilai ekonomis langsung. |
| 5 | `kerja` | 2431 | cek `last_kerja` → +duit | 🟠 Tinggi | Cooldown 1 jam. 2 request lolos cek → duplikasi. |
| 6 | `bank` / `atm` (setor) | 2228 | cek `dompet` → `dompet - n, bank + n` | 🟡 Sedang | Single-user, kerugian max = satu kali setor. Tidak ada transfer, jadi duplikasi tidak punya efek ekonomi langsung. Multi-field UPDATE masih di luar scope `updateMoneyDelta` (1 row, 1 field). |
| 7 | `bank` / `atm` (tarik) | (lain) | cek `bank` → `dompet + n, bank - n` | 🟡 Sedang | Sama dengan #6. |
| 8 | `slot` | 2691 | cek duit → random outcome → +/-duit | 🔴 Kritis | Judi seperti coinflip, BUKAN duplikasi reward TAPI: cek `money` → main → update. 2 request bersamaan bisa 2x menang. |
| 9 | `gacha` | 2546 | cek duit → random item → -duit | 🟠 Tinggi | Mirip slot, kerugian = dapat item gratis. |
| 10 | `tictactoe` | 2507 | tidak langsung money | 🟢 Rendah | — |
| 11 | `hourly` | 2755 | cek `last_hourly` → +duit | 🟠 Tinggi | Cooldown 1 jam, sama `claim`. |
| 12 | `weekly` | 2795 | cek `last_weekly` → +duit | 🟠 Tinggi | Cooldown 1 minggu, eksploitasi sulit tapi tetap ada. |
| 13 | `dailymisi` | 2840 | cek `last_dailymisi` → +duit | 🟠 Tinggi | Cooldown 24 jam. |
| 14 | `mancing` | 2274 | cek `last_mancing` → +duit+xp+item | 🟠 Tinggi | Cooldown 30 menit. |
| 15 | `copet` | 2123 | cek `last_maling` cooldown + cek polisi/penjara → +duit | 🟠 Tinggi | Mirip maling, eksploitasi timing. |
| 16 | `maling` | 3122 | cek cooldown → +duit | 🟠 Tinggi | Cooldown 1 jam. |
| 17 | `penjara` / `bebaskan` | 2073, 2104 | set `last_ditahan` & pindah duit | 🟠 Tinggi | `bebaskan` membayar tebusan: cek `bank_money` → kurangi. Single-user, kerugian = satu kali bayar. Tapi 2x bayar bisa double-bayar. |
| 18 | `money` | 2173 | update `bank_money` | 🟡 Sedang | Setor/tarik via `bank_money` (sama #6). |
| 19 | `repair` | 1369 | kurangi money (jual item) | 🟢 Rendah | Single-user, kerugian = satu kali beli. |
| 20 | `rpg` (profil) | 1178 | tidak ada write money | 🟢 — | — |
| 21 | `unreg` | 2378 | pool.execute DELETE/reset | 🟠 Tinggi | Reset RPG user. 2 request = reset 2x (idempotent aman), tapi ada `INSERT … ON DUPLICATE KEY` yang race. |
| 22 | `skill` | 2025 | update xp & stats | 🟡 Sedang | Cek level, update xp+stats. Single-user, duplikasi = duplikasi XP. |
| 23 | `topkoin` / `leaderboard` | 1342, 1810 | read-only | 🟢 — | — |
| 24 | `unjail` (di penjara handler) | 2073 | tunggu masa | 🟡 Sedang | Single-user. |
| 25 | `topup` (admin only) | 567 (billing) | update `bots.daily_limit` dll | 🟢 — | Hanya admin, throttle sudah di tempat. |

## Yang sudah ditutup di Tahap 1

| Command | Risiko | Status |
|---|---|---|
| `transfer` / `tf` | Duplikasi uang antar user | ✅ Pakai `transferMoney()` — lock 2 row, FOR UPDATE, sorted lock order |
| `coinflip` / `cf` | Judi 50/50 duplikasi kemenangan | ✅ Pakai `updateMoneyDelta()` — FOR UPDATE |

## Yang rekomendasikan Tahap 1b

**Cluster A (pakai `updateMoneyDelta`):** kasus #1, #3, #5, #11, #12, #13, #14, #15, #16
- Semua pola `cek last_X → +duit`. Tinggal ganti `updateMember({money: newMoney, last_claim: now})` dengan `updateMoneyDelta(botId, sender, +total)` + `updateMember({last_claim: now})` di transaksi yang sama.
- **1 helper `applyMoneyClaim(botId, jid, lastField, delta)`** — kunci row, set last_X = now, update money, commit.

**Cluster B (`slot`, `gacha`):** kasus #8, #9
- Judi random dengan cek duit. Tinggal pakai `updateMoneyDelta(±nominal)` setelah `Math.random()`. Pola sama dengan `coinflip` (yang sudah diperbaiki).

**Cluster C (`bank/atm`, multi-field):** kasus #6, #7, #18
- BUTUH helper baru yang handle 2 field (`money` + `bank_money`). Tidak bisa reuse `updateMoneyDelta`.
- Atau terima risiko rendah (single-user, kerugian max = 1 setor).

**Cluster D (`unreg`):** kasus #21
- Idempotent (reset 2x = sama), tapi ada INSERT ON DUPLICATE. Risiko rendah.

## Estimasi effort

- Cluster A: 9 handler × ~10 baris patch = ~90 baris + 1 helper ~30 baris
- Cluster B: 2 handler × ~15 baris = ~30 baris (re-use pola coinflip)
- Cluster C: 3 handler × ~20 baris = ~60 baris + 1 helper ~40 baris (helper baru)
- Cluster D: 1 handler × ~10 baris = ~10 baris

Total: ~250 baris + 2 helper + 4 tes kontrak = manageable dalam 1 commit besar.

## Rekomendasi urutan eksekusi

1. **Cluster A** (paling rentan duplikasi reward). Pak tidak sebut spesifik, tapi Pak menyebut "slot, gacha, dan klaim daily/hourly/weekly" — semua ada di cluster A & B.
2. **Cluster B** (slot, gacha) — pola identik dengan coinflip, patch minimal.
3. **Cluster C** (bank/atm) — helper baru, scope lebih besar.
4. **Cluster D** (unreg) — opsional, risiko rendah.

Tunggu keputusan Pak sebelum lanjut.
