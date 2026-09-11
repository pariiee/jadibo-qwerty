'use strict';

/**
 * test-bot.js — CLI local tester menggunakan zapo-js API yang benar
 * Usage:
 *   node test-bot.js              → QR scan mode
 *   node test-bot.js --pairing    → Pairing code mode
 */

require('dotenv').config();
const path     = require('path');
const fs       = require('fs');
const readline = require('readline');

const SESSION_DIR = path.resolve('./sessions/test-bot');
fs.mkdirSync(SESSION_DIR, { recursive: true });

const usePairing = process.argv.includes('--pairing');

// ─── Load zapo-js ─────────────────────────────────────────────────────────────
const { WaClient, createStore } = require('zapo-js');
const { createSqliteStore }     = require('@zapo-js/store-sqlite');

// Logger no-op — supaya log internal zapo-js tidak muncul di terminal
const noopLogger = {
  level: 'silent',
  trace: () => {}, debug: () => {}, info: () => {},
  warn:  () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

// ─── Ask for phone number ─────────────────────────────────────────────────────
function askQuestion(q) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, ans => { rl.close(); resolve(ans.trim()); });
  });
}

// ─── Build store ──────────────────────────────────────────────────────────────
function buildStore(dbPath) {
  return createStore({
    backends: {
      sqlite: createSqliteStore({ path: dbPath }),
    },
    providers: {
      auth:         'sqlite',
      signal:       'sqlite',
      preKey:       'sqlite',
      session:      'sqlite',
      identity:     'sqlite',
      senderKey:    'sqlite',
      appState:     'sqlite',
      privacyToken: 'sqlite',
      messages:     'none',
      threads:      'none',
      contacts:     'none',
    },
  });
}

