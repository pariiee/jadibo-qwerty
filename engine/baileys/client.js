'use strict';

/**
 * engine/baileys/client.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Adapter Baileys v7 yang mempertahankan wajah client lama (call-site repo nggak disentuh).
 *
 * KENAPA ADAPTER, BUKAN PORT ULANG:
 *   Repo ini punya ~770 panggilan `client.*` di 9 file, tapi cuma 27 method
 *   unik. Menulis ulang 770 titik = risiko typo 770 kali; menulis 1 adapter =
 *   risiko di 1 file, dan plugin/engine nggak perlu disentuh.
 *
 * YANG TIDAK BISA DIPETAKAN (sudah diuji):
 *   Baileys v7 NGGAK PUNYA API tombol. `sendMessage` nolak `interactiveMessage`
 *   ("Invalid media type") dan membuang `buttons`/`sections` diam-diam.
 *   Satu-satunya jalur = relayMessage + proto mentah → lihat sendRaw().
 *
 * Pemakaian:
 *   const client = createClient({ auth, logger, saveCreds, pairingMode });
 *   client.on('message', ...); await client.connect();
 */

const EventEmitter = require('events');
const { randomBytes } = require('crypto');
const {
  makeWASocket,
  makeCacheableSignalKeyStore,
  downloadMediaMessage: baileysDownload,
  jidNormalizedUser,
  DisconnectReason,
  generateWAMessageFromContent,
  normalizeMessageContent,
  prepareWAMessageMedia,
  isJidGroup,
  proto,
  Browsers,
} = require('baileys');
const { mentionsForChat, cacheLidFromMeta, cacheLidFromKey } = require('../jid');

// Tipe pesan yang `sendMessage` nolak ("Invalid media type") tapi WA biasa
// nampilin — semua di sini dikirim lewat relayMessage (.owner kirim kontak).
const RELAY_ONLY_KEYS = [
  'contactMessage', 'contactsArrayMessage',
  'locationMessage', 'liveLocationMessage',
  'eventMessage', 'pollCreationMessageV3', 'requestPhoneNumberMessage',
  'productMessage', 'orderMessage', 'albumMessage',
];

// Key proto mentah yg HARUS lewat relayMessage (sendMessage nolak ini).
const RAW_PROTO_KEYS = [
  'interactiveMessage', 'buttonsMessage', 'templateMessage', 'listMessage',
  'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
  'albumMessage', 'productMessage', 'orderMessage', 'eventMessage',
  'pollCreationMessageV3', 'requestPhoneNumberMessage', 'stickerPackMessage',
  'buttonsResponseMessage', 'listResponseMessage', 'highlyStructuredMessage',
  ...RELAY_ONLY_KEYS,
];

const isRawProto = (c) =>
  !!c && typeof c === 'object' && RAW_PROTO_KEYS.some((k) => c[k] !== undefined);

// ── Pesan berlabel "AI" ──────────────────────────────────────────────────────
// Label AI di bubble cuma nongol kalau pesannya bawa `messageContextInfo`:
// `messageSecret` (32 byte acak) + `supportPayload` is_ai_message, DAN node
// `<bot biz_bot="1"/><biz/>`. Baileys nggak punya API-nya — sama kayak tombol,
// jalurnya relayMessage + proto mentah. Dipisah dari sendRaw() karena node-nya
// beda: sendRaw nempelin node tombol, ini nempelin node bot/biz.
const AI_TICKET_ID = '1669945700536053';
const AI_NODES = [
  { attrs: { biz_bot: '1' }, tag: 'bot' },
  { attrs: {}, tag: 'biz' },
];
// Di GRUP client resmi cuma nempelin `<biz/>` — node `<bot>` itu urusan chat
// pribadi (aturan yang sama dipakai jalur tombol di sendRaw()).
// ponytail: DI GRUP LABEL AI NGGAK MUNCUL, apa pun node-nya — dites di grup
// nyata: varian `bot+biz` / `biz` / tanpa node, ketiganya polos. Kalau WA
// ngasih varian grup, ganti isi BIZ_NODE (atau tambah cabangnya di sini);
// sisanya nggak perlu diubah.
const BIZ_NODE = [{ attrs: {}, tag: 'biz' }];
function aiNodesFor(jid) {
  return isJidGroup(jid) ? BIZ_NODE : AI_NODES;
}
function aiContent(text) {
  return {
    conversation: String(text),
    messageContextInfo: {
      // Wajib ada isinya (32 byte) walau WA nggak ngecek nilainya — tanpa ini
      // supportPayload-nya diabaikan dan labelnya nggak muncul.
      messageSecret: randomBytes(32),
      supportPayload: JSON.stringify({
        version: 1,
        is_ai_message: true,
        should_show_system_message: true,
        ticket_id: AI_TICKET_ID,
      }),
    },
  };
}

