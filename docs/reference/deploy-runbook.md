# Deploy Runbook

Detailed deployment reference for HyperCalendarBot. Summary in CLAUDE.md, full details here.

## .env on Server

Single `.env` file: `/opt/hypercal/.env` on the production host `root@odroidn2`. Read by `docker compose`. The DO droplet keeps its own `/opt/hypercal/.env` only for the external watchdog (`scripts/healthcheck-alert.sh`).

It holds every production secret and the host is shared with other services, so `.env` and every backup of it must be mode `0600`, owner `root:root`. Plain `cp` creates a `0644` copy under the default umask; back it up with:
```bash
install -m 600 -o root -g root /opt/hypercal/.env "/opt/hypercal/.env.backup-$(date +%Y-%m-%d_%H-%M-%S)"
```
Appending with `echo ... >> .env` keeps the existing mode.

`REDIS_PASSWORD` never appears in a process argv: `docker-compose.yml` gives it to the redis container as `REDISCLI_AUTH` (read by the healthcheck's `redis-cli`) and feeds `requirepass` to `redis-server` on stdin. It must not contain `"`, `\`, `/`, `?`, `#`, `%`, a tab, a carriage return or a line feed, and redis refuses to start with an error naming the rule: the first two would be read as redis.conf syntax, and `REDIS_URL` embeds the password without percent-encoding, where `/`, `?`, `#` and `%` make the URL invalid or change the password the bot sends, and URL parsing silently drops tab, CR and LF. Spaces, `@`, `:` and the other printable ASCII characters reach both of the bot's Redis clients unchanged. The bot container receives it only inside `REDIS_URL`; the bare `REDIS_PASSWORD` from `env_file` is blanked. A normal deploy recreates only the bot, so after changing the redis service or its password recreate redis too: `docker compose up -d --force-recreate redis bot`.

Adding a new variable: write it to `/opt/hypercal/.env` on `root@odroidn2` by hand (keep mode `0600`). Hosted deploys never write `.env`; the runner user cannot read it.

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
ssh root@odroidn2 'docker compose -f /opt/hypercal/docker-compose.yml logs -f --tail 100 bot'

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
ssh root@odroidn2 'docker exec hypercal-bot ls -lt /app/logs/chats/5153477378/ | head -3'
ssh root@odroidn2 'docker exec hypercal-bot cat /app/logs/chats/5153477378/<timestamp>.log'
```

## Shared Server

Production moved on 2026-10-09 22:30 UTC (#784) from the DigitalOcean droplet `104.248.84.190` (amd64, 1 CPU) to the home ODROID-N2+ `root@odroidn2` (Tailscale MagicDNS name; aarch64, Armbian trixie, 6 cores A53+A73, 3.7 GB RAM, root filesystem on a microSD card). The bot and redis run there from `/opt/hypercal`.

Neighbours on the odroid:
- ExpenseSyncBot prod and stage — PM2, user `www-data`
- HyperSummaryBot
- mextner.com — `caddy-mextner`
- `cloudflared`
- three self-hosted GitHub runners, one per repository, user `www-data` (labels such as `odroid`, `odroid-hsb`, `odroid-mextner`), plus this repo's `odroid-hcb` (user `hcb-runner`, see "Odroid runner")
- `watchdog.service`

The DO droplet keeps only:
- the public ingress: its Caddy serves `hypercal.invntrm.ru` and proxies the bot paths to the Tailscale Funnel `https://odroidn2.tailbfe8ea.ts.net` with `header_up Host {upstream_hostport}` (repo `Caddyfile`, applied by hand there). `PUBLIC_DOMAIN`, the Google OAuth redirect, Calendar watch channels and the Telegram webhook URL did not change;
- the external watchdog cron `*/2 * * * *` (`scripts/healthcheck-alert.sh`, reading DO's `/opt/hypercal/.env`).

The `hypercal-bot` container and `docker-compose.yml` were removed from DO on purpose: a deploy aimed there stops at `deploy-prebuilt-image.sh` with "Existing HyperCalendar container is required". The nightly `backup-db.sh` cron now runs on the odroid.

**Never run `pm2 delete all`, `docker system prune`, or kill PIDs without checking ownership.** Memory and microSD I/O are shared: a deploy activation runs at reduced CPU/I/O priority for that reason.
Port 3001 belongs to HyperCalendarBot Docker. Do not reassign it.

## Normal ship deployment

`gh ship <PR>` first delegates to the shared review, acceptance, merge and local-CI gates. The post-merge step loads its own code from the exact merged Git commit, so removing a PR worktree cannot remove the deployment runner. It reuses the local prebuilt-image fallback and repeats its exact-source tests; no `--skip-tests` is passed automatically.

The post-merge runner uses a nonblocking local release lock, then compares the production receipt, actual running image/revision, health and readiness. An already verified target is a no-op. A newer main is reported as superseded. An active hosted deployment remains its owner; an actual executed failing hosted step is not bypassed. A failed platform run with zero executable steps/runner or a bounded absence of a run may use the local gate. API errors are not treated as proof CI is down.

Since 2026-10-09 the `deploy` job runs on the odroid's self-hosted runner. While that runner is offline the job stays queued and the run is `in_progress`, so post-ship reports `hosted_pending` (exit 75) and the queued job deploys when the runner returns. A run that was cancelled, or whose build ran, is never treated as runner unavailability; deploy such a commit with `scripts/deploy-local-fallback.sh` directly.

Set the existing `HYPERCAL_BUN_BIN` operator variable before shipping when the default `bun` differs from the pinned local toolchain. `HYPERCAL_DOCKER_BIN`/`HYPERCAL_DOCKER_CONTEXT` are only for building with a real Docker Engine instead of Apple `container`: setting `HYPERCAL_DOCKER_CONTEXT` alone switches the builder to Docker, so do not leave a stale value (e.g. `colima`) exported — the post-merge runner inherits the environment. Status is recorded under the common Git directory as `post-ship-release.json`. `hosted_pending`, `busy` and `superseded` return exit 75, not a false deployment success. `ok (unverified)` remains runtime-only verification.

## Local deploy fallback

Use only when the hosted pipeline cannot deploy (no GitHub runner, or the odroid runner `odroid-hcb` is down) and the exact commit has been locally verified. The fallback builds Linux arm64 locally from a clean `git archive` and deploys to `root@odroidn2` (override with `HYPERCAL_DEPLOY_HOST`). The production host only loads a checksum-verified image; it never compiles source or runs the test suite. It stages the source and the image archive in a `0700` directory `/opt/hypercal/.incoming-<sha>-<time>-<pid>`, the same namespace as hosted deploys, and removes it on exit. Not `/tmp`: on the odroid that is a 1.9 GB tmpfs in RAM.

Local builder: on the dev Mac it is Apple's native `container` CLI (Homebrew `container`; run `container system start` if `container system status` reports it stopped), with no always-on Linux VM; on Apple Silicon the arm64 build is native. `container build --platform linux/arm64` builds the image, `container image save` exports an OCI image layout, and `scripts/oci-to-docker-archive.py --platform linux/arm64` converts that — verifying the digest of every blob it reads and keeping the config bytes, so the image ID is unchanged — into the `docker save` format that `scripts/release-artifact.py` and the server's `docker load` identity checks expect. The local image is deleted after export. **Colima was removed from the Mac on 2026-09-26 (its VM disk kept growing) and is no longer a supported builder: do not reinstall it, Docker Desktop, OrbStack or another Docker VM for this.** A real Docker Engine elsewhere is still accepted via `HYPERCAL_BUILD_BACKEND=docker` (local Unix-socket context `HYPERCAL_DOCKER_CONTEXT`, default `default`, and CLI `HYPERCAL_DOCKER_BIN`); on an x86_64 Linux host it builds `--platform linux/arm64` only with binfmt_misc/QEMU arm64 emulation registered (for example `docker run --privileged --rm tonistiigi/binfmt --install arm64`), and much slower than native.

```bash
# Default: fetch and deploy the exact commit at origin/main, with local tests first.
# The system Bun must be the pinned 1.4.2; otherwise point HYPERCAL_BUN_BIN at one.
scripts/deploy-local-fallback.sh

# If that exact commit already passed the full local gate in this incident/session:
scripts/deploy-local-fallback.sh --ref origin/main --skip-tests
```

The script keeps the actual running image under a timestamped rollback tag, takes a WAL-safe DB backup before restart, preserves host files, reapplies runtime directory ownership and recreates only the bot service. It requires exact `/health=ok`, `/ready=ok` or `ok (unverified)`, and the expected image identity. An unverified readiness response is recorded as such, not a completed live AI test. A failure restores the previous image and host files without overwriting newer calendar writes, and the rollback counts only when the restored container is the previous image answering `/health=ok` (readiness is logged, not required: an AI provider outage fails it for every image); otherwise the log says `ROLLBACK FAILED` and the bot may be down. Before any backup or restart, the schema gate below decides whether the release's migrations may activate unattended. No broad prune or shared-proxy reload is performed. The receipt is stored in `/opt/hypercal/releases/current.json`. Normal gh-ship invokes this same fallback after its merge and hosted-run checks; manual use remains an operator recovery path. End-to-end AI verification remains tracked under #276.

### Disk space

`docker load` unpacks the whole archive before it registers the layers, so before loading the activator compares free space on the Docker root (`docker info` `DockerRootDir`) with twice the image's unpacked size (`image_bytes` in the artifact from `scripts/release-artifact.py`, the sum of the archive's files). Below that it stops before touching the service and prints both numbers, instead of failing halfway with `no space left on device` as the #599 release did on 2026-09-28 (#481).

After a verified release it keeps the five newest `rollback-<timestamp>` tags plus the current and previous release images, and removes every other tag of the release repository with `docker image rm` (never `-f`: Docker removes an image with its last tag and refuses one a container still uses). Each removal logs `IMAGE_RETENTION removed=<tag>`; a failure logs `IMAGE_RETENTION failed` and leaves the verified release in place. Other repositories on the shared host are never touched.

When the check refuses a release: save `df -h /`, `docker system df` and the image list under `/opt/hypercal/releases/prune-<date>/` (0700); keep the running image, `:latest`, the `rollback_image` named in `releases/current.json` and the newest rollback tags; `docker image rm <repo:tag>` the other `ghcr.io/alex-mextner/hypercalendarbot` tags; then re-run the failed deploy job. Never `docker system prune` or `docker image prune -a` on this host.

### Schema gate

`scripts/migration-gate.py check`, run by `deploy-prebuilt-image.sh` for hosted CI, the local fallback and gh-ship alike, compares `src/database/migrations.ts` of the running container with the release image (#589). When the file is byte-identical the release goes ahead. Otherwise it activates automatically only when every difference is a new migration entry appended after the shipped ones, which the database's `migrations` table (read through the running container) does not record yet, and whose `docs/reference/migrations/<name>.md` in the release image begins with exactly this front matter and has a non-empty body:

```markdown
---
migration: <name>
rollback-compatible: yes
data-deletion: no
---
```

- `rollback-compatible` says whether the previous image works on a database this migration has already changed. The automatic rollback relies on it. `no` needs a `## Rollback` section in the doc.
- `data-deletion` says whether the migration removes or overwrites data that cannot be rebuilt from the migrated database: a dropped column or table, deleted rows, or a flag cleared on rows whose earlier value mattered (063).
- Migration names are parsed strictly: each entry's `name:` is one single-quoted `[A-Za-z0-9_]` literal alone on its line. The names the release's module actually exports (read by importing it in a network-less container) must equal the parsed entries.
- Code outside the entries (imports, top-level statements, anything after the array) is fingerprinted as a whole. The array ends at the file's last line starting with `];`, so such a line inside a migration's template literal stays part of that migration.

A release that declares `rollback-compatible: no` or `data-deletion: yes`, changes code outside the entries, or ships a migration that the database records but the running image lacks (after an image-only rollback) needs a written, reviewed migration procedure, as for 062 and 063. The operator runs the activation by hand on the host and names the one transition that was reviewed. The refusal prints the pair, but it is the reviewed procedure that authorizes it:

```bash
HYPERCAL_REVIEWED_SCHEMA_TRANSITION="<running sha256>:<release sha256>" \
  bash "$STAGE/scripts/deploy-prebuilt-image.sh" /opt/hypercal "$STAGE" "$IMAGE" "$SHA" "$ARCHIVE_SUM" "$CONFIG_ID"
```

The two values are `sha256sum /app/src/database/migrations.ts` in the running container and in the release image. Hosted CI, the local fallback and gh-ship never set the variable. It never accepts a missing, empty or malformed doc; an edited, renamed, removed or reordered shipped migration (the runner would never run the edit); a `migrations.ts` that cannot be read or parsed; exports that differ from the source entries; or applied migrations or docs that cannot be read.

Every activation logs one audit line before the backup. Its keys are fixed:

- `SCHEMA_GATE decision=unchanged migrations_sha256=<sha256>`
- `SCHEMA_GATE decision=automatic|reviewed-override from=<running sha256> to=<release sha256>`, followed by one `migration=<name> doc=docs/reference/migrations/<name>.md doc_sha256=<sha256> rollback-compatible=yes|no data-deletion=yes|no` group per migration that the database does not record yet, or that it records while the running image lacks it. A reviewed override first logs the refusals it overrode as `Schema gate refusal: …` lines.

If a release that the override accepted with `rollback-compatible: no` fails verification, the script stops it (a release that already exited counts as stopped) and reads the `migrations` table with the previous image. It restores the previous image only when none of those migrations is recorded. Otherwise, or when the read fails, it starts the release again, logs `ROLLBACK_SKIPPED` (and `ROLLBACK FAILED` if the release does not start), and the operator follows the doc's `## Rollback` section. The database is never restored automatically.

## Docker

- Bot + Redis via `docker-compose.yml`, Docker Compose v2 plugin.
- Images are linux/arm64 (the odroid is aarch64). The host never pulls from GHCR: every deploy loads a checksummed `docker save` archive.
- `docker compose` requires root (neither `www-data` nor `hcb-runner` is in the docker group).
- Resource limits: bot 1G/1.5cpu, redis 256M/0.5cpu. The odroid has 6 cores and 3.7 GB RAM shared with the neighbours listed above; keep the bot well below the whole box.
- No deploy secrets: the SSH secrets `SSH_HOST`, `SSH_USER`, `SSH_KEY`, `DEPLOY_PATH` are unused since #784.

## Odroid runner

Hosted deploys run on a self-hosted runner on the odroid (#784), set up by hand when production moved there:

- Runner `odroid-hcb`, labels `self-hosted, Linux, ARM64, odroid-hcb`, registered for this repository only and installed at `/var/lib/hcb-runner/actions-runner` as the Unix user `hcb-runner` (not in the docker group, no general sudo). Jobs run under `/var/lib/hcb-runner/actions-runner/_work/`. The runner needs bash, curl and python3; it has no docker access and no `gh` CLI.
- Only `deploy.yml`'s `deploy` job targets it, and only for pushes to `main`. No workflow triggered by `pull_request` may use a self-hosted label (`test/regressions/hosted-release-contract.test.ts` checks every workflow). The repository's fork pull-request approval policy is `all_external_contributors`.
- Root activation wrapper: `scripts/odroid-activate-release.sh`, installed by hand after each change to it (deploys never update it):
  ```bash
  install -o root -g root -m 0755 scripts/odroid-activate-release.sh /usr/local/sbin/hypercal-activate-release
  ```
- `/etc/sudoers.d/hcb-runner` holds exactly:
  ```
  hcb-runner ALL=(root) NOPASSWD: /usr/local/sbin/hypercal-activate-release
  ```
- The job calls `sudo -n /usr/local/sbin/hypercal-activate-release "$PWD/release" <sha> <archive_sha256> <config_digest>`. The wrapper validates every argument (the release directory must be a real directory under the runner's `_work/`, with no symlink or `..` in its path), copies only the known release files into a fresh root-owned `0700` stage `/opt/hypercal/.incoming-<sha>-<time>-<pid>` without following symlinks, runs `scripts/deploy-prebuilt-image.sh` from that copy with an empty environment at `nice 10` / `ionice -c2 -n7`, removes the stage and returns the activator's exit code. Image name and deploy path are fixed in the wrapper.
- Secrets never go on a command line in a job that runs here: every local user can read process argument lists (`ps`, `/proc/*/cmdline`). The deploy job's GitHub API check and Telegram notification read `GH_TOKEN`/`BOT_TOKEN` from the environment inside `python3` (`urllib.request`) instead of passing them to `curl`; `test/regressions/hosted-release-contract.test.ts` runs the main-ref check and looks for the token in every process's argv while the request is open.
- All four self-hosted runner services on the odroid have the systemd drop-in `50-yield-to-services.conf` (`CPUWeight=20`, `IOWeight=20`, `MemoryHigh=1200M`), and the microSD card `mmcblk0` uses the BFQ I/O scheduler (`/etc/udev/rules.d/60-mmc-bfq.rules`), so runner jobs and deploys yield to the live bots.
- The nightly backup is root cron `0 3 * * *` on the odroid, in its local time zone Europe/Berlin.

### DO rollback copy

The droplet kept the pre-move state, untouched since the bot stopped there at 2026-10-09 22:27:25 UTC: `/opt/hypercal/data` (SQLite + WAL as of that stop, including `backups/calendar_2026-10-09_22-27-22.db.gz`), `/opt/hypercal/logs`, the stopped `hypercal-redis` container (restart policy `no`) with volume `hypercalinvntrmru_redis-data`, and the full production `/opt/hypercal/.env` (the watchdog also reads it). Its compose file is `/opt/hypercal/docker-compose.yml.moved-to-odroid`; `/opt/hypercal/MOVED-TO-ODROID.md` explains the move.

To roll back: stop the bot on the odroid first. If the odroid wrote anything after 22:27 UTC (it serves all traffic since 22:30), copy the odroid's `/opt/hypercal/data` back to DO before starting there. Then rename the DO compose file back to `docker-compose.yml`, run `docker compose up -d` in `/opt/hypercal`, and point the DO Caddyfile back at `localhost:3001`. DO is amd64: only an amd64 image already on DO, or one built for amd64 by hand, runs there; CI and the local fallback build arm64 only.

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

## Database backups

`scripts/backup-db.sh` (root cron `0 3 * * *` and every deploy) and the bot's own daily backup write full calendar-database copies into `/opt/hypercal/data/backups/`. Each copy holds every user's private data, so files are `0600` and the directory `0700`, owned by the container user `999`, which must keep write access. The cron script writes the copy inside the container with umask `077`, then enforces and checks both modes on the host; a copy it cannot restrict is deleted and the script exits non-zero, which also stops a deploy. Each run also restricts older copies left `0644` by earlier versions. A deploy runs the previously installed script, so the backup taken by the deploy that first ships a change to it follows the old rules until the next run. Inspect backups with `stat` only; never open their contents on a shared host.

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
- `MTPROTO_API_ID` / `MTPROTO_API_HASH` env vars — the Telegram app credentials from https://my.telegram.org.
- `TELEGRAM_SESSION_MASTER_KEY` env var — 32-byte hex key for AES-256-GCM encryption of stored Telegram sessions.
  Generate: `openssl rand -hex 32`. Add to `/opt/hypercal/.env`.
- `tzdata` package in Docker image — provides `/usr/share/zoneinfo/zone.tab` for timezone detection
  from Telegram authorizations. Already added to Dockerfile runner stage.
- Python venv with pyrogram — `send-as-user.py` and `connect-session.py` use the venv at `/app/venv/`.
  Docker builds this from `requirements.docker.txt`.
- Key rotation: `OLD_KEY=<hex> NEW_KEY=<hex> bun scripts/rotate-session-master-key.ts` —
  re-encrypts all sessions atomically.

## ntgcalls — Build from Source (voice calls only)

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

# 4. Authorize the service account (see "MTProto service tier" below); needs MTPROTO_API_ID / MTPROTO_API_HASH exported
venv/bin/python scripts/pyrogram-auth.py
```

- macOS arm64 `.dylib` != Linux aarch64 `.so` (odroid) — binaries are platform- and OS-specific
- The build aborts if the P2P audio patch does not apply — it never installs an unpatched binary
- Build deps: CMake 3.20+, git, Python 3.12, 5GB RAM min

## MTProto service tier

> **2026-09-30:** restored behind `ServiceTier`, with no service sends (#753).

`src/services/telegram-session/service-tier.ts` decides once at startup, fail-closed: the tier is on only
when `MTPROTO_API_ID` / `MTPROTO_API_HASH` are set, `MTPROTO_SERVICE_USER_ID` is a positive integer,
`data/voice_caller.session` exists, and `scripts/check-session.py` reports exactly that ID. The log shows
one line: `MTProto service tier enabled` (with `accountId`) or `MTProto service tier disabled` with
`reason` = `service_user_id_unset` | `service_user_id_invalid` | `api_credentials_missing` |
`session_missing` | `probe_failed` | `identity_mismatch`.

Enabled, it resolves @usernames, looks profiles up, lists group members, syncs birthdays (daily
`birthday-sync-tick`) and places voice-call reminders (`call-reminders` queue; `DEEPGRAM_API_KEY` for live
calls, `DISABLE_VOICE=true` to opt out). It never sends messages: invitations go Bot API → the inviter's own
`/connect_telegram` session → a deep link to the inviter; proposals and secretary DMs go Bot API → a deep
link to the initiator. Disabled,
`find_user` / `send_invitation` use the local `users` table and otherwise the picker, group members come
from `group_members`, and birthday sync and voice calls are off.

**Prod:** `MTPROTO_SERVICE_USER_ID` was never set, so the tier is off. To turn it on the owner designates a
service account (Telegram may block such accounts), runs `venv/bin/python scripts/pyrogram-auth.py`
interactively to create `data/voice_caller.session`, sets `MTPROTO_SERVICE_USER_ID` (+ `DEEPGRAM_API_KEY`)
in `/opt/hypercal/.env`, and recreates the bot container. Never build the service session from a user's
stored `/connect_telegram` authorization; do not rotate or revoke unrelated user sessions.
