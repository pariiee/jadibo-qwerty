'use strict';

/**
 * engine/zapo/client.js
 * Adapter zapo-js -> kontrak `client.*` yang dipakai plugins.
 *
 * Kontrak ini SAMA PERSIS dengan kontrak `client.*` yang dipakai plugins.
 * SEMUA beda antar-library mati di file ini; plugins nggak pernah tau engine apa
 * yang jalan. Konsekuensinya: plugin dari `main` bisa dipakai APA ADANYA.
 *
 * Method yang dipakai plugins (hasil scan plugins main+zapo):
 *   message.send x245, message.downloadBytes x51, group.queryGroupMetadata x12,
 *   profile.getProfilePicture x6, message.prepareMedia x5, group.removeParticipants x5,
 *   + ~28 method lain (jarang / opsional pakai `?.`).
 *
 * Setiap panggilan zapo-js di bawah udah diverifikasi ke runtime paket asli —
 * lihat test/zapo-adapter-coverage.js (jaring pengaman kalau zapo naik versi).
 */

const EventEmitter = require('events');
const { proto } = require('zapo-js');

// ─── Helper JID ───────────────────────────────────────────────────────────────

/** Buang device suffix: `628xx:12@s.whatsapp.net` -> `628xx@s.whatsapp.net`. */
function bareJid(jid) {
  if (typeof jid !== 'string') return jid;
  const at = jid.indexOf('@');
  if (at === -1) return jid;
  return jid.slice(0, at).split(':')[0] + jid.slice(at);
}

/** `1234@s.whatsapp.net` -> `1234` (buat mention + nama file). */
const angkaJid = (jid) => String(jid || '').split('@')[0].split(':')[0];

/** `@lid`/`@s.whatsapp.net`/array -> array JID bersih tanpa device suffix. */
const asJids = (v) => (Array.isArray(v) ? v : [v]).filter(Boolean).map(bareJid);

// ─── Hook pesan terkirim (dipakai 02-group.js buat antidelete) ────────────────
// Plugin nggak pernah liat pesan yang DIKIRIM bot lewat jalur pesan masuk, jadi
// adapter nyediain hook ini. Kontraknya:
//   onMessageSent(fn) -> fn(wam) ; balikin fungsi unsubscribe.
const sentHooks = new Set();
function onMessageSent(fn) {
  sentHooks.add(fn);
  return () => sentHooks.delete(fn);
}
function emitSent(wam) {
  for (const fn of sentHooks) {
    try { fn(wam); } catch { /* hook rusak jangan sampai nahan kirim pesan */ }
  }
}

// ─── Normalisasi waktu ────────────────────────────────────────────────────────
// WA kadang kirim timestamp dalam DETIK (~1.7e9) kadang MS (~1.7e12). Engine
// pakai `umurMs` buat buang pesan basi (WA nge-flood ulang pas HP balik online).
function normalisasiPesan(m) {
  const t = Number(m?.messageTimestamp ?? m?.timestamp);
  const tsMs = t ? (t < 1e12 ? t * 1000 : t) : 0;
  return { timestamp: tsMs, umurMs: tsMs ? Date.now() - tsMs : 0 };
}

// ─── Quote cache ──────────────────────────────────────────────────────────────
// zapo ngehapus `quotedMessage` dari contextInfo pas pesan MASUK (deep-clean),
// jadi mau bales quote harus simpan sendiri saat pesannya lewat.
const QUOTE_CACHE = new Map();
const QUOTE_MAX = 300;
function simpanQuote(map, jid, event) {
  const id = event?.id || event?.raw?.key?.id;
  if (!id) return;
  map.set(`${jid}:${id}`, event);
  while (map.size > QUOTE_MAX) map.delete(map.keys().next().value);
}

// ─── Bentuk konten: bahasa plugin (Baileys) -> bahasa zapo ────────────────────

/** Field `Proto.IMessage` yang bikin content dianggap proto mentah siap-kirim. */
const PROTO_KEYS = [
  'conversation', 'extendedTextMessage', 'imageMessage', 'videoMessage',
  'audioMessage', 'documentMessage', 'stickerMessage', 'interactiveMessage',
  'buttonsMessage', 'templateMessage', 'listMessage', 'reactionMessage',
  'protocolMessage', 'eventMessage', 'pollCreationMessageV3',
  'groupStatusMessageV2', 'albumMessage', 'productMessage',
];

const isRawProto = (c) => !!c && typeof c === 'object' && !Buffer.isBuffer(c) && PROTO_KEYS.some((k) => c[k] !== undefined);

