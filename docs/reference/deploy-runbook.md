# Deploy Runbook

Detailed deployment reference for HyperCalendarBot. Summary in CLAUDE.md, full details here.

## .env on Server

Single `.env` file: `/opt/hypercal/.env` on the production host `root@odroidn2`. Read by `docker compose`. The DO droplet's own `/opt/hypercal/.env` serves only the external watchdog (`scripts/healthcheck-alert.sh`, see "Alert watcher").

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
curl https://hypercal.mextner.com/health

# Readiness — everything above, plus the AI provider chain is answering.
# The alert watcher on the owner's PC polls this every 30 s; a 503 here with a 200 on /health means
# the bot is running but cannot answer anyone.
curl https://hypercal.mextner.com/ready
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
- `cloudflared` — the `odroid-home` tunnel client, the public ingress for every `*.mextner.com` name here, including `hypercal.mextner.com` (see "Public ingress")
- three self-hosted GitHub runners, one per repository, user `www-data` (labels such as `odroid`, `odroid-hsb`, `odroid-mextner`), plus this repo's `odroid-hcb` (user `hcb-runner`, see "Odroid runner")
- `watchdog.service`

The DO droplet is being retired. Until it is deleted it still holds:
- the old ingress for `hypercal.invntrm.ru` (its Caddy proxies the bot paths over the tailnet to `100.116.57.66:3001`; repo `Caddyfile`, applied by hand there; tailnet node `do-edge`, `100.113.21.91`). Nothing new uses that name: `PUBLIC_DOMAIN`, the Telegram webhook and the OAuth redirect moved to `hypercal.mextner.com` on 2026-10-25 (#828);

- the external watchdog cron `*/2 * * * *` (an older copy of `scripts/healthcheck-alert.sh` reading DO's `/opt/hypercal/.env`, log `/opt/hypercal/logs/healthcheck.log`) that still probes the old name. That line was commented out on 2026-10-10 ("HCB moved to odroid") and nothing watched the bot until it was re-enabled on 2026-10-24 (#822). The re-enable also removed the stale `/tmp/hypercal-down` from 2026-10-10 01:01 UTC: while that file exists the script believes an outage is already announced and stays silent, so any future re-enable must check `ls /tmp/hypercal-*` on the droplet first. The pre-change crontab is saved as `/root/crontab.bak-20261024-hcb822` on the droplet (revert: `crontab /root/crontab.bak-20261024-hcb822`).

Until 2026-10-10 the upstream of that ingress was the odroid's Tailscale Funnel `https://odroidn2.tailbfe8ea.ts.net`. Funnel failed that night from 00:00 to 03:10 UTC: two of its three ingress IPs reset TLS. Since then Funnel is off on the odroid; nothing depends on it.

The `hypercal-bot` container and `docker-compose.yml` were removed from DO on purpose: a deploy aimed there stops at `deploy-prebuilt-image.sh` with "Existing HyperCalendar container is required". The nightly `backup-db.sh` cron now runs on the odroid.

**Never run `pm2 delete all`, `docker system prune`, or kill PIDs without checking ownership.** Memory and microSD I/O are shared: a deploy activation runs at reduced CPU/I/O priority for that reason.
Port 3001 belongs to HyperCalendarBot Docker. Do not reassign it.

## Alert watcher

Why it exists: until 2026-09-28 a macOS LaunchAgent polled `/admin/alerts/next` and opened an omp session; after the Mac was sold nothing consumed the queue (7 alerts pending on 2026-10-24, the newest a failed deploy), and from 2026-10-10 to 2026-10-24 nothing raised DOWN either. The queue is the bot's own SQLite table `alerts`, so a bot that is down cannot store its own DOWN alert (the watchdog's POST to `/admin/alerts` fails and is swallowed). Down detection therefore has two paths that do not need the bot: the DO watchdog sends a Telegram message straight through the Bot API, and the consumer below probes readiness itself and starts the investigation.

What runs: the systemd **user** service `hcb-alert-watcher` on the owner's Ubuntu PC (`scripts/hcb-alert-watcher.ts`). Every 30 s it

1. probes `https://hypercal.mextner.com/ready` (`HCB_BASE_URL` overrides; healthy = `200` with body `ok` or `ok (unverified)`); three failed probes in a row raise one `down-<epoch>` incident for the whole outage. A name that does not resolve on the PC is not a failed probe (it says nothing about the bot): after three in a row the owner gets one `tg --tag problem` notice that the watcher is blind, and no session starts. On 2026-10-25 this PC's systemd-resolved returned `Name not found` for the new host's A record while the ISP resolvers answered it; check with `resolvectl query -t A hypercal.mextner.com`;
2. pops `/admin/alerts/next` until it answers `204`. The pop is destructive on the server, so every alert is written to the local spool (`~/.local/state/hcb-alert-watcher/pending/`) first; alerts older than 12 hours are consumed and logged as stale, not investigated;
3. starts **one** detached omp session for everything pending, at most one per 30 minutes (alerts that arrive meanwhile wait and share the next session), at most once per alert id (`launched/<key>` markers survive restarts). The session starts through the sanctioned `rig-detached-omp` launcher in the repository checkout, plus a tmux window `hcb-alert-<utc stamp>` in the canonical `main` session that follows its log (`/tmp/agent-logs/<name>.log`) and closes 15 minutes after the session ends.

The brief the session gets (`~/.local/state/hcb-alert-watcher/briefs/`) fences the alert text as untrusted data, makes the first phase read-only, forbids restart/stop/rollback/redeploy, database writes, deletions and merging without the owner (#596), and requires a Russian `tg report` with the root cause first. The watcher itself tells the owner with `tg --tag problem` when it is blind: the launcher fails (alerts stay pending), or the queue answers 401/403/404 three times in a row (token rotated or endpoint disabled); each notice is sent once per streak. Every helper process it spawns (launcher, tmux, ctmux, tg) has a 30 s deadline and runs without the alert token; the tmux server and window are started in their own systemd scope so restarting the unit never kills the owner's tmux.

Install (idempotent; the token lives only in the keychain as `hcb-alert-watcher/admin-alert-token` and reaches the service through `keychain exec --caller hcb-alert-watcher`):

```bash
scripts/install-alert-watcher.sh --fetch-token-from root@odroidn2   # first time: also copies the production ADMIN_ALERT_TOKEN into the keychain
scripts/install-alert-watcher.sh                                    # later: update unit, restart only if it changed
HCB_BASE_URL=https://other.example scripts/install-alert-watcher.sh # probe another public host (written into the unit; re-run without it to drop it)
scripts/install-alert-watcher.sh --uninstall
systemctl --user status hcb-alert-watcher; journalctl --user -u hcb-alert-watcher -f
```

Run it from a checkout whose `main` contains the watcher; the unit points at the canonical checkout, not at a worktree. Install it on the machine that hosts the owner's omp sessions only (the home laptop does not need it: a second watcher would pop alerts the first one then never sees). Tuning is by `HCB_*` environment variables read by `loadConfig` in the script (`HCB_ALERT_POLL_SECONDS`, `HCB_ALERT_RATE_LIMIT_SECONDS`, `HCB_ALERT_DOWN_PROBES`, `HCB_ALERT_STALE_HOURS`, `HCB_ALERT_COMMAND_TIMEOUT_SECONDS`, `HCB_BASE_URL`, `HCB_ALERT_STATE_DIR`).

Backlog triage (alerts that piled up while nothing consumed the queue): the service pops the whole queue on its first cycle and, with the default 12 h limit, marks old alerts stale without investigating them, so triage BEFORE the first install (or after `systemctl --user stop hcb-alert-watcher`): `keychain exec --caller hcb-alert-watcher --env ADMIN_ALERT_TOKEN=hcb-alert-watcher/admin-alert-token -- env HCB_ALERT_STALE_HOURS=1000 bun scripts/hcb-alert-watcher.ts --once` (the pending alerts go to one session; one run pops at most 50, so with a bigger queue repeat it, after the 30-minute rate limit, until the log shows no `queued from` line), then install or `systemctl --user start hcb-alert-watcher`. Never run `--once` while the service runs: the two processes share the state directory without a lock and could each start a session. A 200 from the queue that the watcher cannot parse is kept in `~/.local/state/hcb-alert-watcher/unreadable/` (the server's pop already consumed it; one file per cycle at most). A launcher that hits its 30 s deadline is not retried (the session may already run): the owner is told once and the alerts are marked handled. After a restart in the middle of a launch, a claim whose session log (`HCB_AGENT_LOG_DIR`, default `/tmp/agent-logs`) already exists is confirmed, not launched again.

Known limits: the probe runs on the PC, so a PC that is off or offline raises nothing (the DO watchdog still messages the owner then), and a PC whose own network is down counts as a down bot after three failed probes (cached DNS still answers); failures more than about six minutes apart (suspend, service stopped) never add up to an outage. The DO watchdog posts its queue alert only while the bot is up, so only the PC probe turns a hard outage into an investigation session. The unit and every session it starts run with `PATH=~/.local/bin:~/.bun/bin:/usr/local/bin:/usr/bin:/bin` and no ssh agent (key-file auth to `root@odroidn2` works, verified under `systemd-run --user --pipe`); the installer warns about `omp`, `gh`, `ssh`, `tmux`, `ctmux`, `systemd-run` missing from that PATH and pins `tg` by absolute path. After a failed launch the launcher is left alone for a minute.

Also known: (1) an outage seen by the PC probe and, separately, by a queued alert (the DO watchdog's POST, a crash alert) can start two sessions 30 minutes apart: dedupe is per alert id and per probe incident, not across sources; the second session's brief tells it to check `omp-steer list` first. (2) The unit starts at login or boot (linger); if the keyring is still locked, `keychain exec` fails with its own exit code, which `RestartPreventExitStatus=78` does not cover: the unit restarts every 30 s without being able to tell you. After a reboot check `systemctl --user is-active hcb-alert-watcher`; `keychain unlock` fixes it. (3) Bun loads the script once: after a merge that changes `scripts/hcb-alert-watcher.ts` run `systemctl --user restart hcb-alert-watcher` (the installer restarts only when the unit text changes). (4) A pop whose response times out before any header arrives may have consumed an alert on the server; only the journal line "queue step failed" shows it. (5) The queue poll refuses redirects so the token never travels to another host.

## Public ingress (Cloudflare tunnel)

`hypercal.mextner.com` is a proxied CNAME in the `mextner.com` Cloudflare zone (account `invntrm@gmail.com`) to the tunnel `odroid-home` (`872e1f2e-3488-4e80-955e-8aba2fada806`). cloudflared on the odroid (`cloudflared.service`, `--token-file /etc/cloudflared/token`) runs it with a remotely managed configuration, so the hostname rules are edited in Cloudflare, not on the odroid. Bot traffic is the rule `hypercal.mextner.com` -> `http://localhost:3001`; every path reaches the bot, which serves only its own routes (`/health`, `/ready`, `/webhook/telegram`, `/webhooks/google-calendar`, `/oauth/google/callback`, `/admin/alerts*` behind the bearer token). While the container is being replaced the tunnel answers 502; Telegram and Google retry, but there is no proxy holding requests as the retired DO Caddy did (`lb_try_duration`).

Tooling (credentials stay in `~/.config/cloudflare/config/` and the keychain, never printed): the `cf` CLI with the profile `mextner` and `CLOUDFLARE_ACCOUNT_ID=535199eee5a421a25d445e3445394522`.

```bash
cf tunnels config get 872e1f2e-3488-4e80-955e-8aba2fada806 --profile mextner        # read the rules; save the output first
cf tunnels config update 872e1f2e-3488-4e80-955e-8aba2fada806 --profile mextner --body '{"config":{"ingress":[...,{"hostname":"hypercal.mextner.com","service":"http://localhost:3001"},{"service":"http_status:404"}],"warp-routing":{"enabled":false}}}'
keychain exec --env CLOUDFLARE_API_TOKEN=agent/cloudflare-mextner-dns -- cf dns records list -z mextner.com   # DNS-only token, zone mextner.com
```

The rule list must keep the final `http_status:404` rule and every existing hostname (the same tunnel serves `mextner.com`, `finbot*`, `hyper-summary-bot`); it replaces the whole list, so rollback is the same command with the previously saved list. A new name also needs `cf dns records create -z mextner.com --body '{"type":"CNAME","name":"<label>","content":"872e1f2e-3488-4e80-955e-8aba2fada806.cfargotunnel.com","proxied":true}'`.

### Move of 2026-10-25 (#828)

The owner is retiring `invntrm.ru`, so the ingress moved from the DO droplet to this tunnel with both names live in parallel:

1. Tunnel rule + CNAME added; `https://hypercal.mextner.com/health` and `/ready` answered `ok` while `hypercal.invntrm.ru` still worked. Rollback: restore the saved rule list, delete the CNAME.
2. `/opt/hypercal/.env` backed up (`.env.backup-ingress-move-20261025T210552Z`, mode 0600, with the container's logs, inspect line and `getWebhookInfo` of the old state in `/opt/hypercal/evidence-ingress-move-20261025T210552Z/`), then `PUBLIC_DOMAIN=hypercal.mextner.com` set and the bot container recreated on the image it was already running (`docker compose up -d --no-deps --no-build --pull never --force-recreate bot`, holding `.release.lock`). The bot registers its Telegram webhook at every start, so the webhook moved with the recreate. Rollback: copy the backup over `.env` and run the same compose command; the old name still routes to the bot through the droplet.
3. `GOOGLE_REDIRECT_URI` was pinned to the old callback in `.env` until `https://hypercal.mextner.com/oauth/google/callback` was added to the Google OAuth client (Cloud Console only, no API for web clients); with the new URI listed, remove the pin and recreate again. Keep the old URI in the client until the old domain is gone.
4. Calendar watch channels: production had none (`google_watch_channels` was empty on 2026-10-25 and nothing enqueues `setup-watch`, #831), so there was nothing to move. Any channel created from now on carries the new host; `renewExpiringChannels` (every 6 h, channels expiring within 24 h) keeps that true.

## Normal ship deployment

`gh ship <PR>` first delegates to the shared review, acceptance, merge and local-CI gates. The post-merge step loads its own code from the exact merged Git commit, so removing a PR worktree cannot remove the deployment runner. It reuses the local prebuilt-image fallback and repeats its exact-source tests; no `--skip-tests` is passed automatically.

The post-merge runner uses a nonblocking local release lock, then compares the production receipt, actual running image/revision, health and readiness. An already verified target is a no-op. A newer main is reported as superseded. An active hosted deployment remains its owner; an actual executed failing hosted step is not bypassed. A failed platform run with zero executable steps/runner or a bounded absence of a run may use the local gate. API errors are not treated as proof CI is down.

Since 2026-10-09 the `deploy` job runs on the odroid's self-hosted runner. While that runner is offline the job stays queued and the run is `in_progress`, so post-ship reports `hosted_pending` (exit 75) and the queued job deploys when the runner returns. A run that was cancelled, or whose build ran, is never treated as runner unavailability; deploy such a commit with `scripts/deploy-local-fallback.sh` directly.

Set the existing `HYPERCAL_BUN_BIN` operator variable before shipping when the default `bun` differs from the pinned local toolchain. `HYPERCAL_DOCKER_BIN`/`HYPERCAL_DOCKER_CONTEXT` are only for building with a real Docker Engine instead of Apple `container`: setting `HYPERCAL_DOCKER_CONTEXT` alone switches the builder to Docker, so do not leave a stale value (e.g. `colima`) exported — the post-merge runner inherits the environment. Status is recorded under the common Git directory as `post-ship-release.json`. `hosted_pending`, `busy` and `superseded` return exit 75, not a false deployment success. `ok (unverified)` remains runtime-only verification.

## Local deploy fallback

Use only when the hosted pipeline cannot deploy (no GitHub runner, or the odroid runner `odroid-hcb` is down) and the exact commit has been locally verified. The fallback builds Linux arm64 locally from a clean `git archive` and deploys to `root@odroidn2` (override with `HYPERCAL_DEPLOY_HOST`). The production host only loads a checksum-verified image; it never compiles source or runs the test suite. It stages the source and the image archive in a `0700` directory `/opt/hypercal/.incoming-<sha>-<time>-<pid>`, the same namespace as hosted deploys, and removes it on exit. Not `/tmp`: on the odroid that is a 1.9 GB tmpfs in RAM.

Local builder: on the dev Mac it is Apple's native `container` CLI (Homebrew `container`; run `container system start` if `container system status` reports it stopped), with no always-on Linux VM; on Apple Silicon the arm64 build is native. `container build --platform linux/arm64` builds the image, `container image save` exports an OCI image layout, and `scripts/oci-to-docker-archive.py --platform linux/arm64` converts that — verifying the digest of every blob it reads and keeping the config bytes, so the config digest is unchanged — into the `docker save` format that `scripts/release-artifact.py` and the server's `docker load` identity checks expect, including the OCI layout (`oci-layout`, `index.json` and an image manifest for the uncompressed layers) whose manifest digest becomes the image ID on the odroid's containerd image store (see Docker, "Image identity"). The local image is deleted after export. **Colima was removed from the Mac on 2026-09-26 (its VM disk kept growing) and is no longer a supported builder: do not reinstall it, Docker Desktop, OrbStack or another Docker VM for this.** A real Docker Engine elsewhere is still accepted via `HYPERCAL_BUILD_BACKEND=docker` (local Unix-socket context `HYPERCAL_DOCKER_CONTEXT`, default `default`, and CLI `HYPERCAL_DOCKER_BIN`); on an x86_64 Linux host it builds `--platform linux/arm64` only with binfmt_misc/QEMU arm64 emulation registered (for example `docker run --privileged --rm tonistiigi/binfmt --install arm64`), and much slower than native.

```bash
# Default: fetch and deploy the exact commit at origin/main, with local tests first.
# The system Bun must be the pinned 1.4.2; otherwise point HYPERCAL_BUN_BIN at one.
scripts/deploy-local-fallback.sh

# If that exact commit already passed the full local gate in this incident/session:
scripts/deploy-local-fallback.sh --ref origin/main --skip-tests
```

The script keeps the actual running image under a timestamped rollback tag, takes a WAL-safe DB backup before restart, preserves host files, reapplies runtime directory ownership and recreates only the bot service. It requires exact `/health=ok`, `/ready=ok` or `ok (unverified)`, and the expected image identity (see Docker, "Image identity"). An unverified readiness response is recorded as such, not a completed live AI test. A failure restores the previous image and host files without overwriting newer calendar writes, and the rollback counts only when the restored container is the previous image answering `/health=ok` (readiness is logged, not required: an AI provider outage fails it for every image); otherwise the log says `ROLLBACK FAILED` and the bot may be down. Before any backup or restart, the schema gate below decides whether the release's migrations may activate unattended. No broad prune or shared-proxy reload is performed. The receipt is stored in `/opt/hypercal/releases/current.json`: `revision`, `config_digest`, `image_id` (the container's `.Image` the activator verified), `archive_sha256`, `ready`, `rollback_image`, `verified_at`. Normal gh-ship invokes this same fallback after its merge and hosted-run checks; manual use remains an operator recovery path. End-to-end AI verification remains tracked under #276.

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
- Resource limits: bot 1G/1.5cpu with a 384M reservation (cgroup `memory.low`), redis 256M/0.5cpu. The odroid has 6 cores and 3.7 GB RAM shared with the neighbours listed above and is overcommitted (on 2026-10-10 about 2 GB sat in swap and the idle bot was down to 71 MB resident); the reservation keeps the bot's working set out of reclaim so a message is not served from swap. Keep the bot well below the whole box.
- No deploy secrets: the SSH secrets `SSH_HOST`, `SSH_USER`, `SSH_KEY`, `DEPLOY_PATH` are unused since #784.

### Image identity

The odroid's Docker (29.9.0) uses the containerd image store: `docker info` reports storage driver `overlayfs` with DriverStatus `[["driver-type","io.containerd.snapshotter.v1"]]`. It stays that way: Home Assistant and the other projects' containers live in that store. There, `docker image inspect <ref> --format '{{.Id}}'` and a container's `.Image` are the digest of the image's manifest (or of its index, for a multi-platform image), not the config digest that Docker's classic store reports.

A release archive is a `docker save` tar carrying both names: `manifest.json` points at the config blob, and the OCI layout (`oci-layout`, `index.json`) names one image manifest for the release tag (annotation `io.containerd.image.name`) whose `config` is that blob. `scripts/release-artifact.py` reads both from the archive, checks each blob against its digest and the manifest against the config, and reports `config_digest` and `manifest_digest`. The config digest stays the release identity: the activator's `CONFIG_ID` argument, `artifact.json` and the receipt's `config_digest`. `deploy-prebuilt-image.sh` reads the daemon's DriverStatus once and compares the loaded image's `.Id`, and the recreated container's `.Image`, with the one digest that store uses: `manifest_digest` on containerd, `config_digest` on the classic store. Anything else stops the deploy, before the backup for a bad load and with a rollback for a wrong container. The rollback check compares the restored container with the previous container's `.Image`, both read from the same daemon. The receipt records that `.Image` as `image_id`, which `scripts/post-ship-deploy.py` compares with the live container.

`release-artifact.py` therefore refuses an archive without that OCI layout, at build time in CI and in the local fallback. `docker save` writes it from Docker Engine 25 on, so a `HYPERCAL_BUILD_BACKEND=docker` builder needs Docker 25 or newer; `oci-to-docker-archive.py` writes it for the Apple `container` path. From a layout-less archive the containerd store would make up a manifest whose digest appears nowhere in the archive, so the deploy could not verify the loaded image.

The first odroid release, run 38018033717 on 2026-10-10 at about 03:07 UTC (`11bb45f7`), failed this way before the comparison was store-aware: `docker load` succeeded, then the activator stopped with `Loaded config identity mismatch` without touching the running container. Its archive's config digest is `sha256:37e13787…`, and its indexed manifest `sha256:f0828776…` (2234 bytes, `application/vnd.oci.image.manifest.v1+json`) is exactly the `.Id` the odroid reported for the loaded image.

### Deploy reliability (#823, #805)

One incident, 2026-10-24 (`evidence` in `~/.local/state/hcb-incidents/2026-10-24-deploy-818/evidence.md`): an HCB deploy overlapped an ESB deploy on the odroid, `/health` took longer than the old fixed 163 s poll, the activator rolled a healthy release back and the rollback destroyed the failed container's logs. The activator now does the following, all inside `scripts/deploy-prebuilt-image.sh` and its helpers (they ship in the release artifact, so a normal deploy updates them):

**Host deploy lock.** `scripts/odroid-deploy-lock.sh` (the same protocol is in ExpenseSyncBot) takes an advisory `flock` on `/run/lock/odroid-deploy.lock` before `docker load` and holds it through the container swap and verification. A second deploy, from either repository, WAITS (it logs `deploy-lock: ... held by: <repo> pid=... since=...` every 30 s) for up to `ODROID_DEPLOY_LOCK_MAX_WAIT` seconds (2400), then exits 75 so the job can simply be re-run. The kernel drops the lock when the holder dies, so a crashed deploy cannot wedge the host; `<lock>.owner` (repo, pid, process start ticks, start time) is informational and judged stale by pid + start ticks. The lock file is created mode 0666 so `www-data` (ESB) and root (HCB) can both open it. Manual check on the odroid: `flock -n /run/lock/odroid-deploy.lock true && echo free || cat /run/lock/odroid-deploy.lock.owner`.

**Health verdict.** `scripts/deploy-health.py` replaces the 15-poll timer. The release is accepted when the container is running, not restarting, not OOM-killed and its restart count is not climbing; `/health` is `ok`; `/ready` is `ok` or `ok (unverified)` (not required when it was already worse before this deploy, because an AI outage fails it for every image); and this holds for `HYPERCAL_HEALTH_STABLE` seconds (15). The window then also fails on a fatal log line (level >= 60) or more than 5 lines of level >= 50 since start; fewer are reported. A container that exited, was OOM-killed or restarted twice is `dead` at once, with no waiting. Otherwise the budget is `HYPERCAL_HEALTH_BASE_BUDGET` = 240 s, and it is extended only while the host is saturated (`/proc/pressure/io` some avg10 >= 20, or 1-minute load > 1.5 x cores) AND the container made progress (a new log line, or a changed probe answer) within `HYPERCAL_HEALTH_STALL` = 120 s, never past `HYPERCAL_HEALTH_HARD_CAP` = 900 s. A slow start under load is therefore not a failure; an alive-but-silent container, or one that is still not healthy at the cap, is `unhealthy` and rolled back as before. The verdict probes the container's own published port `http://127.0.0.1:3001` (the public ingress answers 502 instantly during a restart and is not what the release controls); `PUBLIC_DOMAIN` from `/opt/hypercal/.env` (last assignment wins, inline `# comment`, quotes and CR dropped) is used for one informational `PUBLIC_PROBE` line after verification. Baseline: measured starts were 45-77 s idle, 92 s for the old image under load.

**Failed-release evidence.** Before a rollback touches anything (before `docker stop`, before the force-recreate) `scripts/deploy-evidence.py failed` saves `/opt/hypercal/logs/failed-<sha12>-<UTC stamp>/` (mode 0700, root only): `container.log.gz` (the complete `docker logs`), `container.tail.redacted.log` (last 400 lines, at most 256 KiB, tokens/keys/passwords and message `text`/`caption`/`prompt`/`content` fields redacted), `inspect.json` (state, restart count, image, health, restart policy; never `Config.Env`), `receipt.json` (the last `releases/current.json`), `host-load.txt` (loadavg, PSI, `free`, `df`, `docker ps`, `vmstat`) and a one-line `state.txt`. The path is printed as `FAILED_EVIDENCE <dir>` in the job log. The same script copies the OUTGOING container's complete log to `/opt/hypercal/logs/release-<revision>-<stamp>/` before every swap, so the logs of every release survive its replacement.

**Log retention (nothing is deleted by a deploy or rollback).** After the commit point `scripts/log-retention.py --root /opt/hypercal/logs --alert` gzips old plain logs and deletes only when a criterion is violated, oldest first: managed bytes > 1024 MB, managed entries > 400, any file > 200 MB after gzip, or free space on the filesystem < 2048 MB / 5 %. It manages only `healthcheck*`/`backup*`/other top-level `*.log[.gz]` files and the `release-*` / `failed-*` directories (never `chats/`), and it never deletes the newest `release-*` (last deploy), the newest `failed-*` (last failure) or anything touched in the last 5 minutes. Exit 2 (criterion still violated with only protected entries left) and any deletion send a Telegram message to `BOT_ADMIN_ID` through `BOT_TOKEN` from `.env` (rate-limited to once per 6 h); free space within 2x of the floor warns early. This is also the disk-space watchdog: run it from root cron (`17 * * * * /opt/hypercal/scripts/log-retention.py ...`, see the install note below) so it does not depend on a deploy. Docker's own rotation stays `json-file` 50 MB x 5 per service in `docker-compose.yml` (`test/python/test_compose_logging.py`).
Root cron on the odroid runs the installed copy between deploys (the deploy installs `/opt/hypercal/scripts/log-retention.py`); add once, by hand: `crontab -l | { cat; echo '17 * * * * /opt/hypercal/scripts/log-retention.py --root /opt/hypercal/logs --env-file /opt/hypercal/.env --alert >/dev/null 2>&1'; } | crontab -` (alerts reach Telegram, so the output is not kept; running it by hand prints every action).


**Installing the activator after this change (root, by hand, with an instant rollback).** The wrapper has to know the new release files before the first release that ships them:
```bash
ssh root@odroidn2 'cp -p /usr/local/sbin/hypercal-activate-release /usr/local/sbin/hypercal-activate-release.bak-$(date +%Y%m%d-%H%M%S)'
scp scripts/odroid-activate-release.sh root@odroidn2:/usr/local/sbin/.hypercal-activate-release.new
ssh root@odroidn2 'chown root:root /usr/local/sbin/.hypercal-activate-release.new && chmod 0755 /usr/local/sbin/.hypercal-activate-release.new && mv /usr/local/sbin/.hypercal-activate-release.new /usr/local/sbin/hypercal-activate-release'
# Instant rollback: mv the newest .bak-* back over hypercal-activate-release (the wrapper is read per invocation).
```
The new wrapper is backward compatible (every new file is optional), so install it BEFORE merging the change that ships those files. Never `docker system prune`; never kill PIDs you do not own; read `docker logs`/`inspect` and the failed-evidence directory before restarting anything.

## Odroid runner

Hosted deploys run on a self-hosted runner on the odroid (#784), set up by hand when production moved there:

- Runner `odroid-hcb`, labels `self-hosted, Linux, ARM64, odroid-hcb`, registered for this repository only and installed at `/var/lib/hcb-runner/actions-runner` as the Unix user `hcb-runner` (not in the docker group, no general sudo). Jobs run under `/var/lib/hcb-runner/actions-runner/_work/`. The runner needs bash and python3; it has no docker access and no `gh` CLI.
- Only `deploy.yml`'s `deploy` job targets it, and only for pushes to `main`. No workflow triggered by `pull_request` may use a self-hosted label (`test/regressions/hosted-release-contract.test.ts` checks every workflow). The one self-hosted job a pull request can cause is the per-PR stage QA, and it runs on its own runner and label, reached only through a `workflow_run` workflow from `main` that carries a SHA and never code: see "Stage QA". The repository's fork pull-request approval policy is `all_external_contributors`.
- Root activation wrapper: `scripts/odroid-activate-release.sh`, installed by hand after each change to it (deploys never update it):
  ```bash
  install -o root -g root -m 0755 scripts/odroid-activate-release.sh /usr/local/sbin/hypercal-activate-release
  ```
- `/etc/sudoers.d/hcb-runner` holds exactly:
  ```
  hcb-runner ALL=(root) NOPASSWD: /usr/local/sbin/hypercal-activate-release
  ```
- The job's only deploy step is
  ```bash
  printf '%s\n' "$GH_TOKEN" | sudo -n /usr/local/sbin/hypercal-activate-release "$RELEASE_SHA"
  ```
  with the job's `GITHUB_TOKEN` (`permissions: actions: read, contents: read, statuses: read`). The token is passed on stdin (`printf` is a shell builtin) and the SHA is the only argument.
- Release pin: after `actions/upload-artifact` in the GitHub-hosted `build` job, the step "Record the release artifact on the commit" posts a commit status on the SHA: context `release-artifact`, state `success`, description `artifact <id> sha256:<hex>` (upload-artifact v4.6.2 outputs the digest as bare hex, so the step adds the prefix), and target URL `https://github.com/<repo>/actions/runs/<run id>`. Only `build` has `statuses: write`. The deploy job can read statuses but not write them. Anything running on the odroid runner can upload more `release-<sha>` artifacts into the same run, but cannot post that status.
- Trust model: root trusts nothing from the runner except that SHA, and the token is used only to authenticate GitHub API calls. The wrapper (constants fixed in the file: repository `alex-mextner/HyperCalendarBot`, workflow `.github/workflows/deploy.yml`, `https://api.github.com`, `/opt/hypercal`, the image name):
  1. refuses unless `main` points at the SHA (`superseded: main is …`);
  2. reads the commit's statuses (newest first) and takes the newest `release-artifact` one. It requires state `success`, creator `github-actions[bot]`, a description matching exactly `artifact <id> sha256:<64 hex>` and a target URL that is a run of this repository. After "Re-run all jobs", the rerun's newer status names the rerun's artifact;
  3. fetches that artifact by id and requires: name `release-<sha>`, not expired, the digest the status names, and an upload by the run the status links to. That run must have `event` `push`, `head_branch` `main`, `head_sha` the SHA, `path` `.github/workflows/deploy.yml`, and this repository as both `repository` and `head_repository`. A `pull_request_target` run also reports `head_branch` `main`; the event and path checks exclude it;
  4. downloads the artifact zip, following at most 3 redirects itself and never sending the token past the first request, so it does not reach the storage host. It streams the zip into a fresh root-owned `0700` stage `/opt/hypercal/.incoming-<sha>-<time>-<pid>` (each file at most 4 GiB actually written) and refuses unless its sha256 equals that digest;
  5. extracts only the known release paths (`image.tar.gz`, `docker-compose.yml`, `Caddyfile`, `artifact.json`, the six core `scripts/` files the build copies, and the optional helper files named in the wrapper's `OPTIONAL_SCRIPTS` / `OPTIONAL`: `odroid-deploy-lock.sh`, `deploy-health.py`, `deploy-evidence.py` and `log-retention.py`), never names taken from the zip, then deletes the zip. The helpers are optional only for the wrapper: `deploy-prebuilt-image.sh` refuses a release that lacks one it needs, so a release built before them still unpacks but the new activator never runs without them;
  6. computes the archive sha256 and, with the staged `scripts/release-artifact.py`, the image config digest, and runs the staged `scripts/deploy-prebuilt-image.sh` with an empty environment at `nice 10` / `ionice -c2 -n7`. It returns the activator's exit code and always removes the stage. Refusals exit 2.

  Residual risk: code running as `hcb-runner` (a job, or a process a job left behind) can at most redeploy the release that main's GitHub-hosted build job recorded. Artifacts it uploads itself are never deployed, and it cannot supply files, scripts or checksums. The `release-artifact` status itself can be posted only by a token with `statuses: write`: the hosted build job, or a collaborator with write access (whose branch workflows can request that permission). Combined with a backdoor planted on the runner, a malicious write collaborator could still reach root here; fork pull requests cannot (their tokens are read-only). While the zip and the extracted image are both on disk, a deploy needs about twice the archive size free under `/opt/hypercal`.
- Secrets never go on a command line in a job that runs here: every local user can read process argument lists (`ps`, `/proc/*/cmdline`). The token reaches the wrapper on stdin. A job's environment is readable too (`/proc/<pid>/environ`) by anything running as `hcb-runner`. So a job on a self-hosted runner, in any workflow, gets no secret except its short-lived `GITHUB_TOKEN`. The deploy success and failure notifications (`BOT_TOKEN`, `BOT_ADMIN_ID`, `ADMIN_ALERT_TOKEN`) run in the GitHub-hosted jobs `notify-success` and `notify-failure`. `test/regressions/hosted-release-contract.test.ts` checks the secrets rule across all workflows. It and `test/python/test_odroid_activate_release.py` also look for the token in every process's argv during the run.
- The four self-hosted runner services on the odroid (the three other repositories' runners and `odroid-hcb`) have the systemd drop-in `50-yield-to-services.conf` (`CPUWeight=20`, `IOWeight=20`, `MemoryHigh=1200M`), and the microSD card `mmcblk0` uses the BFQ I/O scheduler (`/etc/udev/rules.d/60-mmc-bfq.rules`), so runner jobs and deploys yield to the live bots. The stage QA runner (`qa-pc`, see "Stage QA") runs on the owner's PC, not on the odroid.
- The nightly backup is root cron `0 3 * * *` on the odroid, in its local time zone Europe/Berlin.

### DO rollback copy

The droplet kept the pre-move state, untouched since the bot stopped there at 2026-10-09 22:27:25 UTC: `/opt/hypercal/data` (SQLite + WAL as of that stop, including `backups/calendar_2026-10-09_22-27-22.db.gz`), `/opt/hypercal/logs`, the stopped `hypercal-redis` container (restart policy `no`) with volume `hypercalinvntrmru_redis-data`, and the full production `/opt/hypercal/.env` (the watchdog also reads it). Its compose file is `/opt/hypercal/docker-compose.yml.moved-to-odroid`; `/opt/hypercal/MOVED-TO-ODROID.md` explains the move.

To roll back: stop the bot on the odroid first. If the odroid wrote anything after 22:27 UTC (it serves all traffic since 22:30), copy the odroid's `/opt/hypercal/data` back to DO before starting there. Then rename the DO compose file back to `docker-compose.yml`, run `docker compose up -d` in `/opt/hypercal`, and point the DO Caddyfile back at `localhost:3001`. DO is amd64: only an amd64 image already on DO, or one built for amd64 by hand, runs there; CI and the local fallback build arm64 only.

## PR CI (full test, lint and typecheck gate)

`.github/workflows/pr-ci.yml` (job `test`) runs on every same-repository pull request to `main` the same gate that `deploy.yml`'s `test` job runs after merge: Bun 1.4.2, ffmpeg, `bun install --frozen-lockfile` as the first and only dependency install (a `package.json` change without the matching `bun.lock` fails the job, GH-870), Playwright `chromium-headless-shell`, full `bun test`, `bun run lint` and `tsc --noEmit`. Before this, a PR ran none of them and a red suite surfaced only on the push to `main`, after merge. The workflow has a read-only token, no secrets and no self-hosted runner, skips fork PRs, and cancels the previous run when a PR gets a new push. It replaces the branch-gated GH-359 stub `pr-gh359-validation.yml`, which was always skipped. `test/scripts/bun-version-pin.test.ts` keeps its Bun pin equal to the other pins; `test/scripts/workflow-install-order.test.ts` keeps this install step identical in `deploy.yml` and `pr-ci.yml`.

Apt is bounded in `pr-ci.yml`. On 2026-10-27 the azure Ubuntu mirror was slow, not down: the unbounded `apt-get update && install ffmpeg` step took 12 minutes 24 seconds in PR CI run 40573146944 (normally about 20 seconds) and was still running after 15 minutes in run 40573388213, with no log output; a first 300-second ceiling (run 40576298443) was exceeded while the log still showed ffmpeg's dependencies downloading one by one (about 14 MB in the last 17 seconds, a 5.8 MB package in 28), so the ceilings now sit above the slow case. The job has `timeout-minutes: 75`, a step writes `Acquire::Retries`/`Timeout` settings into `/etc/apt/apt.conf.d/99-ci-bounded` (which also bounds Playwright's own apt calls, each 25 minutes), ffmpeg is installed only when `ffmpeg -version` fails (`apt-get update` 300 s, install 1200 s, step 25 minutes), and the step then runs `ffmpeg -version` again: an unusable ffmpeg fails the job, tests are never skipped or stubbed. `deploy.yml`'s `test` job still has the old unbounded step because it did not stall.

This is the hosted check only. Agents still validate the exact PR head with the full suite on Runpod (AGENTS.md § Heavy work runs on Runpod), never a full `bun test` on the shared workstation.

## Stage QA (per pull request, #840)

Every same-repository, non-draft PR gets a stage bot, `@HyperCalendarStageBot`, running that PR's exact head, and a QA run that drives it with real Telegram messages through qa-cli. The result is the commit status `stage-qa` on the head SHA. `gh ship` refuses unless it is green for the exact head; after that it simply deploys. Nothing of this sits inside the production deploy (`deploy.yml`, the activator and its wrapper know nothing about the stage). There is no Telethon session and no 2FA step: the QA account is the Telegram Web login qa-cli already holds on the owner's PC (`qa telegram status`).

**Pipeline.**
1. `.github/workflows/stage-build.yml` (`Stage build`, `pull_request`, GitHub-hosted arm64, no secret, no package access) marks `stage-qa` pending, builds the image of the exact head without pushing anything (`push: false`, tag `ghcr.io/alex-mextner/hypercalendarbot-stage:<sha>`), and uploads the artifact `stage-<sha>` with `image.tar.gz`, `stage-smoke-cases.json` and, when the repository has it, `stage-smoke-cases.replay.json`. Forks, drafts and bot-authored PRs are skipped. While `stage-qa.yml` is not on the default branch yet, no pending status is posted (bootstrap).
   The image tag is registry-qualified (`ghcr.io/alex-mextner/hypercalendarbot-stage:<sha>`) and never pushed: docker normalises a bare name to `docker.io/library/...`, and the archive check compares the exact name the archive carries (the first run of this workflow failed on exactly that with a bare tag).
2. `.github/workflows/stage-qa.yml` (`Stage QA`, `workflow_run` of `Stage build`) always runs the copy on `main`. Job `qa` ("Stage QA run") runs on the self-hosted runner labelled `qa-pc` on the owner's PC and does one thing: `printf '%s\n' "$GH_TOKEN" | "$HOME/.local/bin/hypercal-stage-qa-pc" "$HEAD_SHA"`. Job `report` (GitHub-hosted, the only job with `statuses: write`) posts `stage-qa`: `success` as `passed cases=<n> run=<qa run id>`, `failure` for a failed case or build, `error` when the QA could not run (refused, not provisioned, lock wait timed out, no driver), nothing for a superseded or cancelled run.
3. The PC driver (`scripts/stage-qa-pc.py`, installed by hand from `main`) takes the PC's qa-cli lock (the other repository's stage run and this one share it: one browser session at a time), then opens one ssh connection to the odroid with a key whose `authorized_keys` entry is `restrict,command="/usr/local/sbin/hypercal-stage-qa"`: the only thing that key can do is start the root wrapper with a commit SHA.
4. The root wrapper (`scripts/odroid-stage-qa.sh`) trusts only that SHA and the token. It takes the stage lock (`/run/lock/hypercal-stage.lock`; PRs queue here), verifies through the GitHub API that the SHA is the head of an open, non-draft PR of this repository, finds the `Stage build` run itself (event `pull_request`, path `stage-build.yml`, success, this repository as head and base), takes its one `stage-<sha>` artifact (digest, size, run and SHA checked, redirect without the token), extracts only the fixed member names and checks the image with `release-artifact.py`. Only then it takes the host deploy lock (the one HyperCalendarBot and ExpenseSyncBot deploys use), re-checks the head, loads the image, builds `stage/bot.env` from the stage bot's token and an allow-list of AI-provider keys of the production `.env` (no Telegram, Google, e-mail, MTProto, inline or `PUBLIC_DOMAIN` key), wipes the stage SQLite file, starts `docker-compose.stage.yml` (project `hypercalstage`: own Redis with its own password, own data directory, `127.0.0.1:3002`, 768 MB, no webhook so it long-polls), waits for health with the multi-signal verdict of deploys, runs the guard (`stage-smoke.py guard`) and prints `STAGE_READY {json}` with the validated cases, then waits for `DONE` (or the end of the ssh connection). The stage instance exists only while both locks are held and never overlaps a production deploy.
5. The driver checks the READY line against its own config (stage username, deny list, case floor), runs the cases with `stage-smoke.py run` (`qa telegram chat send|wait|read` against the stage bot's numeric id; the replies are read from the web UI, so blockquote text is readable), writes the receipt, sends `DONE`, and prints the last line `STAGE_QA_RESULT status=… sha=… cases=… failed=…`. The wrapper then saves evidence and tears the stage down, always (pass, fail, cancel, timeout, dropped connection).
6. Exit codes: 0 passed; 1 health or a case failed (the PR is wrong); 2 refused (verification or a guard failed); 3 not runnable (`STAGE_QA_NOT_PROVISIONED`: config, key or `stage.env` missing, qa-cli not logged in); 75 a lock wait timed out (re-run the workflow); 76 superseded.
7. Logs are never deleted by a run. Teardown first copies the stage container's complete log to `/opt/hypercal/stage/evidence/release-stage-<sha12>-<stamp>/` and, after a failure, a redacted failure bundle `failed-<sha12>-<stamp>/` (same helper as deploys, a separate root so the production evidence's "newest" protection is untouched); the bot's own files stay in `/opt/hypercal/stage/logs`; the PC keeps `~/.local/state/hypercal-stage-qa/receipts/<sha>.json` (case names, counts and latencies only). Rotation is by size and free space only (`log-retention.py`), see Install.

**Cases.** `scripts/stage-smoke-cases.json` is the PR's own list (a PR may add cases, e.g. for the behaviour it changes). The PC driver and the wrapper both enforce a floor the PR cannot go below: at least 5 cases and the names `start`, `ping`, `today-read-only-calendar`, `simple-intent-phrase`, `validation-search-without-query`. `expect`/`forbid` are regexes over the reply text, `max_first_reply_s` bounds latency. No case changes the calendar. History replay hook: a file `scripts/stage-smoke-cases.replay.json` with cases of the same schema (plus an optional `source` label) is built into the artifact and appended after the base cases; it cannot reuse a base name or fill the floor. The builder for the real historical corpus only has to write that file; nothing depends on it today.

**Guards.** Odroid side (`stage-smoke.py guard`): the target username comes from `stage.env`, differs from `HyperCalendarBot` and the production env's `BOT_USERNAME`, contains `stage` or `stg`, its token's bot id differs from the production token's, and Telegram's `getMe` for that token answers with that username. PC side (`stage-smoke.py run` and the driver): the username must equal the one in the PC's own config, must not be on its deny list (`HyperCalendarBot`), must contain `stage`/`stg`, and `qa telegram chat` itself refuses writes to anything that is not a bot chat. An empty or shorter list than the floor is refused, never passed.

**Trust boundary (public repository).** A PR's code runs only on GitHub-hosted runners (build) and, as a container with the stage bot's token and the AI keys, on the odroid. It never runs as a process on the PC or as a runner user: `stage-qa.yml` checks nothing out and downloads nothing, its YAML always comes from `main`, the PC driver and the wrapper come from a reviewed `main` checkout, and `test/regressions/stage-qa-workflows.test.ts` plus `hosted-release-contract.test.ts` pin that. The PR supplies an image and a case list (data, validated on both sides; texts are passed to qa-cli as one argv element, never through a shell). Residual risk: a collaborator with write access (the same people who can already push workflows that request `statuses: write`) controls the image and the case list of their own PR; fork PRs are excluded by the same-repository checks at the workflow, the wrapper and the ship gate, and by the `all_external_contributors` approval policy. `gh ship` does not trust the status alone: `scripts/stage-qa-gate.py` requires creator `github-actions[bot]`, a description naming the run, and that run to be a `workflow_run` run of `stage-qa.yml` for the exact head with a successful `Stage QA run` job; a status a PR workflow posts cannot satisfy that.

**How `gh ship` binds the QA run to the PR head (#865).** `.claude/scripts/pr-ship.sh` runs `scripts/stage-qa-gate.py` from `origin/main`, never from the PR checkout, so a PR cannot edit its own gate. The gate accepts the status only when: the PR is open, non-draft, same-repository and the head it is asked about; the newest `stage-qa` status on that head is `success`, created by `github-actions[bot]`, described `passed cases=<n> run=<id>` with the exact target URL of that run; the run is `.github/workflows/stage-qa.yml`, event `workflow_run`, completed/success, `repository` and `head_repository` this repository and `head_branch` the default branch; the run has exactly one job `Stage QA run`, completed/success, of that run and attempt, whose steps are `Set up job` (1) and `Run the stage QA through qa-cli` (2, success); and the tested head is the one the runner printed for that step. The last point cannot use the run's REST `head_sha`: a `workflow_run` run reports the default branch commit there (with empty `pull_requests`/`referenced_workflows` and the title `Stage QA`), the tested PR head is only an event value the workflow hands to the step as `HEAD_SHA`. The gate therefore reads the head of the QA job's log (`gh api repos/<repo>/actions/jobs/<id>/logs`, which follows GitHub's signed redirect; at most the first 256 KiB, in memory, never printed) and takes the first `##[group]Run ` group, the runner's header of step 2, which the runner writes before the trusted shell executes anything: exactly one `  HEAD_SHA: <40 lowercase hex>` line in its `env:` block must equal the PR head. Whatever the driver or the stage bot prints afterwards (including a forged header) is never read. A missing or duplicated header, another SHA, an unreadable, expired (GitHub deletes logs after its retention period; re-run Stage QA), empty, truncated or unrecognised log, or any API error refuses the ship (exit 1 for evidence that does not match, exit 2 when the gate cannot evaluate); there is no fallback to a weaker check, and the local PC receipt is never evidence. The log binding exists because PR 853's cleaner route, naming each run `Stage QA <sha>` through `run-name` and binding `display_title`, cannot bootstrap (the workflow is always `main`'s copy, so the PR that introduces it still runs with the plain title); once that lands and has produced runs, the gate can bind `display_title` instead and drop the log read. The status time window is only corroboration (a forged `success` can land inside it): the gate also reads the header of the report job's first step, `Post the stage-qa status`, and requires its env block to declare each of `HEAD_SHA` (the PR head), `RUN_ID` (the run in the status), `BUILD_CONCLUSION=success`, `QA_RESULT=success`, `QA_RC=0` and `QA_CASES` (equal to the `cases` in the status) exactly once, so a forged status cannot claim a pass the workflow did not decide (for example the QA step exiting 0 with zero cases, which the workflow reports as `error`).

**Why the QA runs on the PC (decided with evidence, tg#25056).** The Telegram Web session of qa-cli (`~/.agent-browser/sessions/qa-telegram-qa-telegram.json`, logged in 2026-10-25) lives on the PC, and the PC is an always-on host: `systemctl --user` runs its services around the clock (linger on, uptime of days), including the alert watcher of #835. Copying the session to the odroid was not tried on purpose: Telegram invalidates an auth key that is used from two addresses at once, and a test would risk ending the owner's only login (re-login is a QR scan by hand); the odroid also has no spare memory for a headless Chromium. If the PC is off, the `qa` job stays queued, `stage-qa` stays pending and `gh ship` refuses: it fails closed.

**Install on the odroid (root, by hand, from a checkout of merged `main`; backups and rollback are printed).**
```bash
ssh root@odroidn2   # then, in a checkout of main at the merged SHA:
scripts/install-stage-qa.sh    # copies the lib files into /usr/local/lib/hypercal-stage/ and the entry to /usr/local/sbin/hypercal-stage-qa
```
It holds the stage lock while it swaps, keeps the previous lib dir and entry as `.bak-<stamp>` and prints the rollback command. Re-run it after every change to the installed files (`stage-smoke.py`, `docker-compose.stage.yml`, `stage-fetch-artifact.py`, `stage-qa-run.sh`, `odroid-stage-qa.sh`, the lock/health/evidence helpers): merging such a change does not update the odroid.
- Add once to `/root/.ssh/authorized_keys` (backup first): the line `scripts/install-stage-qa-pc.sh` prints, `restrict,command="/usr/local/sbin/hypercal-stage-qa" ssh-ed25519 AAAA… hypercal-stage-qa-pc`. The key can run nothing but the wrapper, which accepts a 40-hex SHA only (`SSH_ORIGINAL_COMMAND`).
- Root cron (once): `23 * * * * /usr/local/lib/hypercal-stage/log-retention.py --root /opt/hypercal/stage/evidence >/dev/null 2>&1` and the same with `--root /opt/hypercal/stage/logs`.
- Provisioned already: `/opt/hypercal/stage/stage.env` (stage bot token, username, Redis password).

**Install on the PC (the normal user, from a checkout of merged `main`).**
```bash
scripts/install-stage-qa-pc.sh   # lib dir ~/.local/lib/hypercal-stage-qa, entry ~/.local/bin/hypercal-stage-qa-pc, config ~/.config/hypercal-stage-qa/config.json, ssh key
```
- Runner: an Actions runner for this repository with the label `qa-pc`, installed under `~/actions-runner-hcb-qa` and run as a user systemd service (`systemctl --user`, linger is on). Only `stage-qa.yml` targets that label (`stage-qa-workflows.test.ts`); no `pull_request` workflow may.
- qa-cli must be logged in (`qa telegram status` prints `logged-in`). Nothing else is needed: no 2FA, no Telethon session.
- Other users of `qa telegram chat` on the PC (tg-cli e2e, agents) use the same agent-browser session `qa-telegram-chat`; do not run them while a stage run is in progress (the driver's lock covers only stage runs).

**Operations.** A red `stage-qa` on a PR is a verdict on that PR: open the `Stage QA` run linked from the status (the job log has every case's PASS/FAIL line; the evidence path is on the odroid). `error` means the QA could not run: not provisioned (qa-cli logged out, config), lock wait timeout (re-run the workflow), refused (read the reason in the log). A stuck stage instance is torn down by the next run (it removes leftovers first); to do it by hand: `docker rm -f hypercal-bot-stage hypercal-stage-redis`. If the stage infrastructure is broken, fix it; the ship gate has no bypass. The repository owner can still merge by hand with `gh pr merge --squash --match-head-commit <sha>`, and the normal deploy follows. To revoke the QA login: Telegram, Settings, Devices, terminate the Web session; then `qa telegram login` again. A dedicated QA Telegram account would keep this off the owner's personal account; qa-cli supports it by logging in with that account instead.

## Dockerfile

- Base: `debian:bookworm-slim` + bun installed via `bun.sh/install` script (version pinned).
- NOT `oven/bun:1-debian` — bun Docker Hub tags lag behind releases.
- `ln -s bun node` required — Playwright CLI uses `#!/usr/bin/env node`.
- `bun install --ignore-scripts` — skips lefthook postinstall (needs git, absent in Docker).

## bun lockfile and --frozen-lockfile

The committed `bun.lock` is frozen-installable on linux (verified 2026-10-27 with Bun 1.4.2: `bun install --frozen-lockfile` exits 0 and leaves `bun.lock` byte-identical, and the same command exits 1 with `lockfile had changes, but lockfile is frozen` once `package.json` gains a dependency the lock lacks). The earlier note that a macOS arm64 lockfile fails on linux came from platform-specific optional dependencies (`@rollup/rollup-darwin-arm64` vs `@rollup/rollup-linux-x64-gnu`) that the manifest no longer contains. If a new dependency brings back a platform-dependent lock, regenerate `bun.lock` with a normal commit; do not weaken the CI check.

- **CI** (linux, `deploy.yml` and `pr-ci.yml`): `bun install --frozen-lockfile` as the first install. Never run a plain `bun install` before it: that rewrites `bun.lock` in the runner and the frozen check then passes on a lockfile nobody committed (GH-870). The install keeps lifecycle scripts, so `scripts/install-git-hooks.sh` runs as on a developer checkout.
- **Docker** (linux): `bun install --ignore-scripts` with the copied `bun.lock` — respects the lockfile's version pins and skips the lefthook postinstall (no git in the image).
- **Local**: `bun install --frozen-lockfile` to reproduce CI; a plain `bun install` only when you are deliberately updating `bun.lock`.
- **Local release fallback** (`scripts/deploy-local-fallback.sh`): `bun install --frozen-lockfile --ignore-scripts` — the same frozen check, without lifecycle scripts because it builds a release, not a developer checkout.

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
