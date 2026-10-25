#!/usr/bin/env bash
# Remote prebuilt-image activation only: no compiler, package install, or registry credentials.
set -euo pipefail

DEPLOY_PATH="${1:?Deployment directory required}"
REMOTE_SRC="${2:?Release staging directory required}"
IMAGE="${3:?Image name required}"
SHA="${4:?Source revision required}"
ARCHIVE_SUM="${5:?Archive checksum required}"
CONFIG_ID="${6:?Image config identity required}"
# Validate ownership BEFORE arming any cleanup trap or touching the live service.
# Hosted runs and the local fallback stage under DEPLOY_PATH; /tmp/hypercal-source-* is the
# fallback's namespace before #784 (the odroid's /tmp is a small RAM tmpfs).
python3 - "$DEPLOY_PATH" "$REMOTE_SRC" "$SHA" <<'PYGUARD'
from pathlib import Path
import re
import sys

raw_root, raw_stage = Path(sys.argv[1]), Path(sys.argv[2])
revision = sys.argv[3]
try:
    root, stage = raw_root.resolve(strict=True), raw_stage.resolve(strict=True)
except OSError:
    raise SystemExit("Release paths must already exist; no cleanup armed")
if (not raw_root.is_absolute() or not raw_stage.is_absolute()
        or not root.is_dir() or not stage.is_dir() or raw_stage.is_symlink()
        or root == Path("/") or stage == root or stage in root.parents
        or not re.fullmatch(r"[0-9a-f]{40}", revision)):
    raise SystemExit("Unsafe release staging path; no cleanup armed")
hosted = (stage.parent == root
          and re.fullmatch(r"\.incoming-" + revision + r"-\d+-\d+", stage.name))
local = (stage.parent == Path("/tmp").resolve()
         and re.fullmatch(r"hypercal-source-" + revision[:12] + r"-\d+", stage.name))
if not (hosted or local):
    raise SystemExit("Staging is outside the owned release namespaces; no cleanup armed")
