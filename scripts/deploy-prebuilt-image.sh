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
[[ "$(sha256sum "$REMOTE_SRC/image.tar.gz" | cut -d ' ' -f1)" == "$ARCHIVE_SUM" ]] || { echo 'Archive checksum mismatch' >&2; exit 1; }
python3 "$REMOTE_SRC/scripts/release-artifact.py" "$REMOTE_SRC/image.tar.gz" "$SHA" "$IMAGE:$SHA" > "$REMOTE_SRC/artifact.json"
[[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["config_digest"])' "$REMOTE_SRC/artifact.json")" == "$CONFIG_ID" ]] || exit 1
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
# Poll until /health is ok and, unless $1 is "health", /ready answers ok or "ok (unverified)".
wait_for_bot() {
  for _ in $(seq 1 15); do
    HEALTH="$(curl -fsS --max-time 20 https://hypercal.invntrm.ru/health 2>/dev/null || true)"
    READY="$(curl -fsS --max-time 20 https://hypercal.invntrm.ru/ready 2>/dev/null || true)"
    if [[ "$HEALTH" == ok ]]; then
      if [[ "$1" == health ]]; then return 0; fi
      case "$READY" in ok|"ok (unverified)") return 0 ;; esac
    fi
    sleep 4
  done
  return 1
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

wait_for_bot ready || true

if [[ "$HEALTH" != ok ]]; then
  echo "Health check failed after deploy" >&2
  exit 1
fi
case "$READY" in
  ok|"ok (unverified)") ;;
  *) echo "Readiness path is not returning a bot response: ${READY:-<empty>}" >&2; exit 1 ;;
esac

REVISION="$(docker image inspect "$IMAGE:$SHA" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
[[ "$REVISION" == "$SHA" ]] || exit 1
# Runtime verification is the commit point. Metadata or alias failures cannot undo it.
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
