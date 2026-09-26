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

# Liveness — process started and Redis answers:
curl https://hypercal.invntrm.ru/health

# Readiness — everything above, plus the AI provider chain is answering.
# This is what the cron watchdog polls; a 503 here with a 200 on /health means
# the bot is running but cannot answer anyone.
curl https://hypercal.invntrm.ru/ready
```

`/ready` has three answers, and the body distinguishes the last two:

| Response | Meaning |
| --- | --- |
| `503` | The bot cannot serve anyone: it has not started, Redis is unreachable, or every AI provider is failing (body says which). |
| `200 ok` | A provider has answered in this process. The bot demonstrably works. |
| `200 ok (unverified)` | The process is alive but has served nobody since it started, so it has no evidence either way. The watchdog treats this as "keep waiting", never as a recovery — a restart during an outage would otherwise look like the outage ending. After thirty minutes of waiting it drops the down-state silently, without announcing a recovery, so a quiet bot cannot end up swallowing the alert for the next outage. Any other 200 body — a proxy's own page, a changed contract — is treated the same way and logged. |

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

## Normal ship deployment

`gh ship <PR>` first delegates to the shared review, acceptance, merge and local-CI gates. The post-merge step loads its own code from the exact merged Git commit, so removing a PR worktree cannot remove the deployment runner. It reuses the local prebuilt-image fallback and repeats its exact-source tests; no `--skip-tests` is passed automatically.

The post-merge runner uses a nonblocking local release lock, then compares the production receipt, actual running image/revision, health and readiness. An already verified target is a no-op. A newer main is reported as superseded. An active hosted deployment remains its owner; an actual executed failing hosted step is not bypassed. A failed platform run with zero executable steps/runner or a bounded absence of a run may use the local gate. API errors are not treated as proof CI is down.

Set the existing `HYPERCAL_BUN_BIN` operator variable before shipping when the default `bun` differs from the pinned local toolchain. `HYPERCAL_DOCKER_BIN`/`HYPERCAL_DOCKER_CONTEXT` are only for building with a real Docker Engine instead of Apple `container`: setting `HYPERCAL_DOCKER_CONTEXT` alone switches the builder to Docker, so do not leave a stale value (e.g. `colima`) exported — the post-merge runner inherits the environment. Status is recorded under the common Git directory as `post-ship-release.json`. `hosted_pending`, `busy` and `superseded` return exit 75, not a false deployment success. `ok (unverified)` remains runtime-only verification.

## Local deploy fallback

Use only when GitHub-hosted Actions cannot obtain a runner and the exact commit has been locally verified. The fallback builds Linux amd64 locally from a clean `git archive`. The production host only loads a checksum-verified image; it never compiles source or runs the test suite.

Local builder: on the dev Mac it is Apple's native `container` CLI (Homebrew `container`; run `container system start` if `container system status` reports it stopped), with no always-on Linux VM. `container build --platform linux/amd64` builds the image, `container image save` exports an OCI image layout, and `scripts/oci-to-docker-archive.py` converts that — verifying the digest of every blob it reads and keeping the config bytes, so the image ID is unchanged — into the `docker save` format that `scripts/release-artifact.py` and the server's `docker load` identity checks expect. The local image is deleted after export. **Colima was removed from the Mac on 2026-09-26 (its VM disk kept growing) and is no longer a supported builder: do not reinstall it, Docker Desktop, OrbStack or another Docker VM for this.** A real Docker Engine elsewhere is still accepted via `HYPERCAL_BUILD_BACKEND=docker` (local Unix-socket context `HYPERCAL_DOCKER_CONTEXT`, default `default`, and CLI `HYPERCAL_DOCKER_BIN`).

```bash
# Default: fetch and deploy the exact commit at origin/main, with local tests first.
# The system Bun must be the pinned 1.4.2; otherwise point HYPERCAL_BUN_BIN at one.
scripts/deploy-local-fallback.sh

# If that exact commit already passed the full local gate in this incident/session:
scripts/deploy-local-fallback.sh --ref origin/main --skip-tests
```

The script keeps the actual running image under a timestamped rollback tag, takes a WAL-safe DB backup before restart, preserves host files, reapplies runtime directory ownership and recreates only the bot service. It requires exact `/health=ok`, `/ready=ok` or `ok (unverified)`, and the expected image identity. An unverified readiness response is recorded as such, not a completed live AI test. A failure restores the previous image and host files without overwriting newer calendar writes. Generic rollback is intentionally limited to unchanged migration code: a schema-changing release requires a separately reviewed procedure. No broad prune or shared-proxy reload is performed. The receipt is stored in `/opt/hypercal/releases/current.json`. Normal gh-ship invokes this same fallback after its merge and hosted-run checks; manual use remains an operator recovery path. Schema-changing releases and end-to-end AI verification remain separately tracked under #276.

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

## Connect Telegram (session-based delivery)

Requires:
- `TELEGRAM_SESSION_MASTER_KEY` env var — 32-byte hex key for AES-256-GCM encryption of stored Telegram sessions.
  Generate: `openssl rand -hex 32`. Add to `/opt/hypercal/.env`.
- `tzdata` package in Docker image — provides `/usr/share/zoneinfo/zone.tab` for timezone detection
  from Telegram authorizations. Already added to Dockerfile runner stage.
- Python venv with pyrogram — `send-as-user.py` and `connect-session.py` use the venv at `/app/venv/`.
  Docker builds this from `requirements.docker.txt`.
- Key rotation: `OLD_KEY=<hex> NEW_KEY=<hex> bun scripts/rotate-session-master-key.ts` —
  re-encrypts all sessions atomically.

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

## Service identity isolation

Set `MTPROTO_SERVICE_USER_ID` to the explicitly designated service account. Startup checks the authenticated ID; each shared Python consumer checks it again. Missing, revoked or mismatched credentials disable only shared MTProto capabilities. Never restore the shared file from the pool of personal user authorizations. Preserve Bot API and inviter-owned sessions. After configuration changes recreate the bot container; do not rotate or revoke unrelated user sessions.
