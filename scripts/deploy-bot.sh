#!/bin/bash
# Deploy one immutable HyperCalendar image already built by CI or a trusted local machine.
# This script NEVER builds images. It only pulls/uses an exact SHA-tagged image, migrates,
# switches the bot service, verifies it, and rolls back image + DB on failure.
set -euo pipefail

IMAGE_REPO="${IMAGE_REPO:-ghcr.io/alex-mextner/hypercalendarbot}"
DEPLOY_SHA="${DEPLOY_SHA:?DEPLOY_SHA is required}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/hypercal}"
READY_URL="${READY_URL:-https://hypercal.invntrm.ru/ready}"
HEALTH_URL="${HEALTH_URL:-https://hypercal.invntrm.ru/health}"
PROBE_COUNT="${DEPLOY_PROBE_COUNT:-20}"
PROBE_DELAY="${DEPLOY_PROBE_DELAY:-3}"
PROBE_TIMEOUT="${DEPLOY_PROBE_TIMEOUT:-15}"
SERVICE=bot
CONTAINER=hypercal-bot
DEPLOY_IMAGE_DIGEST="${DEPLOY_IMAGE_DIGEST:-}"
if [[ -n "$DEPLOY_IMAGE_DIGEST" ]]; then
  [[ "$DEPLOY_IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "DEPLOY_IMAGE_DIGEST must be sha256:<64 hex>" >&2; exit 2; }
  IMAGE="${IMAGE_REPO}@${DEPLOY_IMAGE_DIGEST}"
else
  IMAGE="${IMAGE_REPO}:${DEPLOY_SHA}"
fi
RELEASE_DIR="${DEPLOY_DIR}/releases"

[[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo 'DEPLOY_SHA must be a full 40-character lowercase commit SHA' >&2; exit 2; }
cd "$DEPLOY_DIR"
mkdir -p "$RELEASE_DIR"

# Image preflight happens before backup, stop, migration, or any compose mutation.
if [[ "${DEPLOY_IMAGE_PRELOADED:-0}" != 1 ]]; then docker pull "$IMAGE"; fi
expected_id="$(docker image inspect "$IMAGE" --format '{{.Id}}')"
revision="$(docker image inspect "$IMAGE" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
architecture="$(docker image inspect "$IMAGE" --format '{{.Architecture}}')"
[[ "$revision" == "$DEPLOY_SHA" ]] || { echo "image revision mismatch: expected=$DEPLOY_SHA actual=${revision:-<missing>}" >&2; exit 1; }
[[ "$architecture" == amd64 ]] || { echo "image architecture mismatch: expected=amd64 actual=$architecture" >&2; exit 1; }
# Cheap runtime smoke; no network, data volume, Telegram, or Redis.
docker run --rm --network none --entrypoint bun "$IMAGE" scripts/runtime-smoke.ts >/dev/null

old_id="$(docker inspect "$CONTAINER" --format '{{.Image}}' 2>/dev/null || true)"
if [[ -z "$old_id" && -f "${DEPLOY_DIR}/data/calendar.db" ]]; then
  echo 'refusing deploy: calendar.db exists but no running bot is available for a WAL-safe backup' >&2
  exit 1
fi
old_ref=""
backup_path=""
bot_stopped=0
db_touched=0
success=0
stamp="$(date -u +%Y%m%dT%H%M%SZ)"

restore_db() {
  [[ -n "$backup_path" && -f "$backup_path" ]] || return 1
  local tmp="${DEPLOY_DIR}/data/calendar.db.restore.$$"
  gzip -dc "$backup_path" > "$tmp"
  rm -f "${DEPLOY_DIR}/data/calendar.db-wal" "${DEPLOY_DIR}/data/calendar.db-shm"
  chown 999:999 "$tmp" 2>/dev/null || true
  chmod 600 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "${DEPLOY_DIR}/data/calendar.db"
}

wait_health() {
  local expected_image="$1" health="" ready=""
  for _ in $(seq 1 "$PROBE_COUNT"); do
    health="$(curl -fsS --max-time "$PROBE_TIMEOUT" "$HEALTH_URL" 2>/dev/null || true)"
    if [[ "$health" == ok ]]; then ready="$(curl -fsS --max-time "$PROBE_TIMEOUT" "$READY_URL" 2>/dev/null || true)"; fi
    if [[ "$health" == ok && "$ready" =~ ^ok ]]; then
      local current
      current="$(docker inspect "$CONTAINER" --format '{{.Image}}')"
      [[ "$current" == "$expected_image" ]] && { printf '%s\t%s\n' "$health" "$ready"; return 0; }
    fi
    sleep "$PROBE_DELAY"
  done
  return 1
}

rollback() {
  local rc="${1:-1}"
  [[ "$success" == 1 ]] && return 0
  trap - ERR INT TERM
  echo "Deploy failed; rollback phase bot_stopped=$bot_stopped db_touched=$db_touched" >&2
  if [[ "$bot_stopped" == 1 ]]; then
    docker compose stop -t 30 "$SERVICE" >/dev/null 2>&1 || true
    if [[ "$db_touched" == 1 ]]; then restore_db || echo 'WARNING: DB restore failed' >&2; fi
    if [[ -n "$old_ref" && -n "$old_id" ]]; then
      HYPERCAL_IMAGE="$old_ref" docker compose up -d --no-deps --force-recreate "$SERVICE" >/dev/null
      wait_health "$old_id" >/dev/null || echo 'WARNING: rollback image did not become healthy in time' >&2
    fi
  fi
  exit "$rc"
}
trap 'rc=$?; rollback "$rc"' ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM

if [[ -n "$old_id" ]]; then
  old_ref="${IMAGE_REPO}:rollback-${stamp}"
  docker tag "$old_id" "$old_ref"
  backup_output="$(scripts/backup-db.sh)"
  printf '%s\n' "$backup_output"
  backup_path="$(printf '%s\n' "$backup_output" | sed -n 's/^BACKUP_PATH=//p' | tail -1)"
  [[ -n "$backup_path" && -f "$backup_path" ]] || { echo 'backup path missing from backup-db.sh output' >&2; exit 1; }
fi

docker compose stop -t 30 "$SERVICE"
bot_stopped=1
# A migration process can fail after partially mutating SQLite, so rollback must
# restore the backup for every attempted migration, not only a successful one.
db_touched=1
docker run --rm --network none -v "${DEPLOY_DIR}/data:/app/data" --entrypoint bun "$IMAGE" scripts/db-migrate.ts

HYPERCAL_IMAGE="$IMAGE" docker compose up -d --no-deps --force-recreate "$SERVICE"
caddy reload --config /etc/caddy/Caddyfile 2>/dev/null || true
if ! IFS=$'\t' read -r health ready < <(wait_health "$expected_id"); then
  echo 'health/readiness verification failed' >&2
  rollback 1
fi

# DB integrity after the exact image is healthy.
if ! db_check="$(docker exec "$CONTAINER" bun scripts/db-integrity-check.ts 2>&1)"; then
  echo "database verification failed: $db_check" >&2
  rollback 1
fi
[[ "$db_check" == $'ok\t0' ]] || { echo "database verification failed: $db_check" >&2; rollback 1; }

restart_count="$(docker inspect "$CONTAINER" --format '{{.RestartCount}}')"
if [[ "$restart_count" != 0 ]]; then
  echo "container restarted during verification: restart_count=$restart_count" >&2
  rollback 1
fi
startup_log="${RELEASE_DIR}/${DEPLOY_SHA}.startup.log"
docker logs --since 10m --tail 250 "$CONTAINER" > "$startup_log" 2>&1 || true
if grep -Eiq 'Uncaught exception|Unhandled promise rejection|TELEGRAM_SESSION_MASTER_KEY does not match|Shutdown timed out|SQLITE_(CORRUPT|READONLY)|migration[^[:space:]]* (failed|error)' "$startup_log"; then
  echo "fatal startup signature detected; see $(basename "$startup_log")" >&2
  rollback 1
fi

# Compatibility alias changes only after immutable image, DB and startup checks pass.
docker tag "$IMAGE" "${IMAGE_REPO}:latest"
receipt="${RELEASE_DIR}/${DEPLOY_SHA}.json"
python3 - "$receipt" "$DEPLOY_SHA" "$expected_id" "$old_id" "$backup_path" "$health" "$ready" "$startup_log" "$restart_count" <<'PY'
import json,os,sys,datetime
path,sha,image,previous,backup,health,ready,startup,restarts=sys.argv[1:]
data={'sha':sha,'image_id':image,'previous_image_id':previous or None,'backup':os.path.basename(backup) if backup else None,'health':health,'ready':ready,'startup_log':os.path.basename(startup),'restart_count':int(restarts),'deployed_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
tmp=path+'.tmp';open(tmp,'w').write(json.dumps(data,indent=2)+'\n');os.chmod(tmp,0o600);os.replace(tmp,path)
PY

success=1
trap - ERR INT TERM
# Keep the three newest repo-scoped rollback tags; never global-prune shared-server images.
count=0
while IFS= read -r ref; do
  [[ -n "$ref" ]] || continue
  count=$((count+1)); [[ "$count" -le 3 ]] && continue
  docker image rm "$ref" >/dev/null 2>&1 || true
done < <(docker images "$IMAGE_REPO" --format '{{.Repository}}:{{.Tag}}' | grep ':rollback-' | sort -r || true)

echo "deployed_sha=$DEPLOY_SHA image_id=$expected_id health=$health ready=$ready rollback=${old_ref:-none} receipt=$receipt"
