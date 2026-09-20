"use strict";

/**
 * test/role-order.js
 * Ngunci urutan role di engine: dev > owner > premium > user.
 * Dulu `.limit` cuma baca kolom `premium` di DB -> owner + developer
 * kelihatan 'User biasa'.
 *
 * Jalankan: node test/role-order.js   (atau lewat `npm test`)
 */

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");

const root  = path.join(__dirname, "..");
const baca  = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const engine = baca("engine/whatsappEngine.js");
const info   = baca("plugins/01-info.js");
const mess   = require("../config/mess");

let lulus = 0;
function cek(nama, fn) {
  try { fn(); lulus++; console.log(`  \u2705 ${nama}`); }
  catch (e) { console.error(`  \u274c ${nama}\n     ${e.message}`); process.exitCode = 1; }
}

console.log("test/role-order.js");

cek("label role: cuma 4, urut dev > owner > premium > user", () => {
  const urut = Object.keys(mess.roleLabel);
  assert.deepStrictEqual(urut, ["dev", "owner", "premium", "user"],
    `urutan label salah: ${urut.join(" > ")}`);
  // admin grup itu hak per grup, bukan role
  assert.ok(!("admin" in mess.roleLabel), "admin nggak boleh jadi role");
});

cek("engine hitung ctx.role, dev menang atas owner", () => {
  assert.ok(/ctx\.role = ctx\.isDev/.test(engine), "ctx.role nggak dihitung di engine");
  // rantai ternary: isDev dulu, baru isOwner, isPremium — terakhir 'user'
  const blok = engine.slice(engine.indexOf("ctx.role ="));
  const urut = [...blok.slice(0, 400).matchAll(/ctx\.is(Dev|Owner|Premium|Admin)/g)].map((m) => m[1]);
  assert.deepStrictEqual(urut, ["Dev", "Owner", "Premium"],
    `urutan pengecekan role salah: ${urut.join(" > ")}`);
});

cek("nomor kosong nggak boleh lolos jadi owner/dev", () => {
  assert.ok(/const nomorPengirim = /.test(engine), "helper nomorPengirim nggak ada");
  // nomorPengirim harus nolak "" dan "0" -> dua nomor kosong nggak bisa `"" === ""`
  assert.ok(/senderNum && senderNum === ownerNum/.test(engine),
    "pembanding owner nggak pakai gerbang senderNum");
  assert.ok(/Boolean\(senderNum\) && DEV_NUMBERS\.has/.test(engine),
    "pembanding dev nggak pakai gerbang senderNum");
});