// Media view-once & pesan yang hilang datanya dibungkus dalam `.message` lagi.
// `msgType` jadi 'viewOnceMessageV2' -> cabang media di plugin nggak kena, dan
// yang kekirim cuma teks "⚠️ Medianya udah nggak bisa diunduh". Engine yang
// membuka bungkusnya, jadi SEMUA plugin dapat bentuk yang sama.
const WRAPPER_KEYS = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'ephemeralMessage', 'documentWithCaptionMessage'];
function unwrapMessage(message) {
  let inner = message;
  for (let i = 0; i < 5 && inner; i++) {
    // Media view-once: isi aslinya di .viewOnceMessage(V2...).message
    const wrapKey = Object.keys(inner).find((k) => WRAPPER_KEYS.includes(k));
    if (wrapKey && inner[wrapKey]?.message) { inner = inner[wrapKey].message; continue; }
    // documentWithCaption: isi aslinya di .documentWithCaptionMessage.message.documentMessage.{message,caption}
    if (inner.documentWithCaptionMessage?.message?.documentMessage) {
      inner = inner.documentWithCaptionMessage.message.documentMessage.message || inner.documentWithCaptionMessage.message;
      continue;
    }
    break;
  }
  return inner ?? message;
}

// ── Ingat pesan yg KITA kirim, buat jawab retry receipt ──────────────────────
// Penerima yg gagal decrypt minta kirim ulang; Baileys jawab pakai
// `getMessage(key)`. Kita dulu jawab `undefined` -> permintaan itu di-drop
// senyap: log bot bilang "terkirim", HP penerima nggak nampilin apa-apa.
// (Cache internal `messageRetryManager` ada di messages-recv.js:23 tapi
//  NGGAK PERNAH di-assign di v7 rc14 -> satu-satunya jalan ya getMessage ini.)
// Key cuma pakai message id: id-nya kita yg bikin & unik, jadi nggak kena
// masalah LID vs nomor (remoteJid di receipt bisa beda bentuk dari yg kita pakai).
// ponytail: Map + TTL, bukan store di disk — cukup, retry datang dalam detik.
const SENT_TTL_MS = 10 * 60 * 1000;
const SENT_MAX = 300;
const sentMessages = new Map(); // messageId -> { message, at }
// Hook buat plugin yg mau ikut nyimpen pesan keluar (antidelete di 02-group.js).
const sentHooks = new Set();
const onMessageSent = (fn) => { sentHooks.add(fn); return () => sentHooks.delete(fn); };

function rememberSent(wam) {
  const id = wam?.key?.id;
  if (!id || !wam.message) return;
  const now = Date.now();
  for (const [k, v] of sentMessages) if (now - v.at > SENT_TTL_MS) sentMessages.delete(k);
  while (sentMessages.size >= SENT_MAX) sentMessages.delete(sentMessages.keys().next().value);
  sentMessages.set(id, { message: wam.message, at: now });
  // Pesan yang kita kirim juga bahan antidelete: justru balasan bot yang
  // paling sering dihapus orang, dan itu nggak pernah lewat jalur pesan masuk.
  for (const fn of sentHooks) { try { fn(wam); } catch (e) { logger?.error?.(`sentHook: ${e.message}`); } }
}

function lookupSent(key) {
  const rec = key?.id && sentMessages.get(key.id);
  if (!rec) return undefined;
  if (Date.now() - rec.at > SENT_TTL_MS) { sentMessages.delete(key.id); return undefined; }
  return rec.message;
}

