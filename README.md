# qwertygate

Multi-tenant WhatsApp, Telegram and Discord bot gateway. Node.js 18+ with Express 4, MySQL/MariaDB, SQLite session storage, Redis integration and static HTML interfaces. WhatsApp uses zapo-js; Telegram uses node-telegram-bot-api; Discord uses discord.js.

## Layout and features

- `server.js`: HTTP routes, WebSocket subscriptions, startup and scheduled tasks.
- `controllers/`, `routes/`, `middleware/`: account authentication, bot ownership, administration and billing endpoints.
- `config/`: database pool, roles, pricing and default messages.
- `engine/`: platform engines, plugins, notifications, email, billing and quota enforcement.
- `plugins/`: platform commands, moderation, games, tools and per-bot backups.
- `public/`: landing, authentication, dashboard, profile, billing and administration pages.
- `schema.sql`, `scripts/sync-schema.js`: database initialization and compatibility migrations.
- `test/`: standalone Node assertions and integration checks; some require databases or live services.

Accounts, bots, subscriptions, wallet balances, orders, settings, statistics and bot logs are persisted in MySQL. Bot ownership must be checked before accessing private bot resources. Wallet mutations must remain transactional. Custom bot names and footer values are user data, not branding migration targets. Database names, repository/folder names, package identifiers and PM2 process names are intentionally unchanged.

## Setup

Install Node.js 18+ and MySQL/MariaDB, provision a database and import `schema.sql`. Install dependencies with `npm ci`, configure a private `.env`, then run `npm start` (`npm run dev` for development). Review `scripts/sync-schema.js` against a verified database backup before running it on an existing installation.

Environment: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME`, strong `JWT_SECRET`, `PORT`, `BASE_URL`; Google login additionally uses `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`. Email and platform integrations require their corresponding provider credentials. Never commit `.env`, pairing sessions or SSH credentials. Production public origin: `https://labs.yapari.web.id`.

## Security checks

Google login endpoints `/api/auth/google` and `/api/auth/google/callback` bind authorization to a cryptographically random 32-byte state cookie: HttpOnly, SameSite=Lax, HTTPS Secure, scoped to `/api/auth/google`, ten-minute browser expiry. Callback rejects missing, malformed or mismatched state before token exchange and clears the cookie. Starting a second login replaces the first browser state.

WebSocket `subscribe_user` now checks the database `token_version`, just like `subscribe`; deleted users, revoked tokens and database failures are rejected before subscription. This check occurs on subscription, not continuously on an already-established connection.

Run focused checks:

```sh
node test/oauth-state.js
node test/ws-token-version.js
node test/csrf-origin.js
node test/sesi-password.js
node test/public-js-syntax.js
```

`npm test` runs all tests, including live integrations. The previously reported hang in `test/halaman-bot-slug.js` is not resolved by this batch; do not represent a focused run as a complete-suite pass.

## Box D deployment and backups

Existing production location stays `/var/www/jadibot`, PM2 app stays `jadibot`. `scripts/deploy.py` reads private SSH configuration and implements pull, backup, schema synchronization and restart. Its automatic destructive Git recovery and legacy shell backup pipeline require care; use a guarded fast-forward deployment when unrelated server changes exist. Do not reset production worktrees or overwrite sessions.

Run the root-only backup with `node /var/www/jadibot/scripts/backup-db.js`. It reads only the database name from the private `.env`, uses MariaDB root socket authentication, checks mysqldump exit status and nonempty SQL, compresses, verifies with `gzip -t`, then publishes a mode-0600 archive under mode-0700 `/var/backups/jadibot`. Failed partial files are removed. Only successful `daily-*.sql.gz` archives older than 14 days are pruned; other backups are preserved.

Root cron runs daily at 02:17 server time through `flock` to prevent overlapping scheduled jobs. Cron output goes to `/var/log/jadibot-db-backup.log`. Verify cron service, archive permissions and an actual successful run after installation. Gzip integrity does not prove database restore compatibility; periodically test restoration to an isolated database. These are **local backups only**: loss of the host or its disk also loses the backups. Off-host encrypted copies remain necessary for host-loss recovery.