/**
 * Zapo ngebuang `mentions` dari OPSI secara diam-diam (sama kayak Baileys v7):
 * harus nempel di kontennya. Call-site tinggal kirim `{ text, mentions }`.
 */
function attachMentions(content, mentions) {
  if (!mentions?.length || !content) return content;
  return { ...content, mentions: mentions.map(angkaJid) };
}

/** Opsi kirim yang artinya "operasi di pesan TERKIRIM", bukan isi pesan baru. */
const OPERASI_TERKIRIM = ['edit', 'delete', 'react', 'messageId', 'editKey'];

/**
 * Plugin kirim content dalam bahasa Baileys (`{ text }`, `{ image, caption }`,
 * `{ document, fileName }`, ...). zapo pakai bahasa sendiri — terjemahin di sini.
 *
 * Yang SENGAJA nggak diterjemahin: `Proto.IMessage` mentah (mis. tombol
 * nativeFlow) — zapo nerima apa adanya, jadi NOL additionalNodes, nol hack
 * relayMessage. Di Baileys ini butuh proto mentah + `<biz>`/`<bot>`; di zapo
 * cukup `message.send`.
 */
function toZapoContent(c) {
  if (c == null) return c;
  if (typeof c === 'string') return c;
  // `{ type: ... }` = bahasa zapo sendiri (media, text, revoke, reaction, pin,
  // poll, ...). Plugin zapo udah nulis persis bentuk ini; diteruskan apa adanya
  // supaya JANGAN ditambah cabang tiap kali zapo nambah jenis pesan baru.
  if (typeof c.type === 'string') return c;
  // Proto.IMessage mentah (mis. tombol nativeFlow) — zapo nerima apa adanya,
  // jadi NOL additionalNodes, nol hack relayMessage.
  if (isRawProto(c)) return c;

  // Sisanya bahasa Baileys lama (`{ text }`, `{ image, caption }`, `{ react }`,
  // `{ delete }`) — dipakai plugin yang belum dipindah ke bahasa zapo.
  // `contextInfo` & `mentions` ikut dibawa: zapo naruh keduanya di KONTEN,
  // bukan di opsi (kalau kelewat, quote/mention/trik fakemsg hilang diam-diam).
  const meta = { ...(c.contextInfo ? { contextInfo: c.contextInfo } : {}), ...(c.mentions ? { mentions: c.mentions } : {}) };
  const bikin = (x) => ({ ...x, ...meta });

  if (typeof c.text === 'string') return bikin({ type: 'text', text: c.text });
  if (c.image)    return bikin({ type: 'image', media: c.image, ...(c.caption != null ? { caption: c.caption } : {}) });
  if (c.video)    return bikin({ type: 'video', media: c.video, ...(c.caption != null ? { caption: c.caption } : {}), ...(c.gifPlayback ? { gifPlayback: true } : {}) });
  if (c.audio)    return bikin({ type: c.ptt ? 'ptt' : 'audio', media: c.audio, ...(c.mimetype ? { mimetype: c.mimetype } : {}) });
  if (c.sticker)  return bikin({ type: 'sticker', media: c.sticker });
  if (c.document) return bikin({ type: 'document', media: c.document, ...(c.fileName ? { fileName: c.fileName } : {}), ...(c.mimetype ? { mimetype: c.mimetype } : {}) });
  if (c.react)    return { type: 'reaction', target: c.react.key || c.react, value: c.react.text ?? c.react.value };
  if (c.delete)   return { type: 'revoke', target: c.delete };
  // Sisa: lempar apa adanya biar zapo yang ngeluh (jangan nelen error diam-diam)
  return c;
}

/** Opsi kirim bahasa Baileys (`{ quoted, mentions, ephemeralExpiration }`) -> zapo. */
function toZapoOptions(opts, ambilQuote) {
  if (!opts) return undefined;
  const o = {};
  if (opts.mentions?.length) o.mentions = opts.mentions.map(angkaJid);
  if (opts.ephemeralExpiration) o.expirationSeconds = opts.ephemeralExpiration;
  if (opts.expirationSeconds) o.expirationSeconds = opts.expirationSeconds;

  // `quoted` di zapo = referensi key; isi pesannya ditaruh di contextInfo
  // (zapo nggak nyimpen pesan lama sendiri).
  const q = opts.quoted || opts.quote;
  if (q) {
    const full = q.message ? q : ambilQuote(q.remoteJid || q.chatJid, q.id);
    if (full?.key?.id || full?.id) {
      o.quote = {
        remoteJid: full.key?.remoteJid || q.remoteJid,
        fromMe: !!(full.key?.fromMe ?? full.fromMe),
        id: full.key?.id || full.id,
        participant: full.key?.participant || full.senderJid || undefined,
      };
      const isi = full.message || full.raw?.message;
      if (isi) o.contextInfo = { quotedMessage: isi };
    }
  }
  return Object.keys(o).length ? o : undefined;
}

