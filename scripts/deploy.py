#!/usr/bin/env python
"""Pull + restart VPS dalam satu perintah. Pakai: py deploy.py

Pull doang nggak cukup: Node masih megang kode lama di memori, jadi WAJIB restart.
Perintah lain: py deploy.py --log   (lihat log bot)
Matiin auto-restart? Hapus file post-deploy.sh di VPS.

CATATAN: ini SALINAN dari ../deploy.py supaya ikut ter-commit. Salinan di luar
repo nggak punya riwayat, dan perubahan keamanan di sini gampang hilang.

KREDENSIAL SSH JANGAN ditaruh di file ini. Isi lewat salah satu:
  - file .vps / .vps.new di sebelah skrip (tidak di-commit, ada di .gitignore)
  - env VPS_HOST / VPS_PORT / VPS_PW
"""
import os, re, sys

def _vps_config():
    # Cari .vps di sebelah skrip INI, lalu naik ke atas sampai ketemu.
    # JANGAN berhenti di 1 level: skrip ini ada di <repo>/scripts/, sementara
    # .vps biasanya di root proyek yang satu-dua level di atasnya. Kalau
    # cuma naik 1 level, skrip GAGAL nemu .vps dan deploy mati dengan
    # "HOST VPS nggak ketemu" padahal file-nya ada.
    base = os.path.dirname(os.path.abspath(__file__))
    kandidat = [base]
    d = base
    for _ in range(4):                     # ponytail: maks 4 level naik
        d = os.path.dirname(d)
        if d and d != kandidat[-1]:
            kandidat.append(d)
    target = None
    for d in kandidat:
        for nama in (".vps.new", ".vps"):
            p = os.path.join(d, nama)
            if os.path.exists(p):
                target = p
                break
        if target:
            break
    cfg = {"HOST": "", "PORT": "22", "USER": "root", "PW": ""}
    if target:
        for line in open(target, encoding="utf-8").read().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                cfg[k.strip()] = v.strip().strip("\"'")
    if os.environ.get("VPS_HOST"): cfg["HOST"] = os.environ["VPS_HOST"]
    if os.environ.get("VPS_PORT"): cfg["PORT"] = os.environ["VPS_PORT"]
    if os.environ.get("VPS_PW"): cfg["PW"] = os.environ["VPS_PW"]
    return cfg

_cfg = _vps_config()
HOST, PORT, USER = _cfg["HOST"], int(_cfg["PORT"]), _cfg["USER"]
DIR = os.environ.get("VPS_DIR", "/var/www/jadibot")
# Folder backup SENGAJA di luar DIR (folder web) supaya dump nggak bisa diunduh
# lewat HTTP walau salah konfigurasi static server.
BDIR = os.environ.get("VPS_BACKUP_DIR", "/var/backups/jadibot")
APP = "jadibot"
WORKER = os.environ.get("WORKER_NAME", "yaparbots-worker")
MODE = sys.argv[1] if len(sys.argv) > 1 else ""


def _password():
    if _cfg.get("PW"):
        return _cfg["PW"]
    if HOST:
        sys.exit("Password SSH nggak ketemu. Isi .vps / .vps.new di sebelah skrip, atau set VPS_PW.")
    sys.exit("HOST VPS nggak ketemu. Isi .vps / .vps.new, atau set VPS_HOST.")


