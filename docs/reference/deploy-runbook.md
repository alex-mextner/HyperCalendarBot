# Deploy Runbook

Detailed deployment reference for HyperCalendarBot. Summary in CLAUDE.md, full details here.

## .env on Server

Single `.env` file: `/opt/hypercal/.env`. Read by `docker compose`.

Adding a new variable (e.g. via GitHub Actions secrets):
1. Add secret to the repo
2. Pass to deploy step via `envs:` and write to `.env` via `echo ... >> .env`, **or**
3. Write manually to `/opt/hypercal/.env` on the server

After changing `.env`, **recreate** the container (not just restart):
```bash
cd /opt/hypercal
docker stop hypercal-bot && docker rm hypercal-bot
docker compose up -d --no-deps bot
```
`docker restart` does NOT re-read `env_file`.

## Diagnostics

```bash
# Docker logs (pino JSON):
ssh root@104.248.84.190 'docker compose -f /opt/hypercal/docker-compose.yml logs -f --tail 100 bot'

# Health check:
curl https://hypercal.invntrm.ru/health
```

`logs/chats/{chatId}/{timestamp}.log` inside container contains detailed AI interaction logs:
system prompt, history, tool calls, responses. Enabled via `AI_DEBUG_LOGS=true`.

```bash
# Latest log for a chat (logs inside container at /app/logs/):
ssh root@104.248.84.190 'docker exec hypercal-bot ls -lt /app/logs/chats/5153477378/ | head -3'
ssh root@104.248.84.190 'docker exec hypercal-bot cat /app/logs/chats/5153477378/<timestamp>.log'
```

## Shared Server

The server runs multiple PM2 services alongside our Docker containers:
- `expensesyncbot` — `/var/www/ExpenseSyncBot`
- `log-viewer` — `/var/www/log-viewer` (port 3002)
- `psy_froggy_bot` — `/var/www/psy_froggy_bot`

**Never run `pm2 delete all`, `docker system prune`, or kill PIDs without checking ownership.**
Port 3001 belongs to HyperCalendarBot Docker. Do not reassign it.

## Docker

- Bot + Redis via `docker-compose.yml`, Docker Compose v2 plugin.
- GHCR private registry — deploy step must `docker login ghcr.io` before pull.
- `docker compose` requires root (www-data not in docker group).
- Resource limits: bot 1G/0.9cpu, redis 256M/0.5cpu (server is 1 CPU — never exceed 1.0).
- GitHub Actions secrets: `SSH_HOST`, `SSH_USER`, `SSH_KEY`, `DEPLOY_PATH`.

## Dockerfile

- Base: `debian:bookworm-slim` + bun installed via `bun.sh/install` script (version pinned).
- NOT `oven/bun:1-debian` — bun Docker Hub tags lag behind releases.
- `ln -s bun node` required — Playwright CLI uses `#!/usr/bin/env node`.
- `bun install --ignore-scripts` — skips lefthook postinstall (needs git, absent in Docker).

## bun lockfile and --frozen-lockfile

`--frozen-lockfile` is **cross-platform incompatible**: a macOS arm64 lockfile fails on linux amd64
even with the same bun version and build hash. Platform-specific optional deps (e.g.
`@rollup/rollup-darwin-arm64` vs `@rollup/rollup-linux-x64-gnu`) cause the mismatch.

- **CI** (linux): `bun install` -> `bun install --frozen-lockfile` — validates lockfile integrity.
- **Docker** (linux): `bun install --ignore-scripts` — respects lockfile version pins, adjusts
  only platform-specific optional deps.
- **Local** (macOS): `bun install` — generates/updates lockfile normally.

## bun install --production in Docker

`bun install --production` with an **existing lockfile** always acts as `--frozen-lockfile` and
fails if the lockfile format differs. **Never use `--production` with `COPY bun.lock`.**

For a prod-deps Docker stage:
```dockerfile
COPY package.json ./          # no bun.lock
RUN bun install --production --ignore-scripts
```

## Docker prod data volume ownership

The bot runs as `botuser` (uid=999) inside the container. The data volume on the host
(`/opt/hypercal/data/`) must be owned by uid 999, otherwise SQLite throws `SQLITE_READONLY`.

```bash
# Find actual botuser UID:
docker run --rm --entrypoint id ghcr.io/alex-mextner/hypercalendarbot:latest
# Fix ownership (replace 999 with actual UID):
chown -R 999:999 /opt/hypercal/data/
```

## Migration renumbering hazard

If a migration is renumbered (e.g. `042_foo` -> `043_foo`), the existing production DB has the old
name recorded and the new code tries to apply it again. **Never renumber existing migrations.**

Fix if already happened:
```bash
docker run --rm -v /opt/hypercal/data:/data ghcr.io/alex-mextner/hypercalendarbot:latest \
  bun -e "
import { Database } from 'bun:sqlite';
const db = new Database('/data/calendar.db');
db.run('INSERT OR IGNORE INTO migrations (name) VALUES (?)', ['043_new_name_here']);
db.close();
"
```

## ntgcalls — Build from Source

ntgcalls v2.1.0 has a bug: P2P calls connect but audio is silent.
Fix: `NativeNetworkInterface::UpdateAggregateStates_n()` never calls `OnNetworkAvailability(true)`.
Patch: `scripts/ntgcalls-fix-network-state.patch`.

**The compiled `.so` is NOT in git (venv/ is gitignored). Must rebuild on each server.**

On every new Linux server:

```bash
# 1. Install uv (if not present)
curl -LsSf https://astral.sh/uv/install.sh | sh

# 2. Create Python venv and install deps
uv venv --python 3.12 venv
uv pip install -r pyproject.toml --python venv/bin/python

# 3. Build patched ntgcalls from source (~5 min, needs ~5GB RAM, ~2GB disk)
./scripts/build-patched-ntgcalls.sh python3.12 venv

# 4. Authenticate Pyrogram session (one-time interactive)
venv/bin/python scripts/pyrogram-auth.py
```

- macOS arm64 `.dylib` != Linux x86_64 `.so` — binaries are platform-specific
- `scripts/download-ntgcalls.sh` downloads the UNPATCHED binary — do NOT use it
- Build deps: CMake 3.20+, git, Python 3.12, 5GB RAM min
