'use strict';

/**
 * plugins/07-button.js
 * Command:  .button, .btn, .menu2, .list
 * Fitur:   Kirim interactive buttons / list menu via zapo-js raw proto
 *          + tangkap klik button/list response & proses sebagai command
 */

const { proto } = require('baileys');

// ── Handler ────────────────────────────────────────────────────────────────────

module.exports = async function buttonHandler(ctx) {
  const { client, command, args, jid, sender, isCmd, reply, react } = ctx;
  const message = ctx.msg?.message;

  // ═══════════════════════════════════════════════════════════════════════════════
  // 1. TANGKAP BUTTON RESPONSE (klik tombol user)
  // ═══════════════════════════════════════════════════════════════════════════════
  // Klik tombol balik dalam 2 bentuk: buttonsResponseMessage (biasa) atau
  // templateButtonReplyMessage — WA merender buttonsMessage legacy sebagai
  // template button, jadi kliknya masuk lewat selectedId, bukan selectedButtonId.
  const btnId =
    message?.buttonsResponseMessage?.selectedButtonId ||
    message?.templateButtonReplyMessage?.selectedId ||
    message?.templateButtonReplyMessage?.selectedButtonId ||
    '';

  if (btnId) {
    switch (btnId) {
      // ── Demo buttons ──────────────────────────────────────────────────────────
      case 'btn_ping':
        await reply('🏓 *Pong!* — Bot aktif & responsif.');
        return true;
      case 'btn_menu':
        // Reuse handler .menu — tampilan, kategori, dan audio ikut tersinkron
        return await require('./01-info')({ ...ctx, isCmd: true, command: 'menu', args: [] });
      case 'btn_all':
        // "All Menu" → daftar semua command (.menu all), bukan menu utama lagi
        return await require('./01-info')({ ...ctx, isCmd: true, command: 'menu', args: ['all'] });
      case 'btn_info':
        await reply(
          '🤖 *YaaParBot v1.0.0*\n\n' +
          'Multi-bot WhatsApp + Telegram gateway.\n' +
          'Dibangun dengan zapo-js & node-telegram-bot-api.'
        );
        return true;
      case 'btn_owner':
        // Reuse handler .owner — kirim kartu kontak, bukan teks doang
        return await require('./01-info')({ ...ctx, isCmd: true, command: 'owner', args: [] });

      // ── .test3 — tombol dropdown " MENU" (nativeFlow single_select) ──────────
      case 'test3_menu':
        return await require('./01-info')({ ...ctx, isCmd: true, command: 'menu', args: [] });
      case 'test3_owner':
        return await require('./01-info')({ ...ctx, isCmd: true, command: 'owner', args: [] });

      // ── Default — echo buttonId ───────────────────────────────────────────────
      default:
        // Button didyoumean (dym:*) bukan urusan plugin ini — biarkan plugin 08 handle
        if (btnId.startsWith('dym:')) return false;
        await reply(`✅ Tombol *"${btnId}"* ditekan!\n\nBalas dengan command biasa atau ketik \`.button\` untuk tombol lagi.`);
        return true;
    }
  }
  // ═══════════════════════════════════════════════════════════════════════════════
  // 2b. TANGKAP RESPON TOMBOL/LIST — satu handler untuk dua bentuk respons
  //     (interactiveResponseMessage native-flow & listResponseMessage lama).
  //     Tambah baris baru cukup di sini; dulu ada 2 switch kembar yang harus
  //     diubah dua kali, dan lupa satu bikin baris jatuh ke default.
  // ═══════════════════════════════════════════════════════════════════════════════
  const handleRowId = async (rowId) => {
    if (!rowId) return false;
    // Baris dropdown `.menu` → re-dispatch `.menu <kategori>` (handler yang sama)
    const cat = /^menu_cat:(\w+)$/.exec(rowId);
    if (cat) return await require('./01-info')({ ...ctx, isCmd: true, command: 'menu', args: [cat[1]] });

    switch (rowId) {
      case 'lst_ping': await reply('🏓 Pong!'); return true;
      // Baris dropdown .test3 pakai id command langsung ('.menu' dsb)
      case '.menu':    return await require('./01-info')({ ...ctx, isCmd: true, command: 'menu', args: [] });
      case 'lst_menu': await reply('📋 Ketik `.menu` untuk daftar command.'); return true;
      case 'lst_info':
        await reply('🤖 *YaaParBot* — multi-bot WhatsApp + Telegram gateway.');
        return true;
      case 'btn_menu':
        return await require('./01-info')({ ...ctx, isCmd: true, command: 'menu', args: [] });
      case 'btn_owner':
        return await require('./01-info')({ ...ctx, isCmd: true, command: 'owner', args: [] });
      default:
        await reply(`✅ Opsi *"${rowId}"* dipilih.`);
        return true;
    }
  };

  if (message?.interactiveResponseMessage) {
    let rowId = '';
    try {
      rowId = JSON.parse(message.interactiveResponseMessage.nativeFlowResponseMessage?.paramsJson || '{}').id || '';
    } catch { /* paramsJson bukan JSON valid */ }
    return await handleRowId(rowId);
  }

  if (message?.listResponseMessage) {
    return await handleRowId(message.listResponseMessage.singleSelectReply?.selectedRowId || '');
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 3. COMMAND NORMAL — kirim buttons / list menu
  // ═══════════════════════════════════════════════════════════════════════════════
  if (!isCmd) return false;

  switch (command) {

    // ── .button / .btn — quick-reply buttons (maks 3) ───────────────────────────
    case 'button':
    case 'btn':
    case 'testbtn': {
      try {
        await client.message.send(jid, {
          buttonsMessage: {
            contentText:   'Pilih menu di bawah ini:',
            footerText:    ctx.botData?.footer_text || 'YaaParBot',
            headerType:    proto.Message.ButtonsMessage.HeaderType.TEXT,      // 2
            text:          '🤖 *Menu Utama*',
            buttons: [
              {
                buttonId:   'btn_ping',
                buttonText: { displayText: '🏓 Ping' },
                type:       proto.Message.ButtonsMessage.Button.Type.RESPONSE, // 1
              },
              {
                buttonId:   'btn_menu',
                buttonText: { displayText: '📋 Menu' },
                type:       proto.Message.ButtonsMessage.Button.Type.RESPONSE,
              },
              {
                buttonId:   'btn_info',
                buttonText: { displayText: 'ℹ️ Info' },
                type:       proto.Message.ButtonsMessage.Button.Type.RESPONSE,
              },
            ],
          },
        });
      } catch (e) {
        await reply(`❌ Gagal kirim buttons: ${e.message}`);
      }
      return true;
    }

    // ── .btntest — 3 bentuk output WA, buat nunjuk yang paling pas ─────────────
    //  A buttonsMessage legacy (tombol asli, WA render jadi baris full-width)
    //  B interactiveMessage quick_reply (native-flow, kotak di dalam bubble + ikon)
    //  C teks biasa `[ 📋 Menu ] [ 👑 Owner ]` (sebaris, TIDAK bisa diklik)
    // Catatan: templateMessage TIDAK dipakai — zapo-js tidak menyisipkan node
    // <biz> untuk kind itu (resolveButtonAddonKindFrom), jadi bakal mental.
    case 'btntest': {
      const variants = [
        ['A — tombol legacy (buttonsMessage)', { buttonsMessage: {
          contentText: 'Pilih menu:',
          footerText:  'YaaParBot',
          headerType:  proto.Message.ButtonsMessage.HeaderType.EMPTY,
          buttons: [
            { buttonId: 'btn_menu',  buttonText: { displayText: '📋 Menu'  }, type: proto.Message.ButtonsMessage.Button.Type.RESPONSE },
            { buttonId: 'btn_owner', buttonText: { displayText: '👑 Owner' }, type: proto.Message.ButtonsMessage.Button.Type.RESPONSE },
          ],
        } }],
        ['B — tombol native-flow (interactiveMessage)', { interactiveMessage: {
          body:   { text: 'Pilih menu:' },
          footer: { text: 'YaaParBot' },
          nativeFlowMessage: {
            buttons: [
              { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '📋 Menu',  id: 'btn_menu'  }) },
              { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '👑 Owner', id: 'btn_owner' }) },
            ],
            messageParamsJson: '{}',
          },
        } }],
      ];
      for (const [label, payload] of variants) {
        await reply(`▶️ *${label}*`);
        await client.message.send(jid, payload);
        await new Promise(r => setTimeout(r, 2500));
      }
      // C — teks mentah, sebaris, persis gaya [menu] [owner]
      await reply('▶️ *C — teks biasa (nggak bisa diklik)*');
      await reply('[ 📋 Menu ]   [ 👑 Owner ]');
      await reply('☝️ Balas *A*, *B*, atau *C* — mana yang bentuknya kayak yang lu mau.');
      return true;
    }

    // ── .listbtn — dropdown native-flow (single_select) + CTA, buat test di grup ─
    case 'listbtn': {
      try {
        await client.message.send(jid, {
          interactiveMessage: {
            header: { title: '🎛️ DEMO INTERACTIVE BUTTONS', hasMediaAttachment: false },
            body: {
              text: 'Selamat datang di test *Interactive Native Flow Buttons*!\n\nPilih salah satu demo tombol di dropdown bawah:',
            },
            footer: { text: ctx.botData?.footer_text || 'YaaParBot' },
            nativeFlowMessage: {
              buttons: [
                {
                  name: 'single_select',
                  buttonParamsJson: JSON.stringify({
                    title: 'Pilih Demo Tombol ▾',
                    sections: [
                      {
                        title: '🌟 FITUR TOMBOL',
                        rows: [
                          { title: '1. Ping',              description: 'Cek status bot',            id: 'lst_ping' },
                          { title: '2. Menu Utama',        description: 'Lihat daftar command',      id: 'lst_menu' },
                          { title: '3. Info Bot',          description: 'Info bot & owner',          id: 'lst_info' },
                        ],
                      },
                    ],
                  }),
                },
                {
                  name: 'cta_url',
                  buttonParamsJson: JSON.stringify({
                    display_text: '🌐 Kunjungi Website',
                    url: 'https://yapari.web.id',
                    merchant_url: 'https://yapari.web.id',
                  }),
                },
              ],
            },
          },
        });
      } catch (e) {
        await reply(`❌ Gagal kirim interactive: ${e.message}`);
      }
      return true;
    }

    // ── .cekbisnis — cek apakah akun (bisa di-reply) WA Business ────────────────
    case 'cekbisnis':
    case 'checkbiz': {
      try {
        // Kalau command di-reply ke pesan orang → cek nomor pemilik pesan itu
        const qmsg = message?.extendedTextMessage?.contextInfo?.quotedMessage ||
                     (message?.contextInfo?.quotedMessage) || null;

        // Siapa yang mau dicek: reply → pemilik pesan di-reply; tanpa reply → nomor bot sendiri
        const creds = client.getCurrentCredentials?.() || client.getCredentials?.() || {};
        // Normalize: strip device suffix (:xx) + domain, bandingkan bare number-nya
        const bare = (j) => String(j || '').split(':')[0].split('@')[0];
        const meLid = bare(creds.meLid);
        const mePn  = bare(creds.meJid || sender);
        const mePnjid = creds.meJid || sender;
        const quotedSenderRaw = qmsg
          ? (message?.extendedTextMessage?.contextInfo?.participant ||
             (message?.contextInfo?.participant) || '')
          : '';
        const quotedSender = quotedSenderRaw.split(':')[0]; // keep domain buat query
        const quotedBare = bare(quotedSenderRaw);

        console.log('[cekbisnis] meLid=' + meLid + ' mePn=' + mePn + ' quoted=' + quotedSender);

        // Resolve LID → PN: kalau bare number sama dgn meLid → itu bot sendiri → pakai PN
        const isSelf = quotedBare && quotedBare === meLid;
        const target = quotedSender
          ? (isSelf ? mePnjid : quotedSender)
          : mePnjid;
        const who = quotedSender
          ? (isSelf ? 'nomor bot sendiri (dari reply)' : 'nomor yang di-reply')
          : 'nomor bot sendiri';

        await reply(`🔎 Cek status bisnis untuk *${target}* (${who})...`);
        let biz = null, vn = null;
        try {
          const prof = await client.business.getBusinessProfile([target]);
          biz = prof?.[0];
        } catch (e) { biz = { error: e.message }; }
        try {
          vn = await client.business.getVerifiedName(target);
        } catch (e) { vn = { error: e.message }; }

        const bizOk = !biz?.error && biz && (Object.keys(biz).length > 0);
        const vnName = vn && !vn.error ? vn.verifiedName || vn.verifiedNameCertificate?.details?.verifiedName : null;

        let out = '🏢 *Cek WA Business*\n\n';
        out += `Nomor: *${target}*\n`;
        out += `Objek: ${who}\n\n`;
        out += bizOk
          ? `✅ Business profile: *ADA*${JSON.stringify(biz).slice(0,200)}`
          : `❌ Business profile: *TIDAK ADA* (${biz?.error || 'kosong'})`;
        out += '\n';
        out += vnName
          ? `✅ Verified name: *${vnName}*`
          : `❌ Verified name: *tidak ada*`;
        out += '\n\n';
        out += bizOk || vnName
          ? '➡️ Akun ini *WA Business*.'
          : '➡️ Akun ini *BUKAN* WA Business (regular). List menu (`.list`) memang ditolak WhatsApp untuk akun regular.';

        await reply(out);
      } catch (e) {
        await reply(`❌ Gagal cek bisnis: ${e.message}`);
      }
      return true;
    }

    // ── .testlistself — kirim list ke nomor bot sendiri (test companion-block) ──
    case 'testlistself': {
      try {
        const creds = client.getCurrentCredentials?.() || client.getCredentials?.() || {};
        const mePnjid = creds.meJid || sender;
        await client.message.send(mePnjid, {
          listMessage: {
            title:       'Menu Self-Test',
            description: 'List ke nomor sendiri',
            buttonText:  'Lihat Menu',
            footerText:  'self-test',
            listType:    proto.Message.ListMessage.ListType.SINGLE_SELECT,
            sections: [
              { title: 'Info', rows: [ { rowId: 'lst_ping', title: 'Ping', description: 'Cek status bot' } ] },
            ],
          },
        });
        await reply('✅ List ke self-chat TERKIRIM (companion tidak diblokir total)');
      } catch (e) {
        await reply(`❌ List ke self-chat GAGAL: ${e.message}`);
      }
      return true;
    }

    // ── .testlistdm — kirim list ke DM pengirim (test: grup vs 1:1) ─────────────
    case 'testlistdm': {
      try {
        const targetDm = sender; // di grup = PN pengirim; di 1:1 = jid chat
        await client.message.send(targetDm, {
          listMessage: {
            title:       'Menu DM-Test',
            description: 'List ke DM pengirim',
            buttonText:  'Lihat Menu',
            footerText:  'dm-test',
            listType:    proto.Message.ListMessage.ListType.SINGLE_SELECT,
            sections: [
              { title: 'Info', rows: [ { rowId: 'lst_ping', title: 'Ping', description: 'Cek status bot' } ] },
            ],
          },
        });
        await reply(`✅ List ke DM *${targetDm}* TERKIRIM`);
      } catch (e) {
        await reply(`❌ List ke DM GAGAL: ${e.message}`);
      }
      return true;
    }

    // ── .menu2 / .list — list menu (dropdown, maks 10 baris per section) ────────
    case 'menu2':
    case 'list':
    case 'testlist': {
      // WhatsApp nolak listMessage di GROUP (479/respond sukses tapi di-drop).
      // Di DM, chat bisa ke-address pake LID → resolve ke PN dulu (list butuh PN).
      // Strategi: grup → buttons langsung; DM → list (setelah LID→PN).
      let sendTo = jid;
      const isGroupSend = String(jid).endsWith('@g.us');
      if (!isGroupSend && String(jid).endsWith('@lid') && client.stores?.contacts?.getByJid) {
        try {
          const rec = await client.stores.contacts.getByJid(jid);
          if (rec?.phoneNumber) sendTo = rec.phoneNumber;
        } catch { /* fallback ke jid */ }
      }
      const sendList = (to) => client.message.send(to, {
        listMessage: {
          title:       'Menu',
          description: 'Pilih salah satu opsi',
          buttonText:  'Lihat Menu',
          footerText:  ctx.botData?.footer_text || 'YaaParBot',
          listType:    proto.Message.ListMessage.ListType.SINGLE_SELECT,
          sections: [
            {
              title: 'Info',
              rows: [
                { rowId: 'lst_ping', title: 'Ping',        description: 'Cek status bot' },
                { rowId: 'lst_menu', title: 'Menu Utama',  description: 'Lihat daftar command' },
                { rowId: 'lst_info', title: 'Info Bot',    description: 'Info bot dan owner' },
              ],
            },
          ],
        },
      });

      if (isGroupSend) {
        // Grup: WhatsApp di-drop listMessage dari companion → langsung buttons
        await client.message.send(jid, {
          buttonsMessage: {
            contentText: '📋 *Menu Utama*',
            footerText:  ctx.botData?.footer_text || 'YaaParBot',
            headerType:  proto.Message.ButtonsMessage.HeaderType.TEXT,
            buttons: [
              { buttonId: 'btn_ping', buttonText: { displayText: '🏓 Ping' }, type: proto.Message.ButtonsMessage.Button.Type.RESPONSE },
              { buttonId: 'btn_menu', buttonText: { displayText: '📋 Menu' }, type: proto.Message.ButtonsMessage.Button.Type.RESPONSE },
              { buttonId: 'btn_info', buttonText: { displayText: 'ℹ️ Info' }, type: proto.Message.ButtonsMessage.Button.Type.RESPONSE },
            ],
          },
        });
      } else {
        try {
          await sendList(sendTo);
        } catch (e) {
          console.error('[list] error asli:', e.message, e.code || '');
          await reply(`❌ Gagal kirim list menu: ${e.message}`);
        }
      }
      return true;
    }
  }

  return false;
};