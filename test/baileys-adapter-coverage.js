// Self-check: adapter punya SEMUA metode yg dipanggil repo (27 metode).
// Kalau ada yg bolong, ini yg gagal — bukan nunggu error di VPS.
const { createClient } = require('../engine/baileys/client');
const { initAuthCreds } = require('baileys');

// ── metode yg benar-benar dipanggil engine+plugins (hasil grep repo) ─────────
const REQUIRED = {
  message: ['send', 'downloadBytes', 'reply', 'read', 'upload'],
  group: ['queryGroupMetadata', 'queryAllGroups', 'queryInviteCode', 'addParticipants',
          'promoteParticipants', 'demoteParticipants', 'setSubject', 'setDescription',
          'setSetting'],
  profile: ['getProfilePicture', 'setProfilePicture', 'setStatus'],
  privacy: ['blockUser'],
  newsletter: ['follow'],
  business: ['getVerifiedName'],
  auth: ['requestPairingCode'],
  stores: ['contacts'],
};

// createClient nggak nyentuh socket sebelum connect(), jadi aman dipanggil
// tanpa koneksi internet.
const auth = { creds: initAuthCreds(), keys: { get: async () => ({}), set: async () => {} } };
const client = createClient({ auth, saveCreds: () => {}, logger: { level: 'silent',
  child: () => ({ level: 'silent', info(){}, warn(){}, error(){}, debug(){}, trace(){} }),
  info(){}, warn(){}, error(){}, debug(){}, trace(){} } });

let pass = 0, fail = 0;
for (const [ns, methods] of Object.entries(REQUIRED)) {
  for (const m of methods) {
    const val = client[ns]?.[m];
    if (typeof val === 'function' || typeof val === 'object' && val !== null) { pass++; }
    else { console.log(`  MISS ${ns}.${m}`); fail++; }
  }
}

// API dasar yg dipakai engine langsung
for (const m of ['on', 'once', 'off', 'connect', 'disconnect', 'removeAllListeners']) {
  if (typeof client[m] === 'function') pass++; else { console.log(`  MISS ${m}`); fail++; }
}
// getter sock harus ADA dan nggak throw (null sebelum connect = normal)
try { const s = client.sock; pass++; } catch (e) { console.log('  MISS getter sock: ' + e.message); fail++; }

console.log(`\nbaileys-adapter-coverage: ${pass} ada, ${fail} bolong`);
process.exit(fail ? 1 : 0);
