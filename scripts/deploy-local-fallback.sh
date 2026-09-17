#!/usr/bin/env bash
# Emergency production deploy when GitHub-hosted runners are unavailable.
# Deploys an exact Git commit via git archive; never copies the working tree.
set -euo pipefail

HOST="${HYPERCAL_DEPLOY_HOST:-root@104.248.84.190}"
DEPLOY_PATH="${HYPERCAL_DEPLOY_PATH:-/opt/hypercal}"
IMAGE="${HYPERCAL_IMAGE:-ghcr.io/alex-mextner/hypercalendarbot}"
REF="origin/main"
SKIP_TESTS=false

usage() {
  cat <<'EOF'
Usage: scripts/deploy-local-fallback.sh [--ref <git-ref>] [--skip-tests]

Defaults to origin/main and runs the local test/lint/typecheck gate first.
Use --skip-tests only when the exact commit already passed the same local gate.
EOF
}

while (($#)); do
  case "$1" in
    --ref) REF="${2:?--ref requires a git ref}"; shift 2 ;;
    --skip-tests) SKIP_TESTS=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if [[ "$REF" == origin/* ]]; then
  git fetch origin "${REF#origin/}"
fi
SHA="$(git rev-parse "${REF}^{commit}")"
SHORT_SHA="${SHA:0:12}"
REMOTE_SRC="/tmp/hypercal-source-${SHORT_SHA}-$$"

if [[ "$SKIP_TESTS" == false ]]; then
  echo "== Local verification for $SHA =="
  bun test
  bun run lint
  bunx tsc --noEmit
fi

cleanup_remote() {
  ssh -o BatchMode=yes "$HOST" "rm -rf '$REMOTE_SRC'" >/dev/null 2>&1 || true
}
trap cleanup_remote EXIT

ssh -o BatchMode=yes "$HOST" "mkdir -p '$REMOTE_SRC'"
echo "== Uploading exact git archive $SHA =="
git archive "$SHA" | ssh -o BatchMode=yes "$HOST" "tar -xf - -C '$REMOTE_SRC'"

echo "== Building and deploying $SHA on $HOST =="
ssh -o BatchMode=yes "$HOST" bash -s -- "$DEPLOY_PATH" "$REMOTE_SRC" "$IMAGE" "$SHA" <<'REMOTE'
set -euo pipefail

DEPLOY_PATH="$1"
REMOTE_SRC="$2"
IMAGE="$3"
SHA="$4"
SHORT_SHA="${SHA:0:12}"
STAMP="$(date +%Y-%m-%d_%H-%M-%S)"
trap 'rm -rf "$REMOTE_SRC"' EXIT
if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "Refusing fallback build on non-x86_64 host: $(uname -m)" >&2
  exit 1
fi

CURRENT_IMAGE_ID="$(docker image inspect "$IMAGE:latest" --format '{{.Id}}' 2>/dev/null || true)"
if [[ -n "$CURRENT_IMAGE_ID" ]]; then
  ROLLBACK_TAG="$IMAGE:rollback-$STAMP"
  docker tag "$CURRENT_IMAGE_ID" "$ROLLBACK_TAG"
  echo "Rollback image: $ROLLBACK_TAG ($CURRENT_IMAGE_ID)"
fi

echo "Building $IMAGE:$SHA"
docker build \
  --label "org.opencontainers.image.revision=$SHA" \
  -t "$IMAGE:$SHA" \
  "$REMOTE_SRC"

# Back up the live DB before replacing any deployed host files or container.
"$DEPLOY_PATH/scripts/backup-db.sh"

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

# Move latest only after build, backup and host-file preparation have all succeeded.
docker tag "$IMAGE:$SHA" "$IMAGE:latest"

cd "$DEPLOY_PATH"
docker compose up -d --no-deps --force-recreate bot
caddy reload --config /etc/caddy/Caddyfile 2>/dev/null || true

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
  READY="$(curl -sS --max-time 20 https://hypercal.invntrm.ru/ready 2>/dev/null || true)"
  case "$READY" in
    ok|"ok (unverified)"|"ai chain down")
      [[ -n "$HEALTH" ]] && break
      ;;
  esac
  sleep 4
done

if [[ -z "$HEALTH" ]]; then
  echo "Health check failed after deploy" >&2
  exit 1
fi
case "$READY" in
  ok|"ok (unverified)"|"ai chain down") ;;
  *) echo "Readiness path is not returning a bot response: ${READY:-<empty>}" >&2; exit 1 ;;
esac

REVISION="$(docker image inspect "$IMAGE:$SHA" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
printf 'DEPLOYED sha=%s image=%s health=%s ready=%s\n' "$REVISION" "$ACTUAL_IMAGE_ID" "$HEALTH" "$READY"
REMOTE

trap - EXIT
cleanup_remote
echo "Deploy complete: $SHA"