// ── Node biner yg bikin tombol beneran ke-render ─────────────────────────────
// WA nggak baca tombol cuma dari proto-nya: client resmi juga nempelin node
// `<biz><interactive type="native_flow"><native_flow/></interactive></biz>`
// (+ `<bot biz_bot="1"/>` di chat pribadi). Tanpa ini WA nampilin teks polos.
// Diambil dari struktur yg dipakai client resmi (lihat gifted-btns / itsukichan).
function buttonNodes(normalized) {
  const nm = normalized?.interactiveMessage?.nativeFlowMessage;
  const bm = normalized?.buttonsMessage;
  if (nm || bm) {
    return [
      {
        tag: 'biz',
        attrs: {},
        content: [
          {
            tag: 'interactive',
            attrs: { type: 'native_flow', v: '1' },
            content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }],
          },
        ],
      },
    ];
  }
  if (normalized?.listMessage) {
    return [
      {
        tag: 'biz',
        attrs: {},
        content: [{ tag: 'list', attrs: { v: '2', type: 'product_list' } }],
      },
    ];
  }
  return [];
}

/**
 * Konten gaya lama -> konten gaya Baileys.
 * lama:    { type: 'image', media, mimetype, caption }
 * Baileys: { image: media, mimetype, caption }
 */
function toBaileysContent(c) {
  if (typeof c === 'string') return { text: c };
  if (!c || typeof c !== 'object') return c;

  const mentions = c.mentions;
  const withMentions = mentions ? { mentions } : {};
  const ctx = c.contextInfo ? { contextInfo: c.contextInfo } : {};

  switch (c.type) {
    case 'text':
    case 'string':
      return { text: c.text ?? '', ...withMentions, ...ctx };

    case 'image':
      return {
        image: c.media, ...(c.caption !== undefined && { caption: c.caption }),
        ...(c.mimetype && { mimetype: c.mimetype }),
        ...(c.viewOnce && { viewOnce: true }), ...withMentions, ...ctx,
      };

    case 'video':
      return {
        video: c.media, ...(c.caption !== undefined && { caption: c.caption }),
        ...(c.mimetype && { mimetype: c.mimetype }),
        ...(c.gifPlayback && { gifPlayback: true }),
        ...(c.ptv && { ptv: true }),   // ptv = video note (bulat), BUKAN foto live
        ...(c.viewOnce && { viewOnce: true }), ...withMentions, ...ctx,
      };

    case 'audio':
      return {
        audio: c.media, ...(c.mimetype && { mimetype: c.mimetype }),
        ptt: c.ptt === true, ...(c.viewOnce && { viewOnce: true }),
        ...(c.seconds && { seconds: c.seconds }), ...ctx,
      };

    case 'sticker':
      return { sticker: c.media, ...ctx };

    case 'document':
      return {
        document: c.media, ...(c.mimetype && { mimetype: c.mimetype }),
        ...(c.fileName && { fileName: c.fileName }),
        ...(c.caption !== undefined && { caption: c.caption }), ...withMentions, ...ctx,
      };

    case 'reaction':
      return { react: { text: c.emoji ?? '', key: c.target } };

    case 'revoke':
      return { delete: { remoteJid: c.remoteJid, id: c.id, fromMe: true } };

    case 'poll':
      return {
        poll: {
          name: c.name,
          values: c.values,
          selectableCount: c.selectableCount ?? 1,
        },
      };

    default:
      // Sudah bentuk Baileys ({ text, image, ... }) atau proto mentah —
      // biarkan apa adanya; send() yang memutuskan jalurnya.
      return { ...c, ...withMentions, ...ctx };
  }
}

/** opsi gaya lama -> opsi gaya Baileys */
function toBaileysOptions(opts) {
  if (!opts || typeof opts !== 'object') return {};
  const out = {};
  if (opts.mentions) out.mentions = opts.mentions;
  if (opts.quoted) out.quoted = opts.quoted;
  else if (opts.quote) {
    // lama: { quote: { id, key, message } } -> Baileys butuh { key, message }
    out.quoted = {
      key: opts.quote.key || { id: opts.quote.id, remoteJid: opts.quote.remoteJid, fromMe: false },
      message: opts.quote.message,
    };
  }
  if (opts.messageId) out.messageId = opts.messageId;
  if (opts.timestamp) out.timestamp = opts.timestamp;
  if (opts.ephemeralExpiration) out.ephemeralExpiration = opts.ephemeralExpiration;
  return out;
}