PYGUARD
SHORT_SHA="${SHA:0:12}"
STAMP="$(date +%Y-%m-%d_%H-%M-%S)"
trap 'rm -rf "$REMOTE_SRC"' EXIT
exec 9>"$DEPLOY_PATH/.release.lock"
flock -n 9 || { echo 'Another release owns this service' >&2; exit 1; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for helper in odroid-deploy-lock.sh deploy-health.py deploy-evidence.py log-retention.py; do
  [[ -f "$SCRIPT_DIR/$helper" ]] || { echo "Release is missing scripts/$helper; the build must ship it (docs/reference/deploy-runbook.md, Release files)" >&2; exit 1; }
done
# shellcheck source=odroid-deploy-lock.sh
source "$SCRIPT_DIR/odroid-deploy-lock.sh"
[[ "$(sha256sum "$REMOTE_SRC/image.tar.gz" | cut -d ' ' -f1)" == "$ARCHIVE_SUM" ]] || { echo 'Archive checksum mismatch' >&2; exit 1; }
python3 "$REMOTE_SRC/scripts/release-artifact.py" "$REMOTE_SRC/image.tar.gz" "$SHA" "$IMAGE:$SHA" > "$REMOTE_SRC/artifact.json"
[[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["config_digest"])' "$REMOTE_SRC/artifact.json")" == "$CONFIG_ID" ]] || exit 1
# Both repositories deploy to this one box: serialize with the other one's image load and swap (#823).
odroid_deploy_lock_acquire hcb || exit $?
# docker load unpacks the whole archive before it registers the layers, so it needs about twice
# the unpacked image free on the Docker root. Refuse here, with the numbers, rather than fail
# halfway with a bare "no space left on device" as the 2026-09-28 release did (#481).
IMAGE_BYTES="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["image_bytes"])' "$REMOTE_SRC/artifact.json")"
DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}')"
FREE_KIB="$(df -Pk "$DOCKER_ROOT" | awk 'NR == 2 {print $4}')"
[[ "$FREE_KIB" =~ ^[0-9]+$ ]] || { echo "Cannot read free space on $DOCKER_ROOT" >&2; exit 1; }
if (( FREE_KIB * 1024 < 2 * IMAGE_BYTES )); then
  echo "Not enough disk to load the release: $((FREE_KIB * 1024)) bytes free on $DOCKER_ROOT, need $((2 * IMAGE_BYTES)) (twice the $IMAGE_BYTES-byte image). Remove superseded $IMAGE tags first (docs/reference/deploy-runbook.md, Disk space)." >&2
  exit 1
fi
# Docker's image store decides what `.Id` and a container's `.Image` are: the config digest on the
# classic store, the digest of the manifest the archive's index.json names on the containerd store
# (Docker 29 on the odroid, which other projects share, so its store stays). Comparing the config
# digest there refused the first odroid release (run 38018033717, #784). release-artifact.py read
# both digests from the verified archive; compare against the one this daemon uses.
DRIVER_STATUS="$(docker info --format '{{json .DriverStatus}}')"
EXPECTED_IMAGE_ID="$(python3 - "$DRIVER_STATUS" "$REMOTE_SRC/artifact.json" <<'STORE'
import json,sys
status,artifact=sys.argv[1:]
containerd=["driver-type","io.containerd.snapshotter.v1"] in (json.loads(status) or [])
print(json.load(open(artifact))["manifest_digest" if containerd else "config_digest"])
STORE
)"
[[ "$EXPECTED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "Release image identity is not a sha256 digest: $EXPECTED_IMAGE_ID" >&2; exit 1; }
docker load -i "$REMOTE_SRC/image.tar.gz"
LOADED_ID="$(docker image inspect "$IMAGE:$SHA" --format '{{.Id}}')"
[[ "$LOADED_ID" == "$EXPECTED_IMAGE_ID" ]] || { echo "Loaded image identity mismatch: loaded=$LOADED_ID expected=$EXPECTED_IMAGE_ID" >&2; exit 1; }
CURRENT_IMAGE_ID="$(docker inspect hypercal-bot --format '{{.Image}}' 2>/dev/null)" || { echo 'Existing HyperCalendar container is required; use a reviewed first-install procedure' >&2; exit 1; }
ROLLBACK_TAG="$IMAGE:rollback-$STAMP"
docker tag "$CURRENT_IMAGE_ID" "$ROLLBACK_TAG"
# Generic image rollback is safe only while the old image still works on the database the release
# may already have migrated. scripts/migration-gate.py therefore accepts unchanged migration code,
# or new migrations whose shipped docs declare "rollback-compatible: yes" and "data-deletion: no",
# and logs one SCHEMA_GATE audit line. A reviewed migration procedure can accept more by naming
# the one transition it reviewed, as HYPERCAL_REVIEWED_SCHEMA_TRANSITION="<running sha256>:<release
# sha256>" of migrations.ts; hosted CI and the local fallback never set it.
GATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/migration-gate.py"
ROLLBACK_GUARD="$REMOTE_SRC/rollback-guard"
python3 "$GATE" check hypercal-bot "$IMAGE:$SHA" "${HYPERCAL_REVIEWED_SCHEMA_TRANSITION:-}" "$ROLLBACK_GUARD" \
  || { echo 'Schema-changing release requires reviewed migration procedure' >&2; exit 1; }
CONFIG_BACKUP="$DEPLOY_PATH/releases/config-$SHA-$STAMP"
mkdir -p "$CONFIG_BACKUP/scripts"
cp "$DEPLOY_PATH/docker-compose.yml" "$DEPLOY_PATH/Caddyfile" "$CONFIG_BACKUP/"
for script in backup-db.sh healthcheck-alert.sh prepare-runtime-dirs.sh; do
  [[ ! -f "$DEPLOY_PATH/scripts/$script" ]] || cp "$DEPLOY_PATH/scripts/$script" "$CONFIG_BACKUP/scripts/"
done
restore_host_files() {
  cp "$CONFIG_BACKUP/docker-compose.yml" "$CONFIG_BACKUP/Caddyfile" "$DEPLOY_PATH/" || return 1
  for name in backup-db.sh healthcheck-alert.sh prepare-runtime-dirs.sh; do
    if [[ -f "$CONFIG_BACKUP/scripts/$name" ]]; then
      cp "$CONFIG_BACKUP/scripts/$name" "$DEPLOY_PATH/scripts/$name" || return 1
    else
      rm -f "$DEPLOY_PATH/scripts/$name" || return 1
    fi
  done
}

HEALTH=""
READY=""
VERDICT_REASON=""
# The verdict probes the bot's own published port on this host: the public ingress (Cloudflare tunnel,
# proxy) answers 502 instantly while the container restarts and is not what this release controls.
# PUBLIC_DOMAIN (root-only .env; last assignment wins, inline " #comment", quotes, CR and spaces
# dropped) is only used for one informational public probe after verification.
HEALTH_URL=http://127.0.0.1:3001
PUBLIC_DOMAIN_VALUE="$(sed -n 's/^PUBLIC_DOMAIN=//p' "$DEPLOY_PATH/.env" 2>/dev/null | tail -n 1 | sed 's/[[:space:]]#.*$//' | tr -d "\"' \r" || true)"
ready_acceptable() { case "$1" in ok|"ok (unverified)") return 0 ;; *) return 1 ;; esac; }
# The multi-signal verdict lives in scripts/deploy-health.py (container state, restart count,
# /health, /ready against its pre-deploy value, fresh error logs, load-aware budget); a slow start
# is not a failure, a dead or crash-looping container is. $1 = "health" skips /ready (rollback).
# Sets HEALTH, READY and VERDICT_REASON from its RESULT line; returns its exit status.
wait_for_bot() {
  local out="$REMOTE_SRC/health.out" rc line
  python3 "$SCRIPT_DIR/deploy-health.py" wait --container hypercal-bot --url "$HEALTH_URL" \
    --mode "$1" --baseline-ready "${BASELINE_READY:-}" \
    --base-budget "${HYPERCAL_HEALTH_BASE_BUDGET:-240}" --hard-cap "${HYPERCAL_HEALTH_HARD_CAP:-900}" \
    --poll "${HYPERCAL_HEALTH_POLL:-4}" --stable "${HYPERCAL_HEALTH_STABLE:-15}" \
    --stall "${HYPERCAL_HEALTH_STALL:-120}" | tee "$out" >&2
  rc="${PIPESTATUS[0]}"
  line="$(sed -n 's/^RESULT //p' "$out" | tail -n 1)"
  HEALTH=""; READY=""; VERDICT_REASON="${line#*reason=}"
  if [[ "$line" =~ health=(.*)\ ready=(.*)\ elapsed= ]]; then
    HEALTH="${BASH_REMATCH[1]}"; READY="${BASH_REMATCH[2]}"
    [[ "$HEALTH" != '<none>' ]] || HEALTH=""
    [[ "$READY" != '<none>' ]] || READY=""
  fi
  return "$rc"
}

