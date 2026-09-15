'use strict';
/**
 * plugins/10-crm.js — command `.crm`
 * Copy pesan yang di-reply jadi kode JS siap tempel (khusus DEV + OWNER).
 *
 * Asalnya plugin `plugins/tools/crm2.js` (ESM, code by ryyn dev rin-md,
 * channel https://whatsapp.com/channel/0029Vb6EHtR5Ui2gHMW9zX2x).
 * Dua hal yang nggak bisa dipakai mentah di repo ini:
 *   1. `plugins/tools/` nggak dibaca — loader cuma `readdirSync('./plugins')` (flat,
 *      nggak rekursif) -> file ini ditaruh di `plugins/` biar kebaca.
 *   2. plugin di sini CommonJS + terima `ctx` (engine/whatsappEngine.js buildContext),
 *      bukan ESM `m/conn` -> gate & kirimnya pakai ctx. `generateWAMessageFromContent` /
 *      `jidNormalizedUser` dari '@rexxhayanasi/elaina-baileys' nggak dibutuhin:
 *      itu cuma buat ngerakit WAMessage manual, sementara adapter
 *      `client.message.send()` udah ngerjain itu (dan paketnya nggak ada di node_modules).
 */

// ─── Ambil quoted message dari proto pesan masuk ────────────────────────────
function getQuoted(message) {
  if (!message || typeof message !== 'object') return null;
  for (const val of Object.values(message)) {
    const q = val?.contextInfo?.quotedMessage;
    if (q) return q;
  }
  // sebagian kiriman naruh langsung di root (jarang)
  return message.contextInfo?.quotedMessage || null;
}

// ─── Helper dari plugin aslinya ─────────────────────────────────────────────
function unwrap(content) {
  if (!content || typeof content !== 'object') return content;
  if (content.ephemeralMessage?.message) return unwrap(content.ephemeralMessage.message);
  if (content.viewOnceMessage?.message) return unwrap(content.viewOnceMessage.message);
  if (content.viewOnceMessageV2?.message) return unwrap(content.viewOnceMessageV2.message);
  if (content.viewOnceMessageV2Extension?.message) return unwrap(content.viewOnceMessageV2Extension.message);
  if (content.documentWithCaptionMessage?.message) return unwrap(content.documentWithCaptionMessage.message);
  return content;
}

function normalizeForRelay(rawContent) {
  const content = unwrap(rawContent);
  if (typeof content?.conversation === 'string') {
    const { conversation, ...rest } = content;
    return { ...rest, extendedTextMessage: { text: conversation } };
  }
  return content;
}

function toJsLiteral(value, indent = 2, seen = new WeakSet(), depth = 0) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return JSON.stringify(Buffer.from(value).toString('base64'));
  }
  if (typeof value !== 'object') return JSON.stringify(value);
  if (depth > 40) return '"[MaxDepth]"';
  if (seen.has(value)) return '"[Circular]"';

  seen.add(value);
  const pad = ' '.repeat(indent);
  const padClose = ' '.repeat(Math.max(indent - 2, 0));
  let result;

  if (Array.isArray(value)) {
    if (!value.length) {
      result = '[]';
    } else {
      const items = value.map(v => pad + toJsLiteral(v, indent + 2, seen, depth + 1));
      result = `[\n${items.join(',\n')}\n${padClose}]`;
    }
  } else {
    const keys = Object.keys(value).filter(k => typeof value[k] !== 'function' && value[k] !== undefined);
    if (!keys.length) {
      result = '{}';
    } else {
      const lines = keys.map(k => {
        const keyStr = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
        return `${pad}${keyStr}: ${toJsLiteral(value[k], indent + 2, seen, depth + 1)};`;
      });
      result = `{\n${lines.join('\n')}\n${padClose}}`;
    }
  }

  seen.delete(value);
  return result;
}

// ─── Key yang ditambahin framework bot lain (mtype, fakeObj, dst) ───────────
// Bukan bagian pesan aslinya — jangan sampai ke-copy ke kode relay.
const FRAMEWORK_DECORATED_KEYS = new Set([
  'mtype', 'id', 'chat', 'isBaileys', 'sender', 'fromMe', 'mentionedJid',
  'fakeObj', 'delete', 'copyNForward', 'download', 'key', 'participant',
  'text', 'body', 'name', 'pushName', 'viewonce', 'download1',
]);

/** Buang key bungkus + semua fungsi (fungsi nggak bisa di-serialize). */
function stripFrameworkProps(content) {
  if (!content || typeof content !== 'object') return content;
  const output = {};
  for (const key of Object.keys(content)) {
    if (FRAMEWORK_DECORATED_KEYS.has(key)) continue;
    if (typeof content[key] === 'function') continue;
    output[key] = content[key];
  }
  return output;
}