/** Baileys pakai `id`, call-site lama pakai `jid` — samakan supaya engine/jid.js tetap jalan */
function normalizeGroupMeta(meta) {
  if (!meta || !Array.isArray(meta.participants)) return meta;
  meta.participants = meta.participants.map((p) => ({
    ...p,
    jid: p.id,
    isAdmin: p.isAdmin ?? p.admin === 'admin',
    isSuperAdmin: p.isSuperAdmin ?? p.admin === 'superadmin',
  }));
  return meta;
}

/**
 * Baileys v7 baca `mentions` dari KONTEN, bukan dari opsi: sendMessage ngebuang
 * `options.mentions` diam-diam (nggak nyampe ke `contextInfo.mentionedJid`).
 * Makanya mention harus nempel di kontennya.
 */
function attachMentions(content, mentions) {
  if (!mentions?.length) return content;
  return { ...content, mentions };
}

/**
 * Baileys balikin hasil groupParticipantsUpdate sebagai `{ status, jid }` dengan
 * status = KODE STRING ('200' sukses, '403'/'409' gagal) — bukan 'ok'.
 * Semua call-site (kick, add, kickall) ngecek `status === 'ok'` + `r.code`, jadi
 * tanpa normalisasi ini aksi yang SUKSES dilaporin gagal ("kode error undefined").
 */
function normalizeParticipantResults(res) {
  return (Array.isArray(res) ? res : []).map((r) => ({
    jid: r?.jid,
    status: String(r?.status) === '200' ? 'ok' : 'error',
    code: Number(r?.status) || 0,
  }));
}

