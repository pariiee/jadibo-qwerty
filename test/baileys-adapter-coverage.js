// Self-check: adapter punya SEMUA metode yg dipanggil repo.
// Kalau ada yg bolong, ini yg gagal — bukan nunggu error di VPS.
// Pelajaran: `queryGroupInviteInfo` bolong di sini padahal dipanggil
// controllers/botController.js → endpoint resolveInvite 400 terus tanpa ada yg
// sadar. Daftar ini harus hasil grep ulang tiap kali call-site baru muncul:
//   grep -rhoE "client\.(message|group|profile|privacy|newsletter|business|auth|stores)\.[a-zA-Z]+" \
//     --include=*.js engine plugins controllers | sort -u
const { createClient } = require('../engine/baileys/client');
const { initAuthCreds } = require('baileys');

// ── metode yg benar-benar dipanggil engine+plugins+controllers (hasil grep repo) ─
const REQUIRED = {
  message: ['send', 'downloadBytes', 'reply', 'read', 'upload'],
  group: ['queryGroupMetadata', 'queryAllGroups', 'queryInviteCode', 'queryGroupInviteInfo',
          'addParticipants', 'removeParticipants', 'promoteParticipants', 'demoteParticipants',
          'leaveGroup', 'joinGroupViaInvite', 'approveMembershipRequests',
          'setSubject', 'setDescription', 'setSetting'],
  profile: ['getProfilePicture', 'setProfilePicture', 'setStatus'],
  privacy: ['blockUser', 'unblockUser'],
  newsletter: ['follow'],
  business: ['getVerifiedName', 'getBusinessProfile'],
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
