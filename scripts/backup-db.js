const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dotenv = require('dotenv');

function backup() {
  const config = dotenv.parse(fs.readFileSync(path.join(__dirname, '..', '.env')));
  if (!/^[a-zA-Z0-9_]+$/.test(config.DB_NAME || '')) throw Error('Invalid DB_NAME');
  const directory = '/var/backups/jadibot';
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const name = `daily-${new Date().toISOString().replace(/[:.]/g, '-')}-${config.DB_NAME}.sql`;
  const temporary = path.join(directory, name + '.partial');
  const target = path.join(directory, name + '.gz');
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    const dump = spawnSync('mysqldump', ['--protocol=socket', '-uroot', '--single-transaction', '--quick', '--routines', '--events', '--triggers', '--databases', config.DB_NAME], { stdio: ['ignore', fd, 'pipe'] });
    fs.closeSync(fd);
    if (dump.error || dump.status !== 0 || fs.statSync(temporary).size === 0) throw Error('Database dump failed');
    const compressed = spawnSync('gzip', ['-f', temporary], { stdio: 'pipe' });
    if (compressed.error || compressed.status !== 0) throw Error('Compression failed');
    const verify = spawnSync('gzip', ['-t', temporary + '.gz'], { stdio: 'pipe' });
    if (verify.error || verify.status !== 0) throw Error('Gzip verification failed');
    fs.renameSync(temporary + '.gz', target);
    fs.chmodSync(target, 0o600);
    for (const entry of fs.readdirSync(directory)) {
      if (!/^daily-.*\.sql\.gz$/.test(entry)) continue;
      const file = path.join(directory, entry);
      if (fs.lstatSync(file).isFile() && fs.statSync(file).mtimeMs < Date.now() - 14 * 86400000) fs.unlinkSync(file);
    }
    console.log(`BACKUP OK ${target} bytes=${fs.statSync(target).size} mode=600 gzip=verified retention=14days`);
  } finally {
    try { fs.closeSync(fd); } catch {}
    for (const file of [temporary, temporary + '.gz']) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

try { backup(); } catch (error) { console.error(error.message); process.exitCode = 1; }