def main():
    import paramiko
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, port=PORT, username=USER, password=_password(), timeout=30)

    def run(cmd, show=True, timeout=600, check=False):
        _, o, e = c.exec_command(cmd, timeout=timeout)
        out = (o.read().decode(errors="replace") + e.read().decode(errors="replace")).strip()
        code = o.channel.recv_exit_status()
        if show:
            print(out[-1200:])
        if check and code != 0:
            print(f"GAGAL (exit {code}): {cmd}")
            c.close()
            sys.exit(code)
        return out

    if MODE == "--log":
        run("cd %s && pm2 logs %s --lines 40 --nostream" % (DIR, APP))
        return c.close()

    # Catat HEAD lama sebelum pull
    old_head = run("cd %s && git rev-parse HEAD" % DIR, show=False).strip()

    print("-- git pull --")
    r = run("cd %s && git pull --ff-only origin main" % DIR, check=False)
    KORUP = ("bad object", "reference broken", "unterminated line", "index file corrupt",
             "invalid sha1 pointer", "bad signature", "packed-refs",
             "unable to unpack", "data stream error", "loose object", "is corrupt")
    if any(k in r for k in KORUP):
        print("-- .git korup, dibenerin dulu --")
        run("cd %s/.git && rm -f packed-refs ORIG_HEAD FETCH_HEAD MERGE_HEAD && "
            "find refs -type f -size -2c -delete && rm -rf logs && rm -f index && "
            "git fetch origin main && git reset --hard FETCH_HEAD && git remote set-head origin main 2>/dev/null"
            % DIR, check=True)
    print("-- verifikasi HEAD --")

    def _sha(cmd):
        out = run("cd %s && %s" % (DIR, cmd), show=False)
        m = re.findall(r"\b[0-9a-f]{40}\b", out)
        return m[-1] if m else ""

    head, remote = _sha("git rev-parse HEAD"), _sha("git ls-remote origin main")
    if not head or not remote or head != remote:
        print("-- objeknya juga korup, .git dibangun ulang --")
        origin_url = run("cd %s && git config --get remote.origin.url" % DIR, show=False).strip()
        if origin_url.startswith("http") or origin_url.startswith("git@"):
            run("cd %s && rm -rf .git && git init -q && "
                "git config user.email deploy@local && git config user.name deploy && "
                "git remote add origin '%s' && git fetch origin main && git reset --hard FETCH_HEAD"
                % (DIR, origin_url), check=True)
            head, remote = _sha("git rev-parse HEAD"), _sha("git ls-remote origin main")
        else:
            print("URL remote nggak kebaca (%r), .git lama dibiarin." % origin_url[:60])
    if not head or not remote or head != remote:
        print("GAGAL: HEAD server %s != GitHub %s - KODE VPS MASIH LAMA, restart dibatalin."
              % (head[:7] or "?", remote[:7] or "?"))
        return c.close() or sys.exit(1)
    print("HEAD server = GitHub = %s" % head[:7])

    # Jalankan npm ci hanya jika package-lock.json berubah antara HEAD lama dan baru
    if old_head and re.match(r"^[0-9a-f]{40}$", old_head) and old_head != head:
        diff_lock = run("cd %s && git diff --name-only %s %s -- package-lock.json" % (DIR, old_head, head), show=False).strip()
        if "package-lock.json" in diff_lock:
            print("-- package-lock.json berubah, menjalankan npm ci --omit=dev --")
            run("cd %s && npm ci --omit=dev" % DIR, check=True)
        else:
            print("-- package-lock.json tidak berubah, npm ci dilewati --")

    # ── Backup DB SEBELUM sync-schema ────────────────────────────────────────
    # sync-schema.js menjalankan ALTER TABLE ke DB produksi. Tanpa backup, satu
    # ALTER yang salah tidak bisa dibatalkan. Backup GAGAL = deploy STOP: lebih
    # baik tidak migrasi sama sekali daripada migrasi tanpa jaring.
    #
    # Keamanan:
    #   - Password DB dibaca dari .env server, dikirim ke mysqldump lewat env
    #     MYSQL_PWD — BUKAN argumen `-p...`. Argumen command line terlihat oleh
    #     `ps` untuk semua user di mesin itu.
    #   - Dump di-chmod 600 dan ditulis ke folder DI LUAR folder web.
    #   - Gagal / dump 0 byte -> hentikan deploy sebelum menyentuh DB.
    print("-- backup DB --")
    bcmd = (
        'set -e; '
        'cd {dir}; '
        'DB_NAME=$(sed -n "s/^DB_NAME=//p" .env | head -1); '
        'DB_USER=$(sed -n "s/^DB_USER=//p" .env | head -1); '
        'DB_HOST=$(sed -n "s/^DB_HOST=//p" .env | head -1); '
        'DB_PORT=$(sed -n "s/^DB_PORT=//p" .env | head -1); '
        '[ -n "$DB_NAME" ] || {{ echo "DB_NAME kosong di .env"; exit 1; }}; '
        'umask 077; '
        'mkdir -p {bdir}; chmod 700 {bdir}; '
        'f={bdir}/$(date +%Y%m%d-%H%M%S)-$DB_NAME.sql.gz; '
        'MYSQL_PWD=$(sed -n "s/^DB_PASS=//p" .env | head -1) '
        '  mysqldump --single-transaction --quick --routines '
        '    -h"${{DB_HOST:-localhost}}" -P"${{DB_PORT:-3306}}" -u"${{DB_USER:-root}}" "$DB_NAME" '
        '  | gzip > "$f"; '
        'chmod 600 "$f"; '
        'test -s "$f" || {{ echo "BACKUP 0 BYTE"; rm -f "$f"; exit 1; }}; '
        'ls -l "$f"; echo "BACKUP OK: $f"; echo "PERM: $(stat -c %a "$f")"'
    ).format(dir=DIR, bdir=BDIR)
    bak = run(bcmd, check=True)
    if "BACKUP OK:" not in bak:
        print("GAGAL: backup DB tidak berhasil - sync-schema DIBATALKAN (DB tidak disentuh).")
        return c.close() or sys.exit(1)

    print("-- sync schema --")
    run("cd %s && [ -f scripts/sync-schema.js ] && node scripts/sync-schema.js" % DIR, check=True)
    print("-- restart --")
    # WORKER sengaja TIDAK di-restart bareng: di VPS ini cuma ada SATU proses PM2
    # (`jadibot`). Proses `yaparbots-worker` nggak pernah ada di main, jadi
    # `pm2 restart jadibot yaparbots-worker` selalu mencetak "[ERROR] Process or
    # Namespace yaparbots-worker not found" — bunyi galat di deploy yang sehat
    # bikin orang nggak percaya hasil deploy. Worker tetap didukung: set
    # WORKER_NAME kalau suatu hari prosesnya beneran ada.
    if os.environ.get("WORKER_NAME"):
        run("pm2 restart %s %s --update-env" % (APP, WORKER), check=True)
    else:
        # `--update-env` WAJIB, bukan hiasan. PM2 menyimpan salinan environment
        # saat proses pertama kali start; `pm2 restart` biasa memakai salinan
        # LAMA. Tanpa flag ini, menambah variabel di `.env` (mis.
        # QRISKU_API_KEY) lalu deploy ulang membuat kodenya tetap membaca nilai
        # lama — gejalanya "kunci sudah diisi tapi masih bilang belum diisi",
        # dan orang menghabiskan waktu mencurigai kodenya, bukan PM2-nya.
        run("pm2 restart %s --update-env" % APP, check=True)
    run("cd %s && [ -x ./post-deploy.sh ] && ./post-deploy.sh" % DIR, check=False)
    print("-- verifikasi PM2 describe jadibot --")
    run("pm2 describe %s" % APP, check=True)
    c.close()


if __name__ == "__main__":
    main()
