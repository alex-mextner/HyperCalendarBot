# Deployment Guide

## Server

Since 2026-10-09 22:30 UTC (#784):

- **Host**: `root@odroidn2` — home ODROID-N2+ (Tailscale MagicDNS name), aarch64, Armbian trixie
- **Deploy path**: `/opt/hypercal`
- **Domain**: hypercal.invntrm.ru — DNS still points at the DigitalOcean droplet `104.248.84.190`, whose
  Caddy (auto-TLS) proxies the bot paths to the odroid's Tailscale Funnel `https://odroidn2.tailbfe8ea.ts.net`.
  The droplet runs no bot container; it keeps the ingress and the external watchdog cron.

## Stack

| Component | How |
|-----------|-----|
| Bot | Docker container (ghcr.io/alex-mextner/hypercalendarbot, linux/arm64, pinned by commit SHA) |
| Redis | Docker container (redis:7-alpine, AOF persistence) |
| Reverse proxy | Caddy on the DO droplet → Tailscale Funnel on the odroid |
| Orchestration | Docker Compose v2 plugin |
| CI/CD | GitHub Actions → arm64 build on `ubuntu-24.04-arm` → GHCR + release artifact → self-hosted odroid runner → root activation wrapper |

## Initial Server Setup

One-time steps for a fresh server.

### 1. Prerequisites

Docker Engine with the Compose v2 plugin: `docker compose version` must work as root.

Ingress is the DO droplet's Caddy plus Tailscale Funnel on the odroid (section 4); the odroid runs no
Caddy for this bot.

### 2. Create deploy directory

```bash
mkdir -p /opt/hypercal/data /opt/hypercal/logs /opt/hypercal/scripts
```

### 3. Configure .env

Create it root-only, then fill in real values from `.env.example`:

```bash
install -m 600 -o root -g root /dev/null /opt/hypercal/.env
```

Required variables:
- `BOT_TOKEN` — Telegram bot token from @BotFather
- `ANTHROPIC_API_KEY` — Anthropic API key (or proxy key if using AI_BASE_URL)
- `BOT_ADMIN_ID` — your Telegram user ID (for feedback/intent verification)

Optional but recommended:
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ENCRYPTION_KEY` — for Google Calendar sync
- `PUBLIC_DOMAIN=hypercal.invntrm.ru` — required for OAuth redirect
- `GOOGLE_REDIRECT_URI=https://hypercal.invntrm.ru/oauth/google/callback`

Note: `REDIS_URL` and `NODE_ENV` are overridden by docker-compose.yml — values in .env are ignored for these. `REDIS_PASSWORD` is used only to build `REDIS_URL` and the redis container's auth; the bot container gets it blanked. Keep `.env` at mode `0600` (see `docs/reference/deploy-runbook.md`).

### 4. DNS and ingress

`hypercal.invntrm.ru` stays an A record to `104.248.84.190`. The repo `Caddyfile` is the DO Caddy
config, applied by hand there; the odroid exposes the bot to it through Tailscale Funnel.

### 5. Deploy runner

No SSH secrets. The `deploy` job runs on the self-hosted runner `odroid-hcb` on the odroid; its setup
(user, labels, sudoers line, activation wrapper) is in `docs/reference/deploy-runbook.md`, "Odroid runner".

### 6. Telegram MTProto (optional)

**Personal connection.** `/connect_telegram` lets a user send their invitations from their own Telegram
account. It needs `MTPROTO_API_ID`, `MTPROTO_API_HASH` (from https://my.telegram.org) and
`TELEGRAM_SESSION_MASTER_KEY` in the env file; the Pyrogram venv is built into the image (see the deploy
runbook, "Connect Telegram").

**Service tier** (restored 2026-09-30 behind `ServiceTier`, no service sends — #753). A dedicated service
account enables @username resolution, profile lookup, group member listing, birthday auto-sync and
voice-call reminders. It never sends messages; invitations go Bot API → the inviter's own session → a deep
link to the inviter (proposals and secretary DMs: Bot API → a deep link). It is off unless configured — prod has never set
`MTPROTO_SERVICE_USER_ID` — and Telegram may block such accounts. To enable it, run on the host
(interactive terminal):

```bash
cd /opt/hypercal
uv venv --python 3.12 venv
uv pip install -r pyproject.toml --python venv/bin/python
# Voice calls only: build patched ntgcalls (5+ min, needs 5GB RAM)
./scripts/build-patched-ntgcalls.sh python3.12 venv
# Interactive auth of the designated service account — creates data/voice_caller.session
venv/bin/python scripts/pyrogram-auth.py
```

Then set `MTPROTO_SERVICE_USER_ID` to that account's numeric Telegram ID (plus `DEEPGRAM_API_KEY` for
live calls; `DISABLE_VOICE=true` opts out of calls). An ordinary user's stored Telegram authorization is
never copied into this session.

`src/services/telegram-session/service-tier.ts` is the only gate: at startup it requires the API
credentials, a positive `MTPROTO_SERVICE_USER_ID`, the session file, and a `scripts/check-session.py`
probe (read-only `connect`/`get_me`/`disconnect`) reporting exactly that ID, and logs
`MTProto service tier enabled` or `MTProto service tier disabled` with the reason
(`service_user_id_unset`, `service_user_id_invalid`, `api_credentials_missing`, `session_missing`,
`probe_failed`, `identity_mismatch`). Only that module names the service scripts (`resolve-username.py`,
`get-user-info.py`, `get-chat-members.py`, `fetch-birthdays.py`, `voice-call-bridge.py`); each of them
re-checks the identity via `start_service_session` and serializes on `mtproto_lock.py`. With the tier off,
`find_user` / `send_invitation` use the local `users` table and otherwise the picker, group members come
from `group_members`, and birthday sync and voice calls are off. `pyrogram-auth.py` is the operator's
manual bootstrap — never run from service startup or as recovery from a user's stored credentials.


## CI/CD Pipeline

On every push to `main` (`.github/workflows/deploy.yml`):

1. **test** — `bun test`, lint, typecheck (ubuntu-latest)
2. **build** — linux/arm64 image → push to ghcr.io; `docker save` release artifact + checksums (ubuntu-24.04-arm)
3. **deploy** — odroid runner downloads the artifact, checks main still points at the commit, and runs
   `sudo -n /usr/local/sbin/hypercal-activate-release`, which hands a root-owned copy to
   `scripts/deploy-prebuilt-image.sh` (checksum, identity, schema gate, backup, rollback)

## Manual Deploy

`scripts/deploy-local-fallback.sh` builds the exact `origin/main` commit locally as linux/arm64 and runs
the same activator on `root@odroidn2`; see the deploy runbook, "Local deploy fallback".

## Monitoring

```bash
# Logs
ssh root@odroidn2 'docker compose -f /opt/hypercal/docker-compose.yml logs -f bot'
ssh root@odroidn2 'docker compose -f /opt/hypercal/docker-compose.yml logs -f redis'

# Health check
curl https://hypercal.invntrm.ru/health

# Container status
ssh root@odroidn2 'docker compose -f /opt/hypercal/docker-compose.yml ps'

# Caddy logs (ingress, on the DO droplet)
ssh root@104.248.84.190 'tail -f /var/log/caddy/hypercal.invntrm.ru.log'
```

## Resource Limits

Configured in docker-compose.yml:

| Service | Memory | CPU |
|---------|--------|-----|
| bot | 1 GB | 1.5 cores |
| redis | 256 MB | 0.5 cores |

## Redis Persistence

Redis runs with AOF (Append Only File):
- `appendonly yes` — log every write
- `appendfsync everysec` — fsync once per second (balance of durability and performance)
- Data survives container restarts via `redis-data` named volume
