# Deployment Guide

## Server

- **Provider**: Digital Ocean
- **Host**: 104.248.84.190
- **User**: www-data
- **Deploy path**: /var/www/hypercal.invntrm.ru
- **Domain**: hypercal.invntrm.ru (Caddy auto-TLS via Let's Encrypt)

## Stack

| Component | How |
|-----------|-----|
| Bot | Docker container (ghcr.io/alex-mextner/hypercalendarbot:latest) |
| Redis | Docker container (redis:7-alpine, AOF persistence) |
| Reverse proxy | Caddy (host-level, auto-HTTPS) |
| Orchestration | docker-compose v1 (1.29.2) |
| CI/CD | GitHub Actions → build image → push to GHCR → SSH deploy |

## Initial Server Setup

One-time steps for a fresh server.

### 1. Prerequisites

```bash
# Docker
apt-get update && apt-get install -y docker.io docker-compose

# Caddy
apt-get install -y caddy

# Ensure /etc/caddy/Caddyfile imports per-site configs:
#   import /var/www/*/Caddyfile
```

### 2. Create deploy directory

```bash
mkdir -p /var/www/hypercal.invntrm.ru/data
chown -R www-data:www-data /var/www/hypercal.invntrm.ru
```

### 3. Configure .env

Copy `.env.example` to the server and fill in real values:

```bash
scp .env.example www-data@104.248.84.190:/var/www/hypercal.invntrm.ru/.env
# Then edit on server with real credentials
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

### 4. DNS

Point `hypercal.invntrm.ru` A record to `104.248.84.190`. Caddy handles TLS automatically.

### 5. GitHub Secrets

Set these in the repo (Settings → Secrets → Actions):

| Secret | Value |
|--------|-------|
| `SSH_HOST` | `104.248.84.190` |
| `SSH_USER` | `www-data` |
| `SSH_KEY` | Contents of the deployment SSH private key |
| `DEPLOY_PATH` | `/var/www/hypercal.invntrm.ru` |

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
cd /var/www/hypercal.invntrm.ru
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

On every push to `main`:

1. **test** — `bun install && bun test`
2. **build** — Docker image → push to ghcr.io
3. **deploy** — SCP docker-compose.yml + Caddyfile → SSH → docker-compose up

## Manual Deploy

```bash
ssh www-data@104.248.84.190
cd /var/www/hypercal.invntrm.ru
docker pull ghcr.io/alex-mextner/hypercalendarbot:latest
docker-compose down --remove-orphans
docker-compose up -d
```

## Monitoring

```bash
# Logs
docker-compose logs -f bot
docker-compose logs -f redis

# Health check
curl https://hypercal.invntrm.ru/health

# Container status
docker-compose ps

# Caddy logs
tail -f /var/log/caddy/hypercal.invntrm.ru.log
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