// ─── QR renderer (text fallback) ─────────────────────────────────────────────
function printQr(qrData) {
  try {
    // Try to render as ASCII QR in terminal
    const QRCode = require('qrcode');
    QRCode.toString(qrData, { type: 'terminal', small: true }, (err, str) => {
      if (err) {
        console.log('\n[QR] Raw QR data (gunakan aplikasi scanner):\n' + qrData + '\n');
      } else {
        console.log('\n' + str);
        console.log('[QR] Scan kode di atas dengan WhatsApp kamu\n');
      }
    });
  } catch {
    console.log('\n[QR] Raw QR data:\n' + qrData + '\n');
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║        YaaParBot — CLI Test          ║');
  console.log(`║  Mode : ${usePairing ? 'Pairing Code           ' : 'QR Scan                '}║`);
  console.log('╚══════════════════════════════════════╝\n');

  const dbPath = path.join(SESSION_DIR, 'session.db');
  const store  = buildStore(dbPath);
  const logger = noopLogger; // ganti ke new ConsoleLogger('info') untuk debug verbose

  const client = new WaClient(
    { store, sessionId: 'test-bot' },
    logger
  );

  // ── auth_qr — tampilkan QR (hanya di QR mode) ────────────────────────────
  client.on('auth_qr', ({ qr, ttlMs }) => {
    if (usePairing) return; // suppress QR di pairing mode
    console.log(`[QR] QR baru (berlaku ${Math.round(ttlMs / 1000)}s):`);
    printQr(qr);
  });

  // ── auth_paired — berhasil terhubung ──────────────────────────────────────
  client.on('auth_paired', ({ credentials }) => {
    console.log('\n[Paired] Berhasil terhubung sebagai:', credentials.meJid);
    console.log('[Ready] Bot siap menerima pesan. Kirim !ping untuk test.\n');
  });

  // ── connection — status koneksi ───────────────────────────────────────────
  client.on('connection', async (event) => {
    const { status, reason, isLogout } = event;

    if (status === 'open') {
      const creds = client.getCredentials();
      console.log('[Connected] Sesi terhubung:', creds?.meJid || 'unknown');
    }

    if (status === 'close') {
      console.log(`[Disconnected] Alasan: ${reason}`);

      if (isLogout) {
        console.log('[Logout] Sesi logout. Hapus folder sessions/test-bot dan jalankan ulang.');
        process.exit(0);
      } else {
        console.log('[Reconnect] Mencoba reconnect dalam 5 detik...');
        await client.disconnect().catch(() => {});
        setTimeout(start, 5000);
      }
    }
  });

  // ── message — pesan masuk ─────────────────────────────────────────────────
  client.on('message', async (event) => {
    const { key, message, chatJid, pushName } = event;

    // Skip pesan dari diri sendiri
    if (key?.fromMe) return;
    if (!message) return;

    const body =
      message.conversation ||
      message.extendedTextMessage?.text ||
      message.imageMessage?.caption ||
      message.videoMessage?.caption || '';

    if (!body) return;

    const from = chatJid || key?.remoteJid;
    const ts   = new Date().toLocaleTimeString('id-ID', { hour12: false });
    console.log(`[${ts}] ${pushName || from}: ${body}`);

    const [cmd, ...args] = body.trim().split(/\s+/);

    // Helper reply
    const reply = async (text) => {
      try {
        await client.message.send(from, text);
      } catch (e) {
        console.error('[Reply Error]', e.message);
      }
    };

    switch (cmd?.toLowerCase()) {
      case '!ping': {
        const start = Date.now();
        await reply(`🏓 Pong! Latensi: ${Date.now() - start}ms`);
        break;
      }

      case '!info':
        await reply(
          `*YaaParBot Test Mode*\n\n` +
          `Uptime   : ${Math.floor(process.uptime())}s\n` +
          `Node.js  : ${process.version}\n` +
          `Platform : WhatsApp (zapo-js)`
        );
        break;

      case '!menu':
        await reply(
          `*Menu Test Bot*\n\n` +
          `!ping        → Cek koneksi\n` +
          `!info        → Info bot\n` +
          `!uptime      → Waktu aktif\n` +
          `!echo <teks> → Balas teks\n` +
          `!menu        → Menu ini`
        );
        break;

      case '!uptime': {
        const s   = Math.floor(process.uptime());
        const h   = Math.floor(s / 3600);
        const m   = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        await reply(`⏰ Uptime: ${h}j ${m}m ${sec}d`);
        break;
      }

      case '!echo':
        await reply(args.join(' ') || '(kosong)');
        break;

      default:
        if (body.startsWith('!')) {
          await reply(`Command *${cmd}* tidak dikenali. Ketik !menu untuk daftar.`);
        }
        break;
    }
  });

  // ── Pairing code mode ────────────────────────────────────────────────────
  if (usePairing) {
    const number = await askQuestion('Masukkan nomor WA (tanpa +, contoh: 628123456789): ');
    const cleaned = number.replace(/\D/g, '');

    console.log(`\n[Pairing] Menghubungkan untuk nomor ${cleaned}...`);

    // Docs zapo-js: "wait for auth_pairing_required event OR any QR"
    // auth_qr adalah sinyal bahwa server sudah siap menerima pairing request
    const serverReadyPromise = new Promise((resolve) => {
      client.once('auth_qr', resolve);
      client.once('auth_pairing_required', resolve);
    });

    // Pasang listener SEBELUM connect()
    const connectPromise = client.connect();

    // Tunggu salah satu event (mana yang lebih dulu)
    console.log('[Pairing] Menunggu server siap...');
    await serverReadyPromise;
    console.log('[Pairing] Server siap, meminta pairing code...');

    try {
      const code = await client.auth.requestPairingCode(cleaned);
      const formatted = String(code).match(/.{1,4}/g)?.join('-') || code;
      console.log('\n┌─────────────────────────────────┐');
      console.log(`│  Pairing Code: ${formatted.padEnd(17)}│`);
      console.log('└─────────────────────────────────┘');
      console.log('Masukkan kode ini di WhatsApp > Perangkat Tertaut > Tautkan Perangkat\n');
    } catch (e) {
      console.error('[Pairing Error]', e.message);
    }

    // Tunggu connect selesai (resolve setelah pairing berhasil)
    await connectPromise.catch((e) => {
      if (e?.message && !e.message.includes('paired')) {
        console.error('[Connect Error]', e.message);
      }
    });

  } else {
    // QR mode
    console.log('[QR] Menghubungkan, QR akan muncul sebentar...\n');
    await client.connect().catch((e) => {
      // Connect resolve setelah QR scan, error normal jika timeout
      if (!String(e?.message).includes('paired')) {
        console.error('[Connect Error]', e.message);
      }
    });
  }
}

start().catch(err => {
  console.error('[Fatal]', err.message || err);
  process.exit(1);
});
