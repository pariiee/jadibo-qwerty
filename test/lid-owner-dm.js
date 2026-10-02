'use strict';
/**
 * test/lid-owner-dm.js
 *
 * BUG YANG DIJAGA: di CHAT PRIBADI (DM), pemilik bot tidak dikenali sebagai
 * owner. Di grup jalan, di DM tidak — karena satu-satunya sumber peta LID->nomor
 * ada di METADATA GRUP, dan DM tidak punya grup.
 *
 * Akibatnya (diam-diam, tanpa error):
 *   ctx.sender = '238xxx@lid' -> nomorPengirim() = '' -> isOwner = false
 *   -> role jadi 'user' -> command owner-only (`.backup`, `.broadcast`) DITOLAK
 *   -> `.limit` nampilin kuota paket, bukan akses penuh
 *
 * Tes ini menguji lewat JALUR PUBLIK (engine/jid.js), bukan menyalin logikanya,
 * supaya kalau kabelnya lepas lagi langsung merah.
 */

const path = require('path');

let gagal = 0;
const cek = (nama, syarat, info = '') => {
  if (syarat) console.log(`✅ ${nama}`);
  else { gagal++; console.log(`❌ ${nama}${info ? ' — ' + info : ''}`); }
};

const jid = require('../engine/jid');

const OWNER_NUM = '6285185963590';
const OWNER_PN  = `${OWNER_NUM}@s.whatsapp.net`;
const OWNER_LID = '238000111222333@lid';          // LID: angka internal WA, BUKAN nomor

// ─── nomorPengirim(): SALINAN PERSIS dari engine/whatsappEngine.js ─────────────
// Sengaja disalin, bukan diimpor: mengimpor whatsappEngine menarik seluruh
// engine (zapo, DB, cron) dan tes ini harus bisa jalan sendirian. Yang dijaga
// di sini adalah BENTUK gerbangnya — kalau gerbang di engine berubah (mis.
// gerbang LID dihapus), salinan ini jadi tidak cocok dan tes harus diperbarui
// BERSAMAAN. Itu memang tujuannya.
const isPn = (j) => String(j || '').endsWith('@s.whatsapp.net');
const nomorPengirim = (j) => {
  if (!isPn(j)) return '';                              // LID bukan nomor telepon
  const n = String(j || '').split('@')[0].split(':')[0];
  return /^\d{6,}$/.test(n) ? n : '';
};