// ─── Normalisasi meta grup ────────────────────────────────────────────────────
// Plugin baca `participants[].jid` + `.isAdmin`/`.isSuperAdmin` (warisan Baileys);
// zapo pakai `id` + `isAdmin`/`isSuperAdmin`. Samakan biar engine/jid.js jalan.
function normalizeGroupMeta(meta) {
  if (!meta || !Array.isArray(meta.participants)) return meta;
  meta.participants = meta.participants.map((p) => ({
    ...p,
    jid: p.jid || p.id,
    admin: p.isSuperAdmin ? 'superadmin' : (p.isAdmin ? 'admin' : null),
    isAdmin: p.isAdmin ?? false,
    isSuperAdmin: p.isSuperAdmin ?? false,
  }));
  return meta;
}

// ─── Pesan masuk: event zapo -> bentuk yang dibaca engine/plugins ─────────────
function normalizeIncoming(event) {
  const key = {
    remoteJid: event.chatJid,
    fromMe: !!event.fromMe,
    id: event.id,
    participant: event.senderJid || undefined,
  };
  const { timestamp, umurMs } = normalisasiPesan(event);
  return {
    key,
    message: event.message, // zapo udah nge-unwrap ephemeral/viewOnce
    chatJid: event.chatJid,
    pushName: event.pushName,
    messageStubType: event.messageStubType,
    messageStubParameters: event.messageStubParameters,
    timestamp,
    umurMs,
    msg: event,
    raw: event,
  };
}

// ─── Factory ──────────────────────────────────────────────────────────────────
/**
 * Bungkus `WaClient` zapo jadi kontrak `client.*` yang dipakai plugins.
 *
 * @param {object}   o
 * @param {WaClient} o.client   instance WaClient zapo
 * @param {string}   [o.botJid] identitas bot
 * @param {object}   [o.logger]
 * @returns {{client: object, adapter: object}}
 *   `client`  = yang dikasih ke plugin sebagai `ctx.sock` / `ctx.client`
 *   `adapter` = pegangan internal engine (lihat engine/whatsappEngine.js)
 */
