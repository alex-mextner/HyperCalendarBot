#!/usr/bin/env bash
# Emergency production deploy when GitHub-hosted runners are unavailable.
# Deploys an exact Git commit via git archive; never copies the working tree.
set -euo pipefail

HOST="${HYPERCAL_DEPLOY_HOST:-root@104.248.84.190}"
DEPLOY_PATH="${HYPERCAL_DEPLOY_PATH:-/opt/hypercal}"
IMAGE="${HYPERCAL_IMAGE:-ghcr.io/alex-mextner/hypercalendarbot}"
REF="origin/main"
SKIP_TESTS=false
DOCKER_CONTEXT="${HYPERCAL_DOCKER_CONTEXT:-colima}"
DOCKER="${HYPERCAL_DOCKER_BIN:-docker}"
BUN="${HYPERCAL_BUN_BIN:-bun}"

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
[[ "$SHA" =~ ^[a-f0-9]{40}$ ]] || { echo 'Expected exact SHA' >&2; exit 2; }
git merge-base --is-ancestor "$SHA" origin/main
[[ "$(git rev-parse origin/main)" == "$SHA" ]] || { echo 'Ref is not current origin/main' >&2; exit 2; }
[[ "$DEPLOY_PATH" =~ ^/[a-zA-Z0-9_/-]+$ && "$DEPLOY_PATH" != / && "$DEPLOY_PATH" != *..* ]] || exit 2
[[ "$HOST" =~ ^[a-zA-Z0-9_@.-]+$ ]] || exit 2
[[ "$IMAGE" =~ ^[a-z0-9][a-z0-9./_-]*$ ]] || exit 2
REMOTE_SRC="/tmp/hypercal-source-${SHORT_SHA}-$$"
LOCAL_SRC="$(mktemp -d)"
trap 'rm -rf "$LOCAL_SRC"' EXIT
# A remote Docker context is not a local build. Require the operator's Unix-socket daemon.
endpoint="$("$DOCKER" context inspect "$DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}')"
[[ "$endpoint" == unix://* ]] || { echo 'Local Unix-socket Docker context required' >&2; exit 2; }
docker_local() { "$DOCKER" --context "$DOCKER_CONTEXT" "$@"; }
git archive "$SHA" | tar -xf - -C "$LOCAL_SRC"

if [[ "$SKIP_TESTS" == false ]]; then
  echo "== Local verification for $SHA =="
  # Verify the exact source, never a dirty current working tree.
  [[ "$("$BUN" --version)" == 1.3.11 ]] || { echo 'Use the pinned Bun 1.3.11' >&2; exit 2; }
  (cd "$LOCAL_SRC" && "$BUN" install --ignore-scripts && "$BUN" --no-env-file test ./test/ && "$BUN" run lint && "$BUN" node_modules/typescript/bin/tsc --noEmit)
fi

cleanup_remote() {
  ssh -o BatchMode=yes "$HOST" "rm -rf '$REMOTE_SRC'" >/dev/null 2>&1 || true
  rm -rf "$LOCAL_SRC"
}
trap cleanup_remote EXIT

echo "== Building Linux amd64 locally for $SHA =="
docker_local build --platform linux/amd64 --label "org.opencontainers.image.revision=$SHA" -t "$IMAGE:$SHA" "$LOCAL_SRC"
docker_local save "$IMAGE:$SHA" | gzip -1 > "$LOCAL_SRC/image.tar.gz"
python3 "$LOCAL_SRC/scripts/release-artifact.py" "$LOCAL_SRC/image.tar.gz" "$SHA" "$IMAGE:$SHA" > "$LOCAL_SRC/artifact.json"
ARCHIVE_SUM="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["archive_sha256"])' "$LOCAL_SRC/artifact.json")"
CONFIG_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["config_digest"])' "$LOCAL_SRC/artifact.json")"

ssh -o BatchMode=yes "$HOST" "mkdir -p '$REMOTE_SRC'"
echo "== Uploading exact git archive $SHA =="
git archive "$SHA" | ssh -o BatchMode=yes "$HOST" "tar -xf - -C '$REMOTE_SRC'"

scp -q -o BatchMode=yes "$LOCAL_SRC/image.tar.gz" "$HOST:$REMOTE_SRC/image.tar.gz"
echo "== Loading and deploying verified prebuilt $SHA on $HOST =="
ssh -o BatchMode=yes "$HOST" bash "$REMOTE_SRC/scripts/deploy-prebuilt-image.sh" "$DEPLOY_PATH" "$REMOTE_SRC" "$IMAGE" "$SHA" "$ARCHIVE_SUM" "$CONFIG_ID"

trap - EXIT
cleanup_remote
echo "Deploy complete: $SHA"