# The previous image ID alone does not show a running bot. Readiness is reported, not required:
# an AI provider outage fails it for every image. CURRENT_IMAGE_ID and the restored container's
# .Image both come from this daemon, so they are the same kind of ID on either image store.
restore_image() {
  printf 'services:\n  bot:\n    image: "%s"\n' "$CURRENT_IMAGE_ID" > "$REMOTE_SRC/rollback.yml"
  (cd "$DEPLOY_PATH" && docker compose -f docker-compose.yml -f "$REMOTE_SRC/rollback.yml" up -d --no-deps --no-build --pull never --force-recreate bot) || return 1
  restored="$(docker inspect hypercal-bot --format '{{.Image}}' 2>/dev/null)"
  wait_for_bot health
  printf 'ROLLBACK image=%s health=%s ready=%s data=preserved\n' "$restored" "${HEALTH:-<none>}" "${READY:-<none>}" >&2
  [[ "$restored" == "$CURRENT_IMAGE_ID" && "$HEALTH" == ok ]] && return 0
  echo "ROLLBACK FAILED: the container is not the previous image $CURRENT_IMAGE_ID answering /health=ok; the bot may be down" >&2
  return 1
}

# The rollback guard lists accepted migrations that do not declare rollback-compatible: yes (only
# a reviewed override accepts them). The old image may start only on a database that records none
# of them: stop the release first so none can commit after the read, and when any is recorded, or
# the read fails, start the release again and leave it to the migration doc's Rollback section.
old_image_may_run() {
  [[ -s "$ROLLBACK_GUARD" ]] || return 0
  # A release that already exited can fail `docker stop`; what matters is that it no longer runs.
  docker stop hypercal-bot >/dev/null 2>&1
  [[ "$(docker inspect hypercal-bot --format '{{.State.Running}}' 2>/dev/null)" == false ]] \
    && python3 "$GATE" unapplied "$CURRENT_IMAGE_ID" "$DEPLOY_PATH/data" "$ROLLBACK_GUARD" && return 0
  docker start hypercal-bot >/dev/null \
    || echo 'ROLLBACK FAILED: the release could not be started again; the bot may be down' >&2
  printf 'ROLLBACK_SKIPPED image=%s: the database may hold %s, which the old image is not declared to survive; follow the Rollback section of docs/reference/migrations/<name>.md\n' \
    "$(docker inspect hypercal-bot --format '{{.Image}}' 2>/dev/null)" "$(paste -sd ' ' "$ROLLBACK_GUARD")" >&2
  return 1
}