// Isi relayContent dibungkus proto: { imageMessage: {...} } -> { message: { imageMessage:
// {...} } }, karena `conn.relayMessage(jid, message, {}` di plugin aslinya ngasih
// PROTO pesannya (bukan WAMessage). Lihat catatan di buildRelayCode.
function toProtoContent(content) {
  const clean = stripFrameworkProps(content);
  const key = Object.keys(clean).find(k => k.endsWith('Message'));
  if (!key) return clean;
  return { message: { [key]: { ...clean[key], ...Object.fromEntries(
    Object.entries(clean).filter(([k]) => k !== key)
  ) } } };
}

/** Kode siap tempel buat kirim ulang pesan ini di bot lain. */
function buildRelayCode(content, chatExpr = 'm.chat') {
  return `await conn.relayMessage(${chatExpr}, ${toJsLiteral(toProtoContent(content))}, {});`;
}

/** Nama tipe pesan dari key proto-nya — dipakai buat nama file. */
function typeNameFromContent(content) {
  const key = Object.keys(stripFrameworkProps(content))[0] || 'UnknownMessage';
  return key.charAt(0).toUpperCase() + key.slice(1);
}

// ─── Handler ────────────────────────────────────────────────────────────────
module.exports = async function crmHandler(ctx) {
  if (!ctx.isCmd) return false;
  // pakai `case` literal biar kebaca scanner plugins/08-didyoumean.js (COMMAND_SET)
  switch (String(ctx.command || '').toLowerCase()) {
    case 'crm':
    case 'crm2':
      break;
    default:
      return false;
  }

  const { reply, client, jid, botData } = ctx;
  const p = botData.prefix ?? '';
  const { react, mess } = ctx;   // destructure dulu: ctx.react/mess bisa ke-clobber spread

  // Gate: owner bot ATAU nomor di DEVELOPER_NUMBER (sama kaya plugins/09-jarvis.js)
  const devNum    = String(process.env.DEVELOPER_NUMBER || '').replace(/\D/g, '');
  const senderNum = String(ctx.sender || '').split('@')[0].split(':')[0];
  const isDev     = devNum && senderNum === devNum;

  if (!ctx.isOwner && !isDev) {
    await reply('Ehh ini khusus dev & owner aja lho~ 🌸 yamete kudasai (≧◡≦)');
    return true;
  }

  const rawQuoted = getQuoted(ctx.msg?.message);
  if (!rawQuoted) {
    await reply(`❌ Reply pesan yang mau di-copy dulu, lalu ketik *${p + ctx.command}*`);
    return true;
  }

  const content = normalizeForRelay(rawQuoted);
  const clean = stripFrameworkProps(content);

  // 1. Relay pesannya beneran ke chat ini (efek visual kaya .crm aslinya)
  try {
    await client.message.send(jid, clean, { quote: ctx.msg });
  } catch (e) {
    await reply(`❌ Gagal me-relay pesan ini: ${e.message || e}`);
    return true;
  }

  // 2. Kirim kodenya sekaligus: file .js di header + tombol native-flow
  //    "Lihat kode" (cta_copy) yang nampilin kode monospace + tombol Salin.
  //    Header.documentMessage => satu kiriman, file & tombol nempel bareng.
  //    ponytail: cta_copy kepotong kalau kode >~60k char; di situ tombolnya
  //    di-skip, filenya tetap kekirim utuh (gk ada fallback lain di WA).
  const typeName = typeNameFromContent(clean);
  const fileName = `${typeName}.js`;
  const code = buildRelayCode(clean);
  const caption = `📄 ${fileName}`;

  const doc = await client.message.prepareDocument
    ? await client.message.prepareDocument(Buffer.from(code, 'utf8'), 'application/javascript', fileName)
    : null;

  const docContent = doc?.documentMessage && code.length <= 60000
    ? {
        interactiveMessage: {
          header: { documentMessage: doc.documentMessage, hasMediaAttachment: true },
          body: { text: caption },
          nativeFlowMessage: {
            buttons: [{
              name: 'cta_copy',
              buttonParamsJson: JSON.stringify({
                display_text: 'Lihat kode',
                id: String(Date.now()),
                copy_code: code,
              }),
            }],
          },
        },
      }
    : {
        type: 'document',
        media: Buffer.from(code, 'utf8'),
        mimetype: 'application/javascript',
        fileName,
        caption,
      };

  await client.message.send(jid, docContent, { quote: ctx.msg });

  // 3. React ✅ (pakai ctx, bukan ctx. langsung — biar aman kalau di-spread ulang)
  await react(mess?.reactSuccess || '✅');
  return true;
};