function createClient({ client, botJid = null, logger = console } = {}) {
  if (!client) throw new Error('createClient: `client` (WaClient zapo) wajib diisi');

  const ev = new EventEmitter();
  ev.setMaxListeners(50);

  const quoteCache = new Map();       // `${jid}:${id}` -> event pesan masuk
  const metaCache = new Map();        // groupJid -> meta (TTL pendek)
  const sentCache = new Map();        // messageId -> { message, at }
  const SENT_TTL_MS = 30 * 60 * 1000;
  const SENT_MAX = 2000;
  let identities = {};

  const ambilQuote = (jid, id) => quoteCache.get(`${jid}:${id}`) || null;

  /**
   * Jaring pengaman + pengikat `this` untuk method zapo.
   *
   * `path` bentuknya `client.<ns>.<method>`; `fn` = method yang mau dipanggil.
   * Wajib ada, kalau nggak -> error jelas (bukan "undefined is not a function").
   *
   * `this` diikat ke objek zapo-nya sendiri (`client.message`, `client.group`,
   * ...) — BUKAN ke `client`. Zapo 1.8.2 nulis method-nya sebagai prototype
   * method yang baca field milik instance-nya (`this.messageDispatch`,
   * `this.download`). Kalau fungsinya dilepas dari objeknya, `this` jadi
   * `client` -> `client.messageDispatch` = undefined -> SEMUA command yang
   * kirim pesan mati ("Cannot read properties of undefined"). Di 1.9.0 ini
   * ketutup karena method-nya jadi arrow, tapi 1.8.2 tidak — dan kita pin
   * 1.8.2, jadi ikatannya jangan dilepas.
   */
  const need = (path, fn) => {
    if (typeof fn !== 'function') throw new Error(`zapo-js tidak punya \`${path}\` — versi paket berubah?`);
    const segs = path.split('.');
    segs.pop();                              // buang nama method-nya
    if (segs[0] === 'client') segs.shift();  // buang akar `client` — sisanya jalur di dalam client
    let base = client;
    for (const seg of segs) base = base?.[seg];
    return (...args) => fn.apply(base, args);
  };

  // ── Normalisasi hasil aksi grup ─────────────────────────────────────────────
  // Plugin cek `status === 'ok'` + `r.code` (warisan Baileys). zapo balikin
  // `{ jid, success }` — tanpa normalisasi ini aksi SUKSES dilaporin gagal.
  const normHasil = (res, jids) => {
    const arr = Array.isArray(res) ? res : [];
    if (!arr.length) return jids.map((jid) => ({ jid, status: 'ok', code: 200 }));
    return arr.map((r) => {
      const ok = r?.success !== false && !r?.errorCode;
      return { jid: r?.jid || r?.phoneJid || r?.lidJid, status: ok ? 'ok' : 'error', code: ok ? 200 : (Number(r?.errorCode) || 400) };
    });
  };

  // ── Pesan ───────────────────────────────────────────────────────────────────
  const message = {
    /**
     * `send(jid, content, opts)` — `content` boleh bahasa Baileys (`{text}`,
     * `{image,caption}`) ATAU `Proto.IMessage` mentah (tombol nativeFlow).
     * Balikin WAMessage-like: `{ key: { id, remoteJid, fromMe } }`.
     */
    async send(jid, content, opts = {}) {
      const t0 = Date.now();
      // `mentions` boleh datang dari konten (`send(jid, { text, mentions })`) atau
      // dari opsi — zapo cuma baca yang di OPSI, jadi satukan dulu.
      const daftarMention = opts?.mentions?.length ? opts.mentions : content?.mentions;
      const withMentions = attachMentions(content, daftarMention);
      const body = toZapoContent(withMentions);
      const o = { ...toZapoOptions({ ...opts, mentions: daftarMention }, ambilQuote) };
      // `edit` gaya Baileys cuma FLAG ("ini edit") — targetnya ditentukan oleh
      // `messageId` (Baileys kirim stanza ber-id sama + attr edit=1). zapo minta
      // targetnya eksplisit di `editKey`, jadi ambil dari situ.
      if (content?.edit) o.editKey = { id: opts.messageId || content.edit?.id || content.edit?.key?.id };
      if (opts.messageId) o.id = opts.messageId;
      const res = await need('client.message.send', client.message?.send)(bareJid(jid), body, Object.keys(o).length ? o : undefined);
      const wam = {
        key: {
          id: res?.id || res?.key?.id,
          remoteJid: res?.key?.remoteJid || bareJid(jid),
          fromMe: res?.key?.fromMe ?? true,
          participant: res?.key?.participant,
        },
        message: withMentions,
        messageTimestamp: res?.timestamp || Math.floor(Date.now() / 1000),
      };
      message.rememberSent(wam);
      emitSent(wam); // 02-group.js (antidelete) nunggu ini
      logger.debug?.(`[zapo] send ${bareJid(jid)} ${Date.now() - t0}ms`);
      return wam;
    },

    /** Proto mentah: di Baileys perlu relayMessage + additionalNodes, di zapo send() biasa. */
    async sendRaw(jid, protoContent, opts = {}) {
      return message.send(jid, toZapoContent(protoContent), opts);
    },

    /**
     * Pesan berlabel "AI" (node `<bot biz_bot="1"/>` di Baileys). zapo bikin
     * labelnya dari `messageContextInfo.supportPayload` -> cukup set di content.
     */
    async sendAi(jid, text, opts = {}) {
      const secret = require('crypto').randomBytes(32);
      const supportPayload = Buffer.from(JSON.stringify({
        version: 1, is_ai_message: true, should_show_system_message: true,
        ticket_id: '1669945700536053',
      })).toString('base64');
      return message.send(jid, {
        extendedTextMessage: { text },
        messageContextInfo: { messageSecret: secret, supportPayload },
      }, opts);
    },

    /**
     * Tandai pesan masuk sebagai sudah dibaca (centang biru).
     * Dua bentuk dipakai di repo: `read(keys)` dan `read(jid, keys)`.
     */
    async read(a, b) {
      const keys = Array.isArray(a) || (a && typeof a === 'object' && a.id) ? a : b;
      const jidDefault = typeof a === 'string' ? a : null;
      const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean).map((k) => ({
        remoteJid: k.remoteJid || jidDefault,
        id: k.id, fromMe: !!k.fromMe, participant: k.participant,
      }));
      if (!list.length) return;
      return need('client.message.sendReceipt', client.message?.sendReceipt)(list, 'read');
    },

    /**
     * Bales pesan (shortcut): `reply(jid, quotedMsg, content, opts)`.
     * Zapo: quoted cukup `{ quote, contextInfo.quotedMessage }`; nativeFlowMessage
     * di content diteruskan APA ADANYA (pelajaran 05f10c9 — jangan pernah dibuang).
     */
    async reply(jid, quoted, content, opts = {}) {
      const isi = quoted?.message || quoted?.raw?.message;
      const key = quoted?.key || quoted?.raw?.key;
      return message.send(jid, content, {
        ...opts,
        quoted: key?.id ? { key, message: isi } : opts.quoted,
      });
    },

    /** Sudah dibaca/dibalas oleh engine lain — cache buat lookup quote. */
    rememberSent(wam) {
      const id = wam?.key?.id;
      if (!id) return;
      sentCache.set(id, { message: wam.message, at: Date.now() });
      while (sentCache.size > SENT_MAX) sentCache.delete(sentCache.keys().next().value);
    },

    lookupSent(key) {
      const id = typeof key === 'string' ? key : key?.id;
      const rec = id ? sentCache.get(id) : null;
      if (!rec || Date.now() - rec.at > SENT_TTL_MS) return null;
      return rec.message;
    },

    /**
     * Buang bungkus view-once/ephemeral/documentWithCaption (plugin nggak
     * pernah liat bungkusnya). zapo udah unwrap, tapi pesan lama/quoted bisa
     * masih kebungkus -> tetap dirapikan.
     */
    unwrapMessage(m) {
      const WRAP = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'ephemeralMessage', 'documentWithCaptionMessage'];
      let inner = m;
      for (let i = 0; i < 5 && inner; i++) {
        const k = Object.keys(inner).find((x) => WRAP.includes(x));
        if (!k || !inner[k]?.message) break;
        inner = inner[k].message;
      }
      return inner;
    },

    /** Unduh media pesan -> Buffer. Engine/plugin butuh Buffer, zapo kasih Uint8Array. */
    async downloadBytes(msg) {
      const src = msg?.raw || msg?.msg || msg;
      const out = await need('client.message.downloadBytes', client.message?.downloadBytes)(src);
      return out ? Buffer.from(out) : out;
    },

    /**
     * Upload media jadi PROTO (bukan Buffer). Dipakai header pesan tombol
     * (InteractiveMessage.Header butuh proto IDocumentMessage) & status grup.
     * zapo: `message.upload` balikin proto siap-pakai.
     */
    async prepareMedia(buffer, mimetype = 'image/jpeg') {
      const kind = String(mimetype).startsWith('image/') ? 'image'
        : String(mimetype).startsWith('video/') ? 'video'
        : String(mimetype).startsWith('audio/') ? 'audio'
        : 'document';
      const up = await need('client.message.upload', client.message?.upload)(buffer, { type: kind, mimetype });
      return { [`${kind}Message`]: up };
    },

    /** Sama seperti prepareMedia, tapi dibungkus sebagai document (buat header tombol). */
    async prepareDocument(buffer, mimetype = 'application/pdf', fileName = 'file') {
      const up = await need('client.message.upload', client.message?.upload)(buffer, { type: 'document', mimetype, fileName });
      return { documentMessage: up };
    },

    /**
     * Status grup (`.swgc`) — di zapo coordinator `status` resmi. Nama & posisi
     * method sengaja BEDA dari API asli (`message.relayStatusGrup`) supaya
     * plugins/02-group.js nggak perlu diubah.
     */
    async relayStatusGrup(jid, content, opts = {}) {
      const recipients = (opts.recipients?.length ? opts.recipients : (Array.isArray(jid) ? jid : [jid])).map(bareJid);
      return need('client.status.send', client.status?.send)({
        recipients,
        content: toZapoContent(content),
        ...(opts.contextInfo ? { contextInfo: opts.contextInfo } : {}),
      });
    },
  };

  // ── Grup ────────────────────────────────────────────────────────────────────
  const grupKey = (item) => item?.groupJid || item?.jid || item;
  const perluRefreshMeta = new Set();

  const group = {
    async queryGroupMetadata(jid) {
      jid = bareJid(jid);
      if (metaCache.has(jid)) return metaCache.get(jid);
      const meta = await need('client.group.queryGroupMetadata', client.group?.queryGroupMetadata)(jid);
      const norm = normalizeGroupMeta(meta);
      metaCache.set(jid, norm);
      setTimeout(() => metaCache.delete(jid), 60_000).unref?.();
      return norm;
    },

    async queryAllGroups() {
      return need('client.group.queryAllGroups', client.group?.queryAllGroups)();
    },

    async queryInviteCode(jid) {
      return need('client.group.queryInviteCode', client.group?.queryInviteCode)(grupKey(jid));
    },

    async joinGroupViaInvite(code) {
      return need('client.group.joinGroupViaInvite', client.group?.joinGroupViaInvite)(code);
    },

    async leaveGroup(jid) {
      metaCache.delete(bareJid(grupKey(jid)));
      return need('client.group.leaveGroup', client.group?.leaveGroup)(grupKey(jid));
    },

    // Aksi peserta: zapo `(groupJid, participantJids[])` -> hasil `{success}`
    // dinormalisasi ke `{status:'ok', code:200}` yang dicek plugin.
    async addParticipants(jid, jids) {
      const g = grupKey(jid), list = asJids(jids);
      const res = await need('client.group.addParticipants', client.group?.addParticipants)(g, list);
      perluRefreshMeta.add(bareJid(g));
      return normHasil(res, list);
    },

    async removeParticipants(jid, jids) {
      const g = grupKey(jid), list = asJids(jids);
      const res = await need('client.group.removeParticipants', client.group?.removeParticipants)(g, list);
      perluRefreshMeta.add(bareJid(g));
      return normHasil(res, list);
    },

    async promoteParticipants(jid, jids) {
      const g = grupKey(jid), list = asJids(jids);
      const res = await need('client.group.promoteParticipants', client.group?.promoteParticipants)(g, list);
      perluRefreshMeta.add(bareJid(g));
      return normHasil(res, list);
    },

    async demoteParticipants(jid, jids) {
      const g = grupKey(jid), list = asJids(jids);
      const res = await need('client.group.demoteParticipants', client.group?.demoteParticipants)(g, list);
      perluRefreshMeta.add(bareJid(g));
      return normHasil(res, list);
    },

    async rejectParticipants(jid, jids, opts = {}) {
      const g = grupKey(jid), list = asJids(jids);
      return need('client.group.rejectMembershipRequests', client.group?.rejectMembershipRequests)(g, list, opts);
    },

    async approveParticipants(jid, jids, opts = {}) {
      const g = grupKey(jid), list = asJids(jids);
      return need('client.group.approveMembershipRequests', client.group?.approveMembershipRequests)(g, list, opts);
    },

    /** Alias gaya zapo asli — engine lama manggil nama ini langsung. */
    async approveMembershipRequests(jid, jids, opts = {}) {
      const g = grupKey(jid), list = asJids(jids);
      return need('client.group.approveMembershipRequests', client.group?.approveMembershipRequests)(g, list, opts);
    },

    async rejectMembershipRequests(jid, jids, opts = {}) {
      const g = grupKey(jid), list = asJids(jids);
      return need('client.group.rejectMembershipRequests', client.group?.rejectMembershipRequests)(g, list, opts);
    },

    /** `setSetting(jid, 'announcement'|'locked'|'open', true)` — nama setting zapo. */
    async setSetting(jid, setting, value) {
      metaCache.delete(bareJid(grupKey(jid)));
      return need('client.group.setSetting', client.group?.setSetting)(grupKey(jid), setting, value);
    },

    async setSubject(jid, subject) {
      metaCache.delete(bareJid(grupKey(jid)));
      return need('client.group.setSubject', client.group?.setSubject)(grupKey(jid), subject);
    },

    async setDescription(jid, desc) {
      metaCache.delete(bareJid(grupKey(jid)));
      return need('client.group.setDescription', client.group?.setDescription)(grupKey(jid), desc);
    },

    /** Dipanggil engine setelah aksi grup -> meta berikutnya dibaca ulang. */
    invalidate(jid) {
      const g = bareJid(jid);
      metaCache.delete(g);
      perluRefreshMeta.delete(g);
    },
  };

  // ── Profil ──────────────────────────────────────────────────────────────────
  const profile = {
    /**
     * Balikin URL string (atau null) — BUKAN `{ url }`. Call-site lama baca
     * `pp?.url`; di Baileys itu bikin PP selalu jatuh ke default padahal grup
     * punya PP. Normalisasi di adapter, bukan di tiap call-site.
     */
    async getProfilePicture(jid) {
      try {
        const raw = await need('client.profile.getProfilePicture', client.profile?.getProfilePicture)(bareJid(jid));
        if (typeof raw === 'string') return raw || null;
        return raw?.url || null;
      } catch {
        return null; // user nol PP / privasi -> bukan error
      }
    },

    async setProfilePicture(jid, buffer) {
      return need('client.profile.setProfilePicture', client.profile?.setProfilePicture)(bareJid(jid), buffer);
    },

    async setStatus(text) {
      return need('client.profile.setStatus', client.profile?.setStatus)(text);
    },
  };

  // ── Privasi / bisnis / newsletter ───────────────────────────────────────────
  const privacy = {
    async blockUser(jid)   { return need('client.privacy.blockUser',   client.privacy?.blockUser)(bareJid(jid)); },
    async unblockUser(jid) { return need('client.privacy.unblockUser', client.privacy?.unblockUser)(bareJid(jid)); },
  };

  const business = {
    // zapo ambil ARRAY jid -> balikin array hasil; buka bungkusnya kalau cuma 1.
    async getBusinessProfile(jid) {
      const out = await need('client.business.getBusinessProfile', client.business?.getBusinessProfile)([bareJid(jid)]);
      return Array.isArray(out) && out.length === 1 ? out[0] : out;
    },
    async getVerifiedName(jid) {
      return need('client.business.getVerifiedName', client.business?.getVerifiedName)(bareJid(jid));
    },
  };

  const newsletter = {
    async follow(jid) { return need('client.newsletter.follow', client.newsletter?.follow)(bareJid(jid)); },
  };

  // ── Status grup (`.swgc`) ───────────────────────────────────────────────────
  // Baileys: proto groupStatusMessageV2 + messageSecret + additionalNodes.
  // zapo: coordinator `status` resmi (target = JID GRUP, bukan JID status).
  const status = {
    async send(jid, content, opts = {}) {
      const body = toZapoContent(content);
      const recipients = (opts.recipients?.length ? opts.recipients : [bareJid(jid)]).map(bareJid);
      return need('client.status.send', client.status?.send)({ recipients, content: body, ...(opts.contextInfo ? { contextInfo: opts.contextInfo } : {}) });
    },

    /** Kompat lama: `relayStatusGrup(jid, content, opts)`. */
    async relayStatusGrup(jid, content, opts = {}) {
      return status.send(jid, content, {
        ...opts,
        recipients: opts.recipients?.length ? opts.recipients : (Array.isArray(jid) ? jid : [jid]),
      });
    },
  };

  // ── Contacts (buat resolusi LID <-> nomor di engine/jid.js) ─────────────────
  // zapo naruh kontak di bawah `client.stores`, engine/jid.js baca
  // `client.stores.contacts.*` -> bentuk ini yang dipakai, nol translasi.
  const stores = {
    contacts: {
      async getByJid(jid) {
        try { return await need('client.stores.contacts.getByJid', client.stores?.contacts?.getByJid)(bareJid(jid)); }
        catch { return null; }
      },
      async getByPhoneNumber(num) {
        try { return await need('client.stores.contacts.getByPhoneNumber', client.stores?.contacts?.getByPhoneNumber)(angkaJid(num)); }
        catch { return null; }
      },
    },
  };

  // ── Identitas / auth ────────────────────────────────────────────────────────
  const auth = {
    async requestPairingCode(phone, custom = null) {
      // CATATAN: zapo param ke-2 = BOOLEAN (shouldShowPushNotification), BEDA
      // dari Baileys yang param ke-2 = customCode. Call-site Baileys kirim
      // string -> diterjemahin ke param ke-3.
      const fn = need('client.auth.requestPairingCode', client.auth?.requestPairingCode);
      return typeof custom === 'string'
        ? fn(String(phone).replace(/\D/g, ''), undefined, custom)
        : fn(String(phone).replace(/\D/g, ''), !!custom);
    },

    /** Credentials aktif (creds + me) buat cek identitas bot. */
    getCurrentCredentials() {
      try { return client.getCredentials?.() || identities; } catch { return identities; }
    },

    isConnected() {
      try {
        const s = client.getState?.();
        return s === 'connected' || s === 'open';
      } catch { return false; }
    },

    /** Nomor bot sendiri (PN) — dipakai guard "jangan balas diri sendiri". */
    get meJid() { return botJid; },
  };

  const lid = {
    getPn:  (jid) => jid,
    getLid: (jid) => jid,
  };

  // ── Rakit kontrak ───────────────────────────────────────────────────────────
  const api = {
    // State mentah & event emitter (biar engine bisa pasang handler)
    raw: client,
    ev,
    on:   (...a) => ev.on(...a),
    once: (...a) => ev.once(...a),
    off:  (...a) => ev.off(...a),
    emit: (...a) => ev.emit(...a),

    message, group, profile, privacy, business, newsletter, status, stores, auth, lid,

    /** Dipakai engine buat jalanin connect() miliknya sendiri. */
    connect:      (...a) => client.connect(...a),
    disconnect:   (...a) => client.disconnect(...a),
    logout:       (...a) => client.logout(...a),
    isConnected:  (...a) => auth.isConnected(...a),
  };

  // ── Jembatan event zapo -> event gaya Baileys yang ditunggu engine ─────────
  /**
   * zapo ngasih `client.on('message', ev)`. Engine/plugin nunggu:
   *   'messages.upsert'  { messages: [wam] }
   *   'group-participants.update'  { id, action, participants, author }
   *   'connection.update' { connection: 'open'|'close' }
   *   'creds.update'
   */
  function bridgeEvents() {
    const onMsg = (rawEv) => {
      let ev2;
      try { ev2 = normalizeIncoming(rawEv); } catch (e) { logger.warn?.('[zapo] normalize pesan gagal:', e.message); return; }
      // simpan buat quote: plugin sering balas pesan yang baru masuk
      simpanQuote(quoteCache, ev2.chatJid, rawEv);
      ev.emit('messages.upsert', { messages: [ev2], type: 'notify' });
    };

    need('client.on', client.on).call(client, 'message', onMsg);

    client.on('group', (g) => {
      const n = normalisasiGroup(g);
      if (!n) return;
      if (n.action === 'add' || n.action === 'remove') group.invalidate(n.groupJid);
      ev.emit('group-participants.update', {
        id: n.groupJid,
        author: n.author,
        participants: n.participants,
        action: n.action,
      });
    });

    client.on('connection', (c) => {
      const state = typeof c === 'string' ? c : (c?.state || c?.connection);
      ev.emit('connection.update', {
        connection: state === 'open' || state === 'connected' ? 'open' : state,
        isNewLogin: false,
        lastDisconnect: state === 'close' || state === 'closed' ? { error: c?.error, date: new Date() } : undefined,
      });
    });

    for (const e of ['creds.update', 'auth_paired']) {
      client.on?.(e, (payload) => {
        if (e === 'auth_paired') identities = payload?.credentials || payload || {};
        ev.emit('creds.update', payload);
      });
    }
    // Pairing: engine nunggu nama event Baileys -> diteruskan apa adanya
    for (const e of ['auth_qr', 'auth_pairing_code', 'auth_pairing_required', 'auth_passkey_required']) {
      client.on?.(e, (p) => ev.emit(e, p));
    }
  }

  // Aksi `client.group` zapo -> bentuk group-participants.update Baileys
  function normalisasiGroup(g) {
    const aksi = g?.action || g?.type;
    const action = aksi === 'add' ? 'add'
      : aksi === 'remove' || aksi === 'leave' ? 'remove'
      : aksi === 'request' || aksi === 'membership_request' ? 'request'
      : null;
    if (!action) return null;
    const kolom = (arr) => (arr || []).map((p) => p.jid || p.lidJid || p.phoneJid).filter(Boolean).map(bareJid);
    const grup = g.groupJid || g.chatJid;
    return {
      groupJid: grup, action,
      author: g.authorJid || null,
      participants: action === 'request'
        ? [...kolom(g.participants), ...kolom(g.membershipRequests)]
        : kolom(g.participants),
    };
  }

  bridgeEvents();

  return { client: api, adapter: { metaCache, quoteCache, sentCache } };
}

module.exports = {
  createClient,
  // Dipakai plugins (kontrak `client.*`)
  onMessageSent,
  // Node `<bot>`/`<biz>` — dipakai Baileys buat nandain jalur bot. Di zapo label
  // AI datang dari `messageContextInfo.supportPayload`, jadi ini cuma biar
  // `require` di plugins/05-owner.js (command debug `.testai`) nggak meledak.
  AI_NODES: [{ attrs: { biz_bot: '1' }, tag: 'bot' }, { attrs: {}, tag: 'biz' }],
  BIZ_NODE: [{ attrs: {}, tag: 'biz' }],
  // Utility yang dipakai engine & tes (jangan dihapus — kontrak internal)
  bareJid, angkaJid, asJids, normalisasiPesan, normalizeIncoming,
  normalizeGroupMeta, toZapoContent, toZapoOptions, isRawProto,
};