cek(".limit pakai ctx.role, bukan kolom premium mentah", () => {
  const i   = info.indexOf("case 'limit':");
  const blok = info.slice(i, i + 1600);
  assert.ok(/mess\.roleLabel\[ctx\.role\]/.test(blok), ".limit masih nggak baca ctx.role");
  assert.ok(!/isPrem \? '\*Premium\*/.test(blok), ".limit masih pakai ternary isPrem lama");
  assert.ok(!/const \{ name, lim, premium \}/.test(blok), ".limit masih ambil kolom premium");
  // dev/owner/premium -> lambang infinity, bukan angka limit yang nyisa
  assert.ok(/skipLim \? '\u267e\ufe0f'/.test(blok), "role yang skip limit harus tampil \u267e\ufe0f");
});

cek(".limit (perintah info) TIDAK menghabiskan limit user", () => {
  const blok = info.slice(info.indexOf("module.exports.limitedCmds"));
  assert.ok(!/'limit'/.test(blok.slice(0, 300)),
    "`limit` balik masuk limitedCmds — ngecek sisa limit malah ngurangin limit");
});

cek("cuma role user yang kena gate limit", () => {
  const blok = engine.slice(engine.indexOf("const kurangiLimit = async")).slice(0, 300);
  assert.ok(/ctx\.role !== 'user'/.test(blok),
    "gate limit nggak pakai ctx.role — dev/owner/premium bakal kehitung kena limit");
});

cek("potong limit: cek saldo dulu, potong di SQL, nggak bisa negatif", () => {
  assert.ok(/const kurangiLimit = async/.test(engine), "helper kurangiLimit nggak ada");
  const blok = engine.slice(engine.indexOf("const kurangiLimit = async")).slice(0, 1400);
  assert.ok(/kurangiLimit\(1\)/.test(engine), "gate utama harus potong 1");
  assert.ok(/lim = lim - \?/.test(blok), "potongnya masih `lim - 1` hardcoded");
  assert.ok(/AND lim >= \?/.test(blok),
    "UPDATE nggak digerbang `lim >= satuan` — saldo bisa nembus negatif");
  assert.ok(/curLim < satuan/.test(blok), "pre-check saldo nggak ada");
});

cek("auto-register nggak nge-reset saldo limit user lama", () => {
  // ON DUPLICATE KEY UPDATE ... lim = ? -> tiap command user lama balik ke default
  const blok = engine.slice(engine.indexOf("INSERT INTO rpg_members"));
  const oc = blok.slice(blok.indexOf("ON DUPLICATE KEY UPDATE"), blok.indexOf("ON DUPLICATE KEY UPDATE") + 260);
  // dulu: "registered = 1, level = 1, xp = 0, money = 0, lim = ?, healt = 100"
  assert.ok(!/level = 1, xp = 0, money = 0, lim = \?/.test(oc),
    "auto-register masih nge-reset limit di ON DUPLICATE KEY — user lama balik ke default tiap command");
  assert.ok(!/lim = \?/.test(oc),
    "auto-register nulis `lim = ?` di ON DUPLICATE KEY — saldo user lama ke-reset");
  assert.ok(/\blim, healt\)/.test(blok.slice(0, blok.indexOf("ON DUPLICATE KEY UPDATE"))),
    "INSERT-nya harus tetap nulis lim buat user baru");
});

cek(".menu & .bot pakai label role yang sama", () => {
  const owner = baca("plugins/05-owner.js");
  for (const [nama, isi] of [["menu", info], ["bot", owner]]) {
    assert.ok(/mess\.roleLabel\[ctx\.role\]/.test(isi), `${nama} nggak pakai mess.roleLabel`);
  }
});

cek("gate dev cuma satu sumber (ctx.isDev), bukan baca env sendiri", () => {
  for (const rel of ["plugins/09-jarvis.js", "plugins/10-crm.js"]) {
    assert.ok(!/process\.env\.DEVELOPER_NUMBER/.test(baca(rel)), `${rel} masih baca env sendiri`);
    assert.ok(/ctx\.isDev/.test(baca(rel)), `${rel} nggak pakai ctx.isDev`);
  }
});

cek("tiap command di limitedCmds punya handler (kalau nggak, limit kebuang diam-diam)", () => {
  const pluginsDir = path.join(root, "plugins");
  const ada = new Set();
  for (const f of fs.readdirSync(pluginsDir).filter((x) => x.endsWith(".js")).sort()) {
    const src = fs.readFileSync(path.join(pluginsDir, f), "utf8");
    for (const m of src.matchAll(/case\s+'([a-z0-9_]+)'/g)) ada.add(m[1]);
  }
  for (const rel of fs.readdirSync(pluginsDir).filter((x) => x.endsWith(".js")).sort()) {
    let mod; try { mod = require(path.join(pluginsDir, rel)); } catch { continue; }
    if (!(mod.limitedCmds instanceof Set)) continue;
    for (const c of mod.limitedCmds) {
      assert.ok(ada.has(c),
        `'${c}' (dari ${rel}) ada di limitedCmds tapi nggak punya case — limit kepotong tanpa balasan`);
    }
  }
});

console.log(`\n${lulus} lulus${process.exitCode ? ", ADA GAGAL" : ""}`);
