'use strict';

/**
 * engine/baileys/client.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Adapter Baileys v7 yang "menyamar" jadi client zapo-js.
 *
 * KENAPA ADAPTER, BUKAN PORT ULANG:
 *   Repo ini punya ~770 panggilan `client.*` di 9 file, tapi cuma 27 method
 *   unik. Menulis ulang 770 titik = risiko typo 770 kali; menulis 1 adapter =
 *   risiko di 1 file, dan plugin/engine nggak perlu disentuh.
 *
 * YANG TIDAK BISA DIPETAKAN (sudah diuji, lihat MIGRASI-BAILEYS.md):
 *   Baileys v7 NGGAK PUNYA API tombol. `sendMessage` nolak `interactiveMessage`
 *   ("Invalid media type") dan membuang `buttons`/`sections` diam-diam.
 *   Satu-satunya jalur = relayMessage + proto mentah → lihat sendRaw().
 *
 * Pemakaian:
 *   const client = createClient({ auth, logger, saveCreds, pairingMode });
 *   client.on('message', ...); await client.connect();
 */

const EventEmitter = require('events');
const {
  makeWASocket,
  makeCacheableSignalKeyStore,
  downloadMediaMessage: baileysDownload,
  jidNormalizedUser,
  DisconnectReason,
  proto,
  Browsers,
} = require('baileys');
const { generateWAMessageFromContent } = require('baileys/lib/Utils/messages.js');

// Key proto mentah yg HARUS lewat relayMessage (sendMessage nolak ini).
const RAW_PROTO_KEYS = [
  'interactiveMessage', 'buttonsMessage', 'templateMessage', 'listMessage',
  'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
  'albumMessage', 'productMessage', 'orderMessage', 'eventMessage',
  'pollCreationMessageV3', 'requestPhoneNumberMessage', 'stickerPackMessage',
  'buttonsResponseMessage', 'listResponseMessage', 'highlyStructuredMessage',
];

const isRawProto = (c) =>
  !!c && typeof c === 'object' && RAW_PROTO_KEYS.some((k) => c[k] !== undefined);

/**
 * Konten gaya zapo -> konten gaya Baileys.
 * zapo:    { type: 'image', media, mimetype, caption }
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
        ...(c.mimetype && { mimetype: c.mimetype }), ...withMentions, ...ctx,
      };

    case 'video':
      return {
        video: c.media, ...(c.caption !== undefined && { caption: c.caption }),
        ...(c.mimetype && { mimetype: c.mimetype }),
        ...(c.gifPlayback && { gifPlayback: true }), ...withMentions, ...ctx,
      };

    case 'audio':
      return {
        audio: c.media, ...(c.mimetype && { mimetype: c.mimetype }),
        ptt: c.ptt === true, ...(c.seconds && { seconds: c.seconds }), ...ctx,
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

/** opsi gaya zapo -> opsi gaya Baileys */
function toBaileysOptions(opts) {
  if (!opts || typeof opts !== 'object') return {};
  const out = {};
  if (opts.mentions) out.mentions = opts.mentions;
  if (opts.quoted) out.quoted = opts.quoted;
  else if (opts.quote) {
    // zapo: { quote: { id, key, message } } -> Baileys butuh { key, message }
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

/** Baileys pakai `id`, zapo pakai `jid` — samakan supaya engine/jid.js tetap jalan */
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

  // ── Kirim proto mentah (tombol/list) — jalur relayMessage ──────────────────
  async function sendRaw(jid, protoContent, opts = {}) {
    const message = proto.Message.create(protoContent);
    const wam = generateWAMessageFromContent(jid, message, {
      userJid: meJid || undefined,
      quoted: opts.quoted,
      messageId: opts.messageId,
    });
    await sock.relayMessage(jid, wam.message, { messageId: wam.key.id });
    return wam;
  }

  async function send(jid, content, opts = {}) {
    if (!sock) throw new Error('socket belum siap');
    if (isRawProto(content)) return sendRaw(jid, content, toBaileysOptions(opts));
    return sock.sendMessage(jid, toBaileysContent(content), toBaileysOptions(opts));
  }

  // ── Event masuk: WAMessage Baileys -> bentuk yg dibaca engine ──────────────
  function normalizeIncoming(m) {
    return {
      key: m.key,
      message: m.message,
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
          // Baileys v7: dipakai buat retry pesan yg gagal decrypt.
          getMessage: async () => undefined,
        });
      } catch (e) {
        return reject(e);
      }

      sock.ev.on('creds.update', () => { try { saveCreds?.(); } catch {} });

      sock.ev.on('connection.update', (u) => {
        const { connection, lastDisconnect, qr } = u;

        if (qr) {
          ev.emit('auth_qr', { qr, ttlMs: 60000 });
          // Sinyal "server siap" buat pairing code. Dikirim bareng QR pertama
          // karena itu momen server benar-benar siap nerima request.
          ev.emit('auth_pairing_required');
        }

        if (connection === 'open') {
          meJid = jidNormalizedUser(sock.user?.id || '');
          ev.emit('auth_paired', { credentials: { meJid } });
          ev.emit('connection', { status: 'open' });
        }

        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          const isLogout = code === DisconnectReason.loggedOut;
          closed = true;
          ev.emit('connection', {
            status: 'close',
            reason: String(lastDisconnect?.error?.message || code || 'unknown'),
            isLogout,
          });
        }
      });

      sock.ev.on('messages.upsert', ({ messages }) => {
        for (const m of messages || []) {
          if (!m.message) continue;
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

  // ── Wajah zapo-js ─────────────────────────────────────────────────────────
  const client = {
    // socket asli, buat kode baru yg mau API Baileys langsung
    get sock() { return sock; },
    get meJid() { return meJid; },

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
        return sock.requestPairingCode(pendingPhone, custom);
      },
    },

    message: {
      send,
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
      queryGroupMetadata: (jid) => sock.groupMetadata(jid).then(normalizeGroupMeta),
      queryAllGroups: () => sock.groupFetchAllParticipating(),
      queryInviteCode: (jid) => sock.groupInviteCode(jid),
      addParticipants: (jid, jids) => sock.groupParticipantsUpdate(jid, jids, 'add'),
      removeParticipants: (jid, jids) => sock.groupParticipantsUpdate(jid, jids, 'remove'),
      promoteParticipants: (jid, jids) => sock.groupParticipantsUpdate(jid, jids, 'promote'),
      demoteParticipants: (jid, jids) => sock.groupParticipantsUpdate(jid, jids, 'demote'),
      leaveGroup: (jid) => sock.groupLeave(Array.isArray(jid) ? jid[0] : jid),
      setSubject: (jid, subject) => sock.groupUpdateSubject(jid, subject),
      setDescription: (jid, desc) => sock.groupUpdateDescription(jid, desc),
      setSetting: (jid, setting) => sock.groupSettingUpdate(jid, setting),
      joinGroupViaInvite: (code) => sock.groupAcceptInvite(code),
      approveMembershipRequests: (jid, jids) => sock.groupRequestParticipantsUpdate(jid, jids, 'approve'),
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
      // zapo punya ini; Baileys nggak. Dipertahankan supaya call-site nggak
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

module.exports = { createClient, toBaileysContent, toBaileysOptions, normalizeGroupMeta, isRawProto };
