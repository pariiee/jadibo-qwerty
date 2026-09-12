const fs = require('fs');
const src = fs.readFileSync('plugins/01-info.js', 'utf-8');

function grab(openTag, closeTag) {
  const i = src.indexOf(openTag);
  const j = src.indexOf(closeTag, i);
  return src.slice(i + openTag.length, j);
}

// ALL_COMMANDS array literal (dedupe — definisi pakai [...new Set([...])])
const acRaw = grab('const ALL_COMMANDS = [...new Set([', '])];');
const ALL_RAW = [...acRaw.matchAll(/'([^']+)'/g)].map(m => m[1]);
const ALL = [...new Set(ALL_RAW)];
const dupAll = ALL_RAW.filter((c, i) => ALL_RAW.indexOf(c) !== i);

// CATS object literal (semua nilai array)
const catRaw = grab('const CATS = {', '\n};');
const catBlocks = [...catRaw.matchAll(/(\w+):\s*\[([^\]]*)\]/g)];
const CATS = {};
for (const m of catBlocks) CATS[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map(x => x[1]);

const keys = Object.keys(CATS);
console.log('Kategori:', keys.length, '->', keys.join(', '));
const union = new Set();
for (const k of keys) for (const c of CATS[k]) union.add(c);
console.log('ALL_COMMANDS:', ALL.length, '(raw ' + ALL_RAW.length + ') | union CATS:', union.size);
if (dupAll.length) console.log('  duplikat di ALL_COMMANDS: ' + dupAll.join(', '));

const inAllNotCat = ALL.filter(c => !union.has(c));
const inCatNotAll = [...union].filter(c => !ALL.includes(c));
console.log('\n-- Di ALL_COMMANDS tapi TIDAK di kategori mana pun (' + inAllNotCat.length + ') --');
console.log(inAllNotCat.join(', '));
console.log('\n-- Di kategori tapi TIDAK di ALL_COMMANDS (' + inCatNotAll.length + ') --');
console.log(inCatNotAll.join(', '));

// Duplikasi antar kategori
const seen = {}; const dupes = [];
for (const k of keys) for (const c of CATS[k]) { if (seen[c]) dupes.push(c + ' (' + seen[c] + ' & ' + k + ')'); else seen[c] = k; }
console.log('\n-- Command dobel antar kategori (' + dupes.length + ') --');
console.log(dupes.join(', '));

// Simulasi render .menu all
const title = s => s.charAt(0).toUpperCase() + s.slice(1);
const blocks = Object.entries(CATS).map(([k, cmds]) => {
  const cols = [];
  for (let i = 0; i < cmds.length; i += 3) cols.push(cmds.slice(i, i + 3));
  return '╭┈〔 ' + title(k) + ' Menu 〕\n' +
    cols.map(col => '┊ ' + col.map((c, j) => (j === 0 ? '◈' : '·') + ' .' + c).join('│ ').padEnd(24 * 3)).join('\n') +
    '\n╰┈┈┈┈┈┈┈┈';
});
const allText = '╭┈〔 𝙈𝙀𝙉𝙐 𝘼𝙇𝙇 〕\n┊ ◈ Semua command (' + ALL.length + ' fitur)\n╰┈┈┈┈┈┈┈┈\n\n' + blocks.join('\n\n') + '\n\n> _Powered by YaaParBot_';
console.log('\n-- Panjang .menu all: ' + allText.length + ' chars --');
for (const k of keys) {
  const blk = blocks[Object.keys(CATS).indexOf(k)];
  console.log('  ' + k.padEnd(12), (blk ? blk.length : 0) + ' chars, ' + CATS[k].length + ' cmd');
}