(async () => {
  console.log('=== 0. Awal: peta masih kosong (simulasi DM pertama setelah restart) ===');
  cek('LID owner belum punya pasangan nomor', jid.lidToPn(OWNER_LID) === OWNER_LID, jid.lidToPn(OWNER_LID));
  cek('-> nomor pengirim kosong -> OWNER TIDAK DIKENALI',
    nomorPengirim(jid.lidToPn(OWNER_LID)) === '', `dapat '${nomorPengirim(jid.lidToPn(OWNER_LID))}'`);

  console.log('');
  console.log('=== 1. JALUR A: key pesan punya participantAlt (kabel yang dulu putus) ===');
  // Di DM: key.participant = LID pengirim, key.participantAlt = nomor aslinya.
  jid.cacheLidFromKey({
    participant:    OWNER_LID,
    participantAlt: OWNER_PN,
  });
  const lewatKey = jid.lidToPn(OWNER_LID);
  cek('cacheLidFromKey() memetakan LID -> nomor', lewatKey === OWNER_PN, lewatKey);
  cek('nomor pengirim terbaca dari key', nomorPengirim(lewatKey) === OWNER_NUM, nomorPengirim(lewatKey));

  console.log('');
  console.log('=== 2. Arah balik: nomor -> LID (buat mention/quote di DM) ===');
  cek('pnToLid() balik ke LID yang sama', jid.pnToLid(OWNER_PN) === OWNER_LID, jid.pnToLid(OWNER_PN));

  console.log('');
  console.log('=== 3. JALUR B: key TIDAK punya Alt -> fallback stores.contacts (DM) ===');
  // Percobaan ulang dari nol: peta dikosongkan lewat jid baru tidak bisa,
  // jadi pakai LID lain supaya benar-benar menguji jalur kontak.
  const LID2 = '238000999888777@lid';
  const PINDAI_DARI_AWAL = jid.lidToPn(LID2);
  cek('LID2 memang belum dipetakan', PINDAI_DARI_AWAL === LID2, PINDAI_DARI_AWAL);

  const klienPalsu = {
    stores: { contacts: { getByJid: async (j) => (j === LID2 ? { phoneNumber: OWNER_PN } : null) } },
    lid: { getPn: (j) => j }, // stub adapter zapo — SENGAJA tetap stub
  };
  const hasilB = await jid.lidToPnAsync(klienPalsu, LID2);
  cek('lidToPnAsync() lewat stores.contacts dapat nomor', hasilB === OWNER_PN, hasilB);
  cek('nomor pengirim terbaca dari kontak', nomorPengirim(hasilB) === OWNER_NUM, nomorPengirim(hasilB));

  console.log('');
  console.log('=== 4. GERBANG: LID mentah TIDAK boleh lolos jadi nomor ===');
  // Ini yang bikin semua orang jadi owner kalau gerbangnya hilang.
  cek('LID mentah -> nomorPengirim = "" (bukan angka 238xxx)',
    nomorPengirim(OWNER_LID) === '', `dapat '${nomorPengirim(OWNER_LID)}'`);
  cek('angka LID (238000111222333) TIDAK lolos gerbang 6 digit',
    nomorPengirim(OWNER_LID) !== String(OWNER_LID).split('@')[0],
    'LID lolos = bahaya: LID bukan nomor telepon');
  cek('jid kosong -> "" (bukan bikin semua orang owner)',
    nomorPengirim('') === '' && nomorPengirim(undefined) === '');

  console.log('');
  console.log('=== 5. Peserta grup: phoneNumber dipakai, lid TIDAK dipakai ===');
  jid.cacheLidFromMeta([
    { jid: '238555000111222@lid', phoneNumber: OWNER_PN },       // bentuk zapo
    { jid: '238666000111222@lid' },                               // tanpa phoneNumber -> dilewati
  ]);
  cek('peserta dengan phoneNumber terpetakan',
    jid.lidToPn('238555000111222@lid') === OWNER_PN, jid.lidToPn('238555000111222@lid'));
  cek('peserta tanpa phoneNumber TIDAK ditebak',
    jid.lidToPn('238666000111222@lid') === '238666000111222@lid');

  console.log('');
  console.log('=== 6. Jangan-jangan salah: LID orang LAIN tidak jadi nomor owner ===');
  const LID_ORANG = '238777777777777@lid';
  jid.cacheLidFromKey({ participant: LID_ORANG, participantAlt: '628999888777@s.whatsapp.net' });
  cek('LID orang lain -> nomornya sendiri, BUKAN nomor owner',
    nomorPengirim(jid.lidToPn(LID_ORANG)) === '628999888777',
    nomorPengirim(jid.lidToPn(LID_ORANG)));
  cek('LID orang lain tidak dikenali sebagai owner',
    nomorPengirim(jid.lidToPn(LID_ORANG)) !== OWNER_NUM);

  console.log('');
  console.log('=== 7. RANTAI PENUH: event zapo -> adapter -> peta -> owner dikenali ===');
  // INI akar sebenarnya. Adapter zapo dulu TIDAK menyalin `remoteJidAlt` /
  // `participantAlt` dari `event.key`, jadi cacheLidFromKey() selalu dapat
  // undefined dan peta LID->nomor kosong di DM. Uji ini mengikat keduanya:
  // kalau adapter berhenti menyalin field itu, bagian ini langsung merah.
  const LID3 = '238444555666777@lid';
  const PN3  = '628111222333@s.whatsapp.net';

  const adapterZapo = require('../engine/zapo/client');
  const eventZapo = {
    chatJid: LID3,                 // DM di-address pakai LID
    fromMe: false,
    id: '3EB0TEST',
    senderJid: LID3,
    pushName: 'Pak',
    message: { conversation: '.menu' },
    // WaIncomingMessageKey: alamat alternatif LID <-> PN
    key: { remoteJid: LID3, fromMe: false, id: '3EB0TEST', remoteJidAlt: PN3 },
  };

  const ternormalisasi = adapterZapo.normalizeIncoming(eventZapo);
  cek('adapter menyalin key.remoteJidAlt (tidak dibuang)',
    ternormalisasi.key.remoteJidAlt === PN3, String(ternormalisasi.key.remoteJidAlt));
  cek('adapter menyalin key.participantAlt saat ada',
    (() => {
      const ev2 = adapterZapo.normalizeIncoming({
        ...eventZapo, chatJid: '123@g.us',
        key: { remoteJid: '123@g.us', participant: LID3, participantAlt: PN3 },
      });
      return ev2.key.participantAlt === PN3;
    })());

  // Rantai penuh: key hasil adapter -> peta -> nomor terbaca -> cocok owner.
  cek('LID3 belum ada di peta sebelum key diproses', jid.lidToPn(LID3) === LID3);
  jid.cacheLidFromKey(ternormalisasi.key);
  cek('cacheLidFromKey(key hasil adapter) memetakan LID3', jid.lidToPn(LID3) === PN3, jid.lidToPn(LID3));
  cek('OWNER DIKENALI lewat rantai penuh',
    nomorPengirim(jid.lidToPn(LID3)) === '628111222333', nomorPengirim(jid.lidToPn(LID3)));

  console.log('');
  console.log('=== 8. KABEL ENGINE: buildContext() benar-benar memanggil cacheLidFromKey ===');
  // Bagian 7 menguji ADAPTER-nya, tapi tidak menguji apakah engine memanggil
  // cacheLidFromKey() dengan key itu. Tanpa uji ini, menghapus baris panggilan
  // di buildContext() LOLOS (sudah dibuktikan lewat mutation test). buildContext
  // tidak diekspor karena menarik seluruh engine saat di-require; yang bisa
  // dipastikan tanpa itu: fungsinya ada DAN dipanggil di buildContext.
  const srcEngine = require('fs').readFileSync(
    path.join(__dirname, '..', 'engine', 'whatsappEngine.js'), 'utf8'
  );
  const blokBuild = srcEngine.slice(srcEngine.indexOf('function buildContext'));
  const akhirBuild = blokBuild.indexOf('\nfunction ', 10);
  const isiBuild = akhirBuild === -1 ? blokBuild : blokBuild.slice(0, akhirBuild);

  cek('buildContext() memanggil cacheLidFromKey(key)',
    /^\s*cacheLidFromKey\(key\);/m.test(isiBuild), 'panggilan dihapus = peta LID kosong di DM');
  cek('cacheLidFromKey diimpor dari ./jid',
    /require\('\.\/jid'\)[\s\S]*?cacheLidFromKey/.test(srcEngine));
  cek('nomorPengirim() menolak bentuk LID (gerbang isPn)',
    /const nomorPengirim[\s\S]{0,400}?isPn\(jid\)/.test(srcEngine),
    'gerbang LID hilang = LID bisa dibandingkan sebagai nomor');

  console.log('');
  console.log(gagal ? `=== GAGAL: ${gagal} masalah ===` : '=== SEMUA CEK LULUS ===');
  process.exit(gagal ? 1 : 0);
})();