/** Batas waktu, biar query WA yang nggantung nggak nahan handler selamanya. */
function withTimeout(p, ms, label = 'timeout') {
  let t;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} ${ms}ms`)), ms); }),
  ]);
}

/**
 * Baileys kadang balikin objek `{ jid: value }` padahal call-site nunggu array
 * (mis. `groupFetchAllParticipating()`). Normalisasi di adapter, bukan di tiap
 * call-site — biar nggak ada yang kelewat.
 */
function asArray(v) {
  return Array.isArray(v) ? v : Object.values(v || {});
}

/**
 * @param {object} o
 * @param {object} o.auth        { creds, keys } dari engine/baileys/auth.js
 * @param {Function} o.saveCreds dipanggil tiap creds.update
 * @param {object} o.logger
 * @param {boolean} o.pairingMode kalau true, jangan emit 'auth_qr' (biar UI nggak
 *                                nampilin QR padahal user mau pairing code)
 */
function createClient({ auth, saveCreds, logger, pairingMode = false }) {
  const ev = new EventEmitter();
  ev.setMaxListeners(50);

  let sock = null;
  let meJid = null;
  let closed = false;
  let pendingPhone = null;   // nomor pairing yg diminta sebelum socket siap
  let pairingCode = null;    // kode pairing yg terakhir diminta (lihat catatan di bawah)
  let qrCount = 0;           // urutan QR di socket ini (ttl: 1st 60s, sisanya 20s)

  // ── Kirim proto mentah (tombol/list) — jalur relayMessage ──────────────────
  async function sendRaw(jid, protoContent, opts = {}) {
    const message = proto.Message.create(protoContent);
    const wam = generateWAMessageFromContent(jid, message, {
      userJid: meJid || undefined,
      quoted: opts.quoted,
      messageId: opts.messageId,
    });
    // Node tambahan WAJIB ada, kalau nggak tombolnya di-drop sama WA.
    const nodes = buttonNodes(normalizeMessageContent(wam.message));
    const additionalNodes = [...nodes];
    if (nodes.length && !isJidGroup(jid)) {
      additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
    }
    await sock.relayMessage(jid, wam.message, {
      messageId: wam.key.id,
      additionalNodes,
    });
    rememberSent(wam);
    return wam;
  }

  // Pesan berlabel AI. Bukan lewat sendRaw() karena node-nya beda: yang ini
  // `<bot biz_bot="1"/><biz/>` (penanda pesan bot), bukan node tombol.
  async function sendAi(jid, text, opts = {}) {
    if (!sock) throw new Error('socket belum siap');
    const message = proto.Message.create(aiContent(text));
    const wam = generateWAMessageFromContent(jid, message, { userJid: meJid || undefined });
    await sock.relayMessage(jid, wam.message, {
      messageId: wam.key.id,
      additionalNodes: opts.nodes ?? aiNodesFor(jid),
    });
    rememberSent(wam);
    return wam;
  }

  // Jalur proto mentah (tombol) nggak lewat generateWAMessageContent, jadi
  // `mentions` nggak otomatis jadi `contextInfo.mentionedJid` — tempel sendiri.
  // (Jalur normal diurus Baileys dari opsi `mentions` di send().)
  function withMentions(jid, content, mentions) {
    if (!mentions?.length) return content;
    const key = Object.keys(content).find((k) => k.endsWith('Message'));
    const inner = key && content[key];
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return content;
    return {
      ...content,
      [key]: {
        ...inner,
        contextInfo: {
          ...(inner.contextInfo || {}),
          mentionedJid: [...new Set([...(inner.contextInfo?.mentionedJid || []), ...mentions])],
        },
      },
    };
  }

  // Upload media jadi proto (dipakai header pesan tombol: InteractiveMessage.Header
  // butuh proto Message.IDocumentMessage, bukan Buffer). Baileys yang ngurus
  // enkripsi + upload; kita cuma bungkus.
  async function prepareDocument(buffer, mimetype, fileName) {
    if (!sock) throw new Error('socket belum siap');
    return prepareWAMessageMedia(
      { document: buffer, mimetype, fileName },
      // mediaUploadTimeoutMs: tanpa ini upload bisa nggantung tanpa batas
      // (prepareWAMessageMedia nerusin nilainya ke waUploadToServer apa adanya).
      { upload: sock.waUploadToServer, logger: sock.logger, mediaUploadTimeoutMs: 60000 },
    );
  }

  async function send(jid, content, opts = {}) {
    if (!sock) throw new Error('socket belum siap');
    // Pesan berlabel AI — WA nampilin tanda "AI" di bubble-nya.
    if (opts.ai) return sendAi(jid, content?.text ?? content, opts);
    // Tag biru di grup LID butuh bentuk LID-nya ikut — lihat engine/jid.js.
    // `mentions` boleh nempel di konten ({ text, mentions }) atau di opsi.
    const mentions = mentionsForChat(jid, opts.mentions || content?.mentions);
    if (isRawProto(content)) return sendRaw(jid, withMentions(jid, content, mentions), toBaileysOptions(opts));
    const wam = await sock.sendMessage(jid, attachMentions(toBaileysContent(content), mentions), toBaileysOptions(opts));
    rememberSent(wam);
    return wam;
  }

  // ── Event masuk: WAMessage Baileys -> bentuk yg dibaca engine ──────────────
  function normalizeIncoming(m) {
    return {
      key: m.key,
      message: unwrapMessage(m.message),
      chatJid: m.key?.remoteJid,
      pushName: m.pushName,
      messageStubType: m.messageStubType,
      messageStubParameters: m.messageStubParameters,
      msg: m,
      raw: m,
    };
  }

  // ── Koneksi ───────────────────────────────────────────────────────────────
  function connect() {
    return new Promise((resolve, reject) => {
      qrCount = 0; // socket baru -> QR pertama balik ke ttl 60s
      pairingCode = null; // kode lama mati bareng socket lama; boleh minta lagi
      pendingPhone = null;
      try {
        sock = makeWASocket({
          auth: {
            creds: auth.creds,
            keys: makeCacheableSignalKeyStore(auth.keys, logger),
          },
          logger,
          browser: Browsers.ubuntu('Chrome'),
          printQRInTerminal: false,
          markOnlineOnConnect: false,
          syncFullHistory: false,
          generateHighQualityLinkPreview: true,
          // Dipakai Baileys buat jawab retry receipt (penerima gagal decrypt
          // -> minta kirim ulang). Lihat rememberSent() di atas.
          // Log-nya sengaja: ini satu-satunya jejak kelihatan kalau ada balasan
          // yang harus dikirim ulang — "kirim ulang" = WA-nya nyangkut di penerima.
          getMessage: async (key) => {
            const found = lookupSent(key);
            console.log(found ? `[retry] kirim ulang ${key?.id}` : `[retry] ${key?.id} nggak ada di cache`);
            return found;
          },
        });
      } catch (e) {
        return reject(e);
      }

      sock.ev.on('creds.update', () => { try { saveCreds?.(); } catch {} });

      sock.ev.on('connection.update', (u) => {
        const { connection, lastDisconnect, qr } = u;

        if (qr) {
          // Baileys: QR pertama berlaku 60s, penggantinya 20s
          // (lib/Socket/socket.js:709 & :723 — qrMs). Timer di UI harus ikut
          // angka ini, bukan hardcoded, biar countdown-nya jujur.
          qrCount++;
          const ttlMs = qrCount === 1 ? 60000 : 20000;
          // pairingMode: JANGAN emit 'auth_qr'. Kalau diemit, engine broadcast
          // 'qr' ke UI tiap 20s dan panel pairing ketimpa QR — kode-nya hilang
          // dari layar persis pas user lagi ngetik.
          if (!pairingMode) ev.emit('auth_qr', { qr, ttlMs });
          // Sinyal "server siap" buat pairing code. Dikirim bareng tiap QR —
          // QR baru = ref baru = kode lama mati, jadi kode baru harus diminta.
          ev.emit('auth_pairing_required', { ttlMs });
        }

        if (connection === 'open') {
          meJid = jidNormalizedUser(sock.user?.id || '');
          ev.emit('auth_paired', { credentials: { meJid } });
          ev.emit('connection', { status: 'open' });
        }

        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          // 401 = loggedOut cuma kalau sesi INI memang sudah pernah terdaftar.
          // Bot yang belum pernah pairing: WA tolak handshake dengan <failure
          // reason="401"> (socket.js:798) dan Baileys naikin jadi 401 juga.
          // Kalau dianggap logout → engine stop total, padahal yang dibutuhin
          // cuma socket baru (kode pairing lama toh mati bareng socket lama).
          // Penanda "sesi beneran": creds.me.lid, di-set cuma pas koneksi
          // pertama berhasil (socket.js:764) atau link-code pairing kelar
          // (validate-connection.js:192). `me.id` jangan dipakai — itu udah
          // di-set requestPairingCode sebelum sempat connect (socket.js:602).
          const isLogout = code === DisconnectReason.loggedOut
            && !!auth?.creds?.me?.lid;
          closed = true;
          ev.emit('connection', {
            status: 'close',
            reason: String(lastDisconnect?.error?.message || code || 'unknown'),
            isLogout,
          });
        }
      });

      sock.ev.on('messages.upsert', ({ messages, type }) => {
        for (const m of messages || []) {
          // WA taruh PN di key (participantAlt/remoteJidAlt) -> isi peta LID
          // SEBELUM handler jalan, biar pesan pertama setelah restart kebaca.
          cacheLidFromKey(m?.key);
          if (!m.message) {
            if (type !== 'append') console.log(`[skip] pesan tanpa isi dari ${m?.key?.remoteJid || '?'} (${m?.key?.id || '?'})`);
            continue;
          }
          ev.emit('message', normalizeIncoming(m));
        }
      });

      sock.ev.on('group-participants.update', (u) => {
        ev.emit('group_participants', {
          jid: u.id,
          participants: u.participants,
          action: u.action,
          author: u.author,
        });
      });

      resolve();
    });
  }

  async function disconnect() {
    closed = true;
    // Reconnect internal Baileys harus dimatikan DULU, kalau nggak socket
    // bangun ulang sendiri setelah end() dan session.db tetap ke-lock.
    try { sock?.ev?.removeAllListeners('connection.update'); } catch {}
    try { sock?.end(undefined); } catch {}
    try { sock?.ws?.close(); } catch {}
  }

  // ── Metadata grup: cache + timeout ───────────────────────────────────────────
  // Satu command grup bisa nanya metadata 3-4x (nama grup, isAdmin, isBotAdmin)
  // dan tiap tanya = 1 round-trip ke WA. Tanpa cache, WA yang lambat bikin
  // handler nunggu selamanya -> command nggak pernah dibalas (bot "ga respon").
  const metaCache = new Map(); // jid -> { meta, at }
  const META_TTL     = 15000;
  const META_TIMEOUT = 8000;
  const dropMeta = (jid) => metaCache.delete(jid);

  async function groupMeta(jid) {
    const hit = metaCache.get(jid);
    if (hit && Date.now() - hit.at < META_TTL) return hit.meta;
    try {
      const meta = await withTimeout(
        sock.groupMetadata(jid).then(normalizeGroupMeta), META_TIMEOUT, 'groupMetadata',
      );
      // Isi peta LID<->PN dari peserta. Ini SATU-SATUNYA yang jalan: Baileys v7
      // nggak punya `sock.store` (kontak) — fallback store di engine/jid.js
      // selalu null. Dulu pengisian cuma di jalur "nama grup belum ke-cache",
      // jadi tiap habis restart peta-nya kosong: `@mention` jadi teks polos,
      // deteksi owner meleset (command owner diem) — gejalanya "command mesti 2x".
      if (meta?.participants) cacheLidFromMeta(meta.participants);
      metaCache.set(jid, { meta, at: Date.now() });
      return meta;
    } catch (e) {
      if (hit) return hit.meta; // pakai yang basi daripada bikin command mati total
      throw e;
    }
  }

  // Semua update peserta lewat sini: hasilnya dinormalisasi + cache metadata dibuang.
  const participantsUpdate = (jid, jids, action) =>
    sock.groupParticipantsUpdate(jid, jids, action).then((res) => {
      dropMeta(jid);
      return normalizeParticipantResults(res);
    });

  // ── Wajah client lama ─────────────────────────────────────────────────────────
  const client = {
    // socket asli, buat kode baru yg mau API Baileys langsung
    get sock() { return sock; },
    get meJid() { return meJid; },

    // Peta LID<->PN milik Baileys sendiri (persist di session.db) — bukan cache
    // memori kayak di engine/jid.js, jadi masih ada setelah proses restart.
    lid: {
      getPn:  async (lid) => { try { return await sock.signalRepository?.lidMapping?.getPNForLID?.(String(lid)) || null; } catch { return null; } },
      getLid: async (pn)  => { try { return await sock.signalRepository?.lidMapping?.getLIDForPN?.(String(pn)) || null; } catch { return null; } },
    },

    on: (...a) => ev.on(...a),
    once: (...a) => ev.once(...a),
    off: (...a) => ev.off(...a),
    removeAllListeners: (...a) => ev.removeAllListeners(...a),
    connect,
    disconnect,
    destroy: disconnect,

    auth: {
      requestPairingCode: async (phone, custom) => {
        // Normalisasi dulu: Baileys mau digit saja, tanpa '+', spasi, atau '-'.
        pendingPhone = String(phone).replace(/\D/g, '');
        if (!sock) throw new Error('socket belum siap — panggil connect() dulu');
        // SATU kode per QR. Tiap panggilan ngirim iq 'companion_hello' baru dan
        // nimpa authState.creds.pairingCode — kode lama langsung mati, dan
        // WA cuma nyimpen satu sesi pairing yg lagi jalan. Jadi jangan mintain
        // kode baru selama kode sekarang masih hidup; cukup pakai yg ada.
        // (sock.js:696 genPairQR nge-loop tiap 20s, tapi ref-nya dipakai buat
        //  QR — bukan alasan buat nge-reset kode.)
        if (pairingCode) return pairingCode;
        pairingCode = await sock.requestPairingCode(pendingPhone, custom);
        return pairingCode;
      },
    },

    message: {
      send,
      sendAi,
      prepareDocument,
      downloadBytes: async (source) => {
        const msg = source?.message ? source : { message: source };
        return baileysDownload(msg, 'buffer', {}, {
          logger,
          reuploadRequest: sock?.updateMediaMessage,
        });
      },
      upload: (buffer, opts) => sock.waUploadToServer(buffer, opts),
      read: (keys) => sock.readMessages(Array.isArray(keys) ? keys : [keys]),
      reply: (jid, content, opts) => send(jid, content, opts),
    },

    group: {
      queryGroupMetadata: (jid) => groupMeta(jid),
      queryAllGroups: async () => asArray(await sock.groupFetchAllParticipating()),
      queryInviteCode: (jid) => sock.groupInviteCode(jid),
      // Kebalikannya: link/kode -> metadata grup. Dipakai panel (resolveInvite)
      // buat nampilin JID dari link yang di-paste. Sebelum ini method-nya
      // nggak ada di adapter -> endpoint-nya selalu 400 "Gagal resolve link".
      queryGroupInviteInfo: (code) => sock.groupGetInviteInfo(code),
      addParticipants: (jid, jids) => participantsUpdate(jid, jids, 'add'),
      removeParticipants: (jid, jids) => participantsUpdate(jid, jids, 'remove'),
      promoteParticipants: (jid, jids) => participantsUpdate(jid, jids, 'promote'),
      demoteParticipants: (jid, jids) => participantsUpdate(jid, jids, 'demote'),
      leaveGroup: (jid) => sock.groupLeave(Array.isArray(jid) ? jid[0] : jid),
      setSubject: (jid, subject) => sock.groupUpdateSubject(jid, subject).then((r) => (dropMeta(jid), r)),
      setDescription: (jid, desc) => sock.groupUpdateDescription(jid, desc).then((r) => (dropMeta(jid), r)),
      setSetting: (jid, setting) => sock.groupSettingUpdate(jid, setting).then((r) => (dropMeta(jid), r)),
      joinGroupViaInvite: (code) => sock.groupAcceptInvite(code),
      approveMembershipRequests: (jid, jids) =>
        sock.groupRequestParticipantsUpdate(jid, jids, 'approve').then((r) => (dropMeta(jid), r)),
    },

    profile: {
      getProfilePicture: (jid, type = 'image') => sock.profilePictureUrl(jid, type),
      setProfilePicture: (jid, buffer) => sock.updateProfilePicture(jid, buffer),
      setStatus: (text) => sock.updateProfileStatus(text),
    },

    privacy: {
      blockUser: (jid) => sock.updateBlockStatus(jid, 'block'),
      unblockUser: (jid) => sock.updateBlockStatus(jid, 'unblock'),
    },

    newsletter: {
      follow: (jid) => sock.newsletterFollow(jid),
    },

    business: {
      getBusinessProfile: (jid) => sock.getBusinessProfile(jid),
      // client lama punya ini; Baileys nggak. Dipertahankan supaya call-site nggak
      // error — balikin null kalau nggak ada (badge verified memang hilang).
      getVerifiedName: async (jid) => {
        try {
          const p = await sock.getBusinessProfile(jid);
          return p?.verifiedName ?? null;
        } catch { return null; }
      },
    },

    stores: {
      contacts: {
        // Dipakai engine/jid.js buat resolve LID<->nomor. Baileys nyimpen di
        // store internal; kalau nggak ada, jid.js jatuh ke cache (aman).
        getByJid: async (jid) => sock?.store?.contacts?.[jid] ?? null,
        getByPhoneNumber: async (pn) => {
          const contacts = sock?.store?.contacts || {};
          return Object.values(contacts).find((c) => c?.phoneNumber === pn) ?? null;
        },
      },
    },

    // Dipakai engine buat cek tipe; Baileys nggak butuh tapi call-site ada.
    get isConnected() { return !closed && !!sock?.user; },
    get __pendingPhone() { return pendingPhone; },
  };

  return client;
}

module.exports = {
  createClient, toBaileysContent, toBaileysOptions, normalizeGroupMeta, isRawProto, attachMentions,
  normalizeParticipantResults, withTimeout, asArray,
  aiContent, AI_NODES, BIZ_NODE, aiNodesFor,  // pesan berlabel AI (buat test)
  rememberSent, lookupSent, // buat test retry receipt
  onMessageSent,             // buat antidelete (plugins/02-group.js)
  unwrapMessage,             // view-once -> media biasa (dipakai banyak plugin)
};
