# Deployment Guide

## Server

Since 2026-10-09 22:30 UTC (#784):

- **Host**: `root@odroidn2` — home ODROID-N2+ (Tailscale MagicDNS name), aarch64, Armbian trixie
- **Deploy path**: `/opt/hypercal`
- **Docker image store**: containerd (Docker 29 on the odroid, shared with other projects). An image's
  `.Id` is its manifest digest there; the deploy compares that with the release archive's indexed manifest
  (deploy runbook, "Image identity").
- **Domain**: hypercal.mextner.com — a proxied Cloudflare CNAME to the tunnel `odroid-home`, whose cloudflared
  runs on the odroid and forwards the hostname to `http://localhost:3001` (the bot's published port). Since
  2026-10-25 (#828); before that the name was hypercal.invntrm.ru on a DigitalOcean droplet
  (`104.248.84.190`, tailnet node `do-edge`) whose Caddy proxied to the odroid over the tailnet, and before
  2026-10-10 over the odroid's Tailscale Funnel (which failed that night from 00:00 to 03:10 UTC and is off).
  The old name stays up beside the new one only until the droplet is deleted.
  The external watchdog cron on the droplet was disabled 2026-10-10 to 2026-10-24 and re-enabled in #822 (runbook
  "Alert watcher").

## Stack

| Component | How |
|-----------|-----|
| Bot | Docker container (ghcr.io/alex-mextner/hypercalendarbot, linux/arm64, pinned by commit SHA) |
| Redis | Docker container (redis:7-alpine, AOF persistence) |
| Reverse proxy | Caddy on the DO droplet → the odroid's tailnet address |
| Orchestration | Docker Compose v2 plugin |
| CI/CD | GitHub Actions → arm64 build on `ubuntu-24.04-arm` → GHCR + release artifact → self-hosted odroid runner → root activation wrapper |

## Initial Server Setup

One-time steps for a fresh server.

### 1. Prerequisites

Docker Engine with the Compose v2 plugin: `docker compose version` must work as root.

Ingress is the DO droplet's Caddy, which reaches the odroid over the tailnet (section 4); the odroid runs
no Caddy for this bot.

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
- `PUBLIC_DOMAIN=hypercal.mextner.com` — bare host, no scheme. Required: the Telegram webhook (`/webhook/telegram`, registered on every start), the Calendar watch-channel address (`/webhooks/google-calendar`) and the OAuth redirect (`https://<PUBLIC_DOMAIN>/oauth/google/callback`, the value that must be listed as an authorized redirect URI on the Google OAuth client) are built from it by `src/config/public-url.ts`
- `GOOGLE_REDIRECT_URI` — only to pin the redirect to another URI than the one derived from `PUBLIC_DOMAIN`

Note: `REDIS_URL` and `NODE_ENV` are overridden by docker-compose.yml — values in .env are ignored for these. `REDIS_PASSWORD` is used only to build `REDIS_URL` and the redis container's auth; the bot container gets it blanked. Keep `.env` at mode `0600` (see `docs/reference/deploy-runbook.md`).

### 4. DNS and ingress

`hypercal.mextner.com` is a proxied CNAME in the `mextner.com` Cloudflare zone to the tunnel `odroid-home`
(`<tunnel-id>.cfargotunnel.com`). The tunnel is remotely managed: its ingress rules live in Cloudflare
(Zero Trust > Networks > Tunnels, or `cf tunnels config get|update <tunnel-id>`), one rule per hostname, and
the rule `hypercal.mextner.com` -> `http://localhost:3001` sends everything to the bot, which answers only
its own routes. A new public name needs both the rule and the CNAME. The repo `Caddyfile` is the retired
DigitalOcean ingress for the old name and has no part in this path.

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
2. **build** — linux/arm64 image → push to ghcr.io; `docker save` release artifact + checksums, and a
   `release-artifact` commit status that names the uploaded artifact's id and digest (ubuntu-24.04-arm)
3. **deploy** — the odroid runner pipes its token to `sudo -n /usr/local/sbin/hypercal-activate-release <sha>`.
   As root, the wrapper checks that main still points at the commit, then downloads and digest-checks the
   artifact that status names, after checking it came from the push-to-main run. Then it runs the staged
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
curl https://hypercal.mextner.com/health

# Container status
ssh root@odroidn2 'docker compose -f /opt/hypercal/docker-compose.yml ps'

# Tunnel client (ingress)
ssh root@odroidn2 'journalctl -u cloudflared -n 50 --no-pager'
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
