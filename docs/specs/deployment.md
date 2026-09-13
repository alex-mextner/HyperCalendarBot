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

Note: `REDIS_URL` and `NODE_ENV` are overridden by docker-compose.yml — values in .env are ignored for these.

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

### 6. Pyrogram session (voice calls)

Only if voice calls are needed:

```bash
# On the server, inside the bot container:
docker exec -it hypercal-bot bash
# Then inside container — not yet supported, auth must happen on host with Python venv
```

Voice call auth requires an interactive terminal — run on host:

```bash
cd /var/www/hypercal.invntrm.ru
# Create Python venv with uv
uv venv --python 3.12 venv
uv pip install -r pyproject.toml --python venv/bin/python
# Build patched ntgcalls (5+ min, needs 5GB RAM)
./scripts/build-patched-ntgcalls.sh python3.12 venv
# Interactive auth — enter phone, code from Telegram
venv/bin/python scripts/pyrogram-auth.py
```

Session file ends up in `data/voice_caller.session`.

Set `MTPROTO_SERVICE_USER_ID` to the numeric Telegram ID of the explicitly
chosen service account. An ordinary user's stored Telegram authorization is never
copied into this session or used to enable shared service capabilities.

Shared-session consumer inventory:

- `send-message.py`, `resolve-username.py`, `fetch-birthdays.py`,
  `get-chat-members.py`, `voice-call-bridge.py`, `debug-call.py`, and the embedded
  Python in `docker-call-test.sh` use `start_service_session`: public Pyrogram
  `connect` → `get_me` → expected-ID check → `initialize`. Initialized clients use
  `stop`; identity rejection disconnects before initialization. The Docker helper
  mounts this guard read-only and forwards `MTPROTO_SERVICE_USER_ID` explicitly.
- `check-session.py` is a read-only identity probe (`connect`/`get_me`/`disconnect`,
  without initialization). `src/index.ts` uses `bootstrapServiceSession` to require
  service configuration, the existing file, and a successful matching probe before
  enabling shared messaging, username resolution, or voice capabilities.
- `pyrogram-auth.py` is the intentional operator authorization bootstrap exception:
  it interactively creates the chosen service account's session. Run it manually
  as the operator, never from service startup or as recovery from a user's stored
  credentials. `mtproto_lock.py` only coordinates access; it does not open a client.


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
