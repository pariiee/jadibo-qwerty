# Baileys v7 — Peta Migrasi (TERVERIFIKASI dari baileys@7.0.0-rc14)

> Angka = dari repo ini, dihitung ulang. Semua klaim API dicek ke
> `node_modules/baileys/lib/**/*.d.ts` paket asli, bukan asumsi/ingatan.

## Ringkas ongkos

| Area | Jumlah |
|---|---|
| File yg nyentuh zapo | 9 (`engine/whatsappEngine.js`, `plugins/01-info`, `02-group`, `05-owner`, `06-proteksi`, `07-button`, `08-didyoumean`, `09-jarvis`) |
| Panggilan `client.*` | ~770 |
| Method unik `client.*` | **27** (peta di bawah) |
| `client.message.send()` | 249 |
| `zapo-js` di-`require` | 12 titik |
| Plugin yg nyentuh DB | 0 dari 15 |
| Wajib Node | **>= 20** (sekarang lokal 22, VPS belum dicek) |

## 27 method → padanan Baileys v7

| zapo | Baileys v7 | Catatan |
|---|---|---|
| `message.send(jid, {text})` | `sendMessage(jid, {text})` | |
| `message.send(jid, {type:'image',media,mimetype,caption})` | `sendMessage(jid, {image:media, caption})` | `type` dibuang |
| `type:'video'/'audio'/'document'/'sticker'` | `{video}`/`{audio}`/`{document}`/`{sticker}` | key = tipenya |
| `message.send(jid, teks, {mentions})` | `sendMessage(jid, {text, mentions})` | posisi argumen ke-3 pindah ke objek |
| `message.downloadBytes` | `downloadMediaMessage` | signature BEDA, lihat bawah |
| `message.upload` | `sock.waUploadToServer` | |
| `group.getMetadata` | `groupMetadata` | `participants[].id` (bukan `.jid`) |
| `group.leaveGroup([j])` | `groupLeave(j)` | |
| `group.add/remove/promote/demote` | `groupParticipantsUpdate(j, ps, 'add'\|'remove'\|'promote'\|'demote')` | |
| `group.getInviteCode` | `groupInviteCode` | |
| `group.revokeInvite` | `groupRevokeInvite` | |
| `group.acceptInvite` | `groupAcceptInvite` | |
| `group.setSubject` | `groupUpdateSubject` | |
| `group.setDescription` | `groupUpdateDescription` | |
| `group.setSetting` | `groupSettingUpdate` | |
| `group.approveMembershipRequests` | `groupRequestParticipantsUpdate(j, ps, 'approve')` | |
| `group.participating` | `groupFetchAllParticipating()` | return **object**, bukan array |
| `privacy.blockUser` | `updateBlockStatus(j, 'block'\|'unblock')` | |
| `business.getVerifiedName` | `getBusinessProfile(jid)` | ada, tapi bentuk hasil beda |
| `business.getBusinessProfile` | `getBusinessProfile(jid)` | |
| `newsletter.follow` | `newsletterFollow(j)` | |
| `stores.contacts.*` | `sock.store.contacts` / `makeCacheableSignalKeyStore` | dipakai `engine/jid.js` |
| `message.reply` | `sendMessage(j, {...}, {quoted: msg})` | |
| dst. | | |

## TIGA hal yg WAJIB diadaptasi (bukan sekadar rename)

1. **TOMBOL/PROTO MENTAH — `sendMessage` NOLAK.** Terbukti:
   - `interactiveMessage` langsung → `Invalid media type`
   - `buttons`/`sections`/`templateButtons` → **lolos tapi tombolnya DIBUANG diam-diam**
   - Baileys v7 **nggak punya API tombol sama sekali** (0 hit di `Types/Message.d.ts`)
   - **Satu-satunya jalur:** `sock.relayMessage(jid, protoMessage, { messageId })`
   - = 1 helper internal; semua plugin tetap panggil `client.message.send` bentuk lama.

2. **`downloadMediaMessage` signature beda.**
   - zapo: `downloadMediaMessage(msg)` → Buffer
   - Baileys: `downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })`
   - Fix: bikin pembungkus di engine, plugin di-rewrite panggilnya.

3. **Group participant: `p.jid` → `p.id`.** Baileys `Contact = { id, lid?, phoneNumber? }`.
   `engine/jid.js` sudah toleran (baca `phoneNumber`), tinggal sesuaikan `p.id`.

## YANG HILANG PERMANEN di Baileys (jujur, bukan bisa diakalin)

- **Badge verified** (`<biz>` companion) — zapo nempelin ini otomatis; Baileys nggak punya.
- **"permintaan berhasil / lihat detail"** ikut hilang (efek samping yg sama).

## TERVERIFIKASI ADA (jadi nggak ada yg perlu dikorbankan)

`makeWASocket`, `useMultiFileAuthState` ATAU SQLite sendiri via `initAuthCreds`+
`BufferJSON`, `sendMessage`, `relayMessage`, `groupMetadata`, 13 method grup,
`getBusinessProfile`, `newsletterFollow`, `groupFetchAllParticipating`,
`downloadMediaMessage`, `jidNormalizedUser`, `isJidGroup`, `makeCacheableSignalKeyStore`,
`fetchLatestBaileysVersion`, `Browsers`, `DisconnectReason`, `proto`.

## Auth di SQLite — SUDAH DITES & HIJAU (9/9, `_b2.js`)

`makeWASocket({ auth: { creds, keys: makeCacheableSignalKeyStore(keys, logger) } })`
dgn `keys = { get, set }` baca/tulis JSON di `better-sqlite3`. Persist lintas restart OK.
→ `sessions/bot_<id>/session.db` **tidak perlu dihapus**; cukup tabel `auth` baru
(dibuat otomatis `CREATE TABLE IF NOT EXISTS`), jadi sesi lama nggak rusak.

## Bukti jalan

- `_b2.js` — auth SQLite + `initAuthCreds` + round-trip creds/keys. **9/9 hijau.**
- `_b5.js` — `relayMessage` proto mentah 8/8, `locationMessage` +
  `jpegThumbnail` (Buffer→base64) & `buttonsMessage` build OK. **8/8 hijau.**
