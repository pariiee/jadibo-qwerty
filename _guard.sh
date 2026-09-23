#!/usr/bin/env bash
set -e
BASE=/root/.pm2
for p in jadibot yaparbots-worker create-canva cloudflared-jadibot; do
  f="$BASE/modules/.pm2-$p.pid"
  d="$BASE/modules/.pm2-$p.json" 2>/dev/null || true
  pm2 describe "$p" >/dev/null 2>&1 || { echo "  $p: nggak ada, skip"; continue; }
  pm2 restart "$p" --max-memory-restart 800M --update-env >/dev/null
  echo "  $p: di-restart dengan 800M"
done
pm2 save >/dev/null
echo "pm2 save: OK"
