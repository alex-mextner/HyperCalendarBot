#!/usr/bin/env bash
# Remote prebuilt-image activation only: no compiler, package install, or registry credentials.
set -euo pipefail

DEPLOY_PATH="$1"
REMOTE_SRC="$2"
IMAGE="$3"
SHA="$4"
SHORT_SHA="${SHA:0:12}"
STAMP="$(date +%Y-%m-%d_%H-%M-%S)"
trap 'rm -rf "$REMOTE_SRC"' EXIT
ARCHIVE_SUM="$5"
CONFIG_ID="$6"
exec 9>"$DEPLOY_PATH/.release.lock"
flock -n 9 || { echo 'Another release owns this service' >&2; exit 1; }
[[ "$(sha256sum "$REMOTE_SRC/image.tar.gz" | cut -d ' ' -f1)" == "$ARCHIVE_SUM" ]] || { echo 'Archive checksum mismatch' >&2; exit 1; }
python3 "$REMOTE_SRC/scripts/release-artifact.py" "$REMOTE_SRC/image.tar.gz" "$SHA" "$IMAGE:$SHA" > "$REMOTE_SRC/artifact.json"
[[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["config_digest"])' "$REMOTE_SRC/artifact.json")" == "$CONFIG_ID" ]] || exit 1
docker load -i "$REMOTE_SRC/image.tar.gz"
[[ "$(docker image inspect "$IMAGE:$SHA" --format '{{.Id}}')" == "$CONFIG_ID" ]] || { echo 'Loaded config identity mismatch' >&2; exit 1; }
CURRENT_IMAGE_ID="$(docker inspect hypercal-bot --format '{{.Image}}' 2>/dev/null)" || { echo 'Existing HyperCalendar container is required; use a reviewed first-install procedure' >&2; exit 1; }
ROLLBACK_TAG="$IMAGE:rollback-$STAMP"
docker tag "$CURRENT_IMAGE_ID" "$ROLLBACK_TAG"
# Generic image rollback is allowed only when migration code is unchanged.
# A schema-changing release requires its own reviewed migration/rollback procedure.
old_schema="$(docker exec hypercal-bot sha256sum /app/src/database/migrations.ts | cut -d ' ' -f1)"
new_schema="$(docker run --rm --network none --entrypoint sha256sum "$IMAGE:$SHA" /app/src/database/migrations.ts | cut -d ' ' -f1)"
[[ -n "$old_schema" && "$old_schema" == "$new_schema" ]] || { echo 'Schema-changing release requires reviewed migration procedure' >&2; exit 1; }
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

restore_image() {
  printf 'services:\n  bot:\n    image: "%s"\n' "$CURRENT_IMAGE_ID" > "$REMOTE_SRC/rollback.yml"
  (cd "$DEPLOY_PATH" && docker compose -f docker-compose.yml -f "$REMOTE_SRC/rollback.yml" up -d --no-deps --no-build --pull never --force-recreate bot) || return 1
  restored="$(docker inspect hypercal-bot --format '{{.Image}}' 2>/dev/null)"
  printf 'ROLLBACK image=%s data=preserved\n' "$restored" >&2
  [[ "$restored" == "$CURRENT_IMAGE_ID" ]]
}

switched=0
rollback() {
  rc=$?
  trap - EXIT INT TERM
  set +e
  if [[ "$rc" != 0 && "$switched" == 1 ]]; then
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

EXPECTED_IMAGE_ID="$(docker image inspect "$IMAGE:$SHA" --format '{{.Id}}')"
ACTUAL_IMAGE_ID="$(docker inspect hypercal-bot --format '{{.Image}}')"
if [[ "$ACTUAL_IMAGE_ID" != "$EXPECTED_IMAGE_ID" ]]; then
  echo "Container image mismatch: running=$ACTUAL_IMAGE_ID expected=$EXPECTED_IMAGE_ID" >&2
  exit 1
fi

HEALTH=""
READY=""
for _ in $(seq 1 15); do
  HEALTH="$(curl -fsS --max-time 20 https://hypercal.invntrm.ru/health 2>/dev/null || true)"
  READY="$(curl -fsS --max-time 20 https://hypercal.invntrm.ru/ready 2>/dev/null || true)"
  case "$READY" in
    ok|"ok (unverified)")
      [[ "$HEALTH" == ok ]] && break
      ;;
  esac
  sleep 4
done

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
python3 - "$DEPLOY_PATH/releases/current.json" "$REVISION" "$ACTUAL_IMAGE_ID" "$ARCHIVE_SUM" "$READY" "$ROLLBACK_TAG" <<'RECEIPT'
import datetime,json,os,sys
path,sha,image,archive,ready,rollback=sys.argv[1:]
record={"revision":sha,"config_digest":image,"archive_sha256":archive,"ready":ready,"rollback_image":rollback,"verified_at":datetime.datetime.now(datetime.timezone.utc).isoformat()}
with open(path+'.tmp','w') as f:json.dump(record,f,indent=2)
os.replace(path+'.tmp',path)
RECEIPT
docker tag "$IMAGE:$SHA" "$IMAGE:latest"
printf 'DEPLOYED sha=%s image=%s health=%s ready=%s\n' "$REVISION" "$ACTUAL_IMAGE_ID" "$HEALTH" "$READY"