switched=0
rollback() {
  rc=$?
  trap - EXIT INT TERM
  set +e
  if [[ "$rc" != 0 && "$switched" == 1 ]]; then
    # Evidence first: the rollback recreates the container and its logs would be gone.
    FAILED_EVIDENCE="$(timeout 300 python3 "$SCRIPT_DIR/deploy-evidence.py" failed --container hypercal-bot --logs-root "$DEPLOY_PATH/logs" \
      --sha "$SHA" --receipt "$DEPLOY_PATH/releases/current.json" 2>&1 | sed -n 's/^EVIDENCE_DIR=//p')"
    [[ -z "$FAILED_EVIDENCE" ]] || printf 'FAILED_EVIDENCE %s\n' "$FAILED_EVIDENCE" >&2
  fi
  if [[ "$rc" != 0 && "$switched" == 1 ]] && old_image_may_run; then
    echo 'Verification failed; restoring image and host files, never restoring an older user database' >&2
    restore_host_files || rc=1
    restore_image || rc=1
  fi
  rm -rf "$REMOTE_SRC"
  exit "$rc"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Back up the live DB before replacing any deployed host files or container.
"$DEPLOY_PATH/scripts/backup-db.sh"
# Readiness before the swap. The verdict waives /ready only when it was KNOWINGLY worse (an answered
# 503, e.g. the AI chain is down for every image); a probe that failed or answered something that
# is not a bot response proves nothing, so it leaves readiness required.
BASELINE_CODE="$(curl -sS --max-time 20 -o "$REMOTE_SRC/baseline-ready.body" -w '%{http_code}' "$HEALTH_URL/ready" 2>/dev/null)" || BASELINE_CODE=000
BASELINE_BODY="$(head -c 200 "$REMOTE_SRC/baseline-ready.body" 2>/dev/null | tr -d '\r\n' || true)"
BASELINE_READY=""
if [[ "$BASELINE_CODE" == 200 ]] && ready_acceptable "$BASELINE_BODY"; then BASELINE_READY="$BASELINE_BODY"; fi
if [[ "$BASELINE_CODE" == 503 ]]; then BASELINE_READY="${BASELINE_BODY:-not ready (HTTP 503)}"; fi
CURRENT_REVISION="$(docker inspect hypercal-bot --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null | cut -c1-12)" || CURRENT_REVISION=""

switched=1
install -d -m 0755 "$DEPLOY_PATH/scripts"
install -m 0644 "$REMOTE_SRC/docker-compose.yml" "$DEPLOY_PATH/docker-compose.yml"
install -m 0644 "$REMOTE_SRC/Caddyfile" "$DEPLOY_PATH/Caddyfile"
for script in backup-db.sh healthcheck-alert.sh prepare-runtime-dirs.sh; do
  install -m 0755 "$REMOTE_SRC/scripts/$script" "$DEPLOY_PATH/scripts/$script"
done

"$DEPLOY_PATH/scripts/prepare-runtime-dirs.sh" "$DEPLOY_PATH"

echo "Rotating host logs before restart"
for file in healthcheck.log backup.log; do
  if [[ -s "$DEPLOY_PATH/logs/$file" ]]; then
    mv "$DEPLOY_PATH/logs/$file" "$DEPLOY_PATH/logs/${file%.log}_${STAMP}.log"
    gzip "$DEPLOY_PATH/logs/${file%.log}_${STAMP}.log"
  fi
done

# The outgoing container's complete log goes to the host before the recreate destroys it (owner
# requirement 7). Best effort: it never blocks the release.
timeout 300 python3 "$SCRIPT_DIR/deploy-evidence.py" release-logs --container hypercal-bot --logs-root "$DEPLOY_PATH/logs" \
  --label "${CURRENT_REVISION:-${CURRENT_IMAGE_ID:7:12}}" >&2 || true

# Pin the runtime selector, independent of environment or stale :latest aliases.
printf 'services:\n  bot:\n    image: "%s"\n' "$IMAGE:$SHA" > "$REMOTE_SRC/image.yml"
cd "$DEPLOY_PATH"
docker compose -f docker-compose.yml -f "$REMOTE_SRC/image.yml" up -d --no-deps --no-build --pull never --force-recreate bot
# Do not reload the shared server proxy: this release changes no proxy routing.

ACTUAL_IMAGE_ID="$(docker inspect hypercal-bot --format '{{.Image}}')"
if [[ "$ACTUAL_IMAGE_ID" != "$EXPECTED_IMAGE_ID" ]]; then
  echo "Container image mismatch: running=$ACTUAL_IMAGE_ID expected=$EXPECTED_IMAGE_ID" >&2
  exit 1
fi

if ! wait_for_bot ready; then
  if [[ "$HEALTH" != ok ]]; then
    echo "Health check failed after deploy: $VERDICT_REASON" >&2
  elif ! ready_acceptable "$READY"; then
    echo "Readiness path is not returning a bot response: ${READY:-<empty>} ($VERDICT_REASON)" >&2
  else
    echo "Release did not stay healthy: $VERDICT_REASON" >&2
  fi
  exit 1
fi

REVISION="$(docker image inspect "$IMAGE:$SHA" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
[[ "$REVISION" == "$SHA" ]] || exit 1
# Runtime verification is the commit point. Metadata or alias failures cannot undo it.
if [[ "$PUBLIC_DOMAIN_VALUE" =~ ^[A-Za-z0-9.-]+$ ]]; then
  PUBLIC_HEALTH="$(curl -sS --max-time 20 "https://$PUBLIC_DOMAIN_VALUE/health" 2>/dev/null || true)"
  printf 'PUBLIC_PROBE host=%s health=%s (informational: the release is verified on its own port)\n' "$PUBLIC_DOMAIN_VALUE" "${PUBLIC_HEALTH:-<none>}"
fi
switched=0
printf 'RUNTIME_VERIFIED sha=%s image=%s ready=%s\n' "$REVISION" "$ACTUAL_IMAGE_ID" "$READY"
# config_digest is the release identity on every store; image_id is what this daemon reports as the
# container's .Image, which scripts/post-ship-deploy.py compares with the live container.
python3 - "$DEPLOY_PATH/releases/current.json" "$REVISION" "$CONFIG_ID" "$ACTUAL_IMAGE_ID" "$ARCHIVE_SUM" "$READY" "$ROLLBACK_TAG" <<'RECEIPT'
import datetime,json,os,sys
path,sha,config,image,archive,ready,rollback=sys.argv[1:]
record={"revision":sha,"config_digest":config,"image_id":image,"archive_sha256":archive,"ready":ready,"rollback_image":rollback,"verified_at":datetime.datetime.now(datetime.timezone.utc).isoformat()}
with open(path+'.tmp','w') as f:json.dump(record,f,indent=2)
os.replace(path+'.tmp',path)
RECEIPT
docker tag "$IMAGE:$SHA" "$IMAGE:latest"
printf 'DEPLOYED sha=%s image=%s health=%s ready=%s\n' "$REVISION" "$ACTUAL_IMAGE_ID" "$HEALTH" "$READY"

# Every release keeps the previous image under a new ~2 GB rollback tag; 42 of them filled the
# shared host on 2026-09-28 (#481). Keep the five newest rollback tags and the current and previous
# releases, and remove every other tag of this repository. Docker removes an image with its last
# tag and refuses (without -f) one a container still uses. This runs after the commit point, so a
# failure is reported and never fails or undoes the verified release.
python3 - "$IMAGE" "$SHA" "$CURRENT_IMAGE_ID" 5 <<'RETENTION' || echo 'IMAGE_RETENTION failed; the verified release stays in place' >&2
import re,subprocess,sys
image,sha,previous,keep=sys.argv[1],sys.argv[2],sys.argv[3],int(sys.argv[4])
listing=subprocess.run(["docker","images","--no-trunc","--format","{{.Tag}}\t{{.ID}}",image],check=True,capture_output=True,text=True).stdout
tags=dict(line.split("\t") for line in listing.splitlines())
tags.pop("<none>",None)
# The stamp is %Y-%m-%d_%H-%M-%S, so name order is age order; other rollback-* names count as oldest.
rollbacks=sorted((t for t in tags if re.fullmatch(r"rollback-\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d",t)),reverse=True)
keep_tags={sha,"latest",*rollbacks[:keep]}
keep_ids={previous,*(tags[t] for t in keep_tags if t in tags)}
failed=False
for tag in sorted(t for t in tags if t not in keep_tags and tags[t] not in keep_ids):
    result=subprocess.run(["docker","image","rm",f"{image}:{tag}"],capture_output=True,text=True)
    if result.returncode:
        failed=True
        print(f"IMAGE_RETENTION kept={image}:{tag} error={result.stderr.strip()}",file=sys.stderr)
    else:
        print(f"IMAGE_RETENTION removed={image}:{tag}")
sys.exit(1 if failed else 0)
RETENTION

# Log retention (owner requirement 7): deploys and rollbacks never delete logs; only a violated size,
# file-count or free-space criterion does, oldest first, sparing the last deploy's and the last
# failure's directories (scripts/log-retention.py). After the commit point, so a problem here is
# reported and never fails or undoes the verified release.
# The installed copy is what root cron runs between deploys (disk-space watchdog, runbook).
install -m 0755 "$SCRIPT_DIR/log-retention.py" "$DEPLOY_PATH/scripts/log-retention.py" >&2 \
  || echo 'LOG_RETENTION install failed; cron keeps running the previous copy' >&2
python3 "$SCRIPT_DIR/log-retention.py" --root "$DEPLOY_PATH/logs" --env-file "$DEPLOY_PATH/.env" --alert >&2 \
  || echo 'LOG_RETENTION reported a violated criterion; the verified release stays in place' >&2
