#!/usr/bin/env bash
# Emergency production deploy when GitHub-hosted runners are unavailable.
# Deploys an exact Git commit via git archive; never copies the working tree.
set -euo pipefail

HOST="${HYPERCAL_DEPLOY_HOST:-root@104.248.84.190}"
DEPLOY_PATH="${HYPERCAL_DEPLOY_PATH:-/opt/hypercal}"
IMAGE="${HYPERCAL_IMAGE:-ghcr.io/alex-mextner/hypercalendarbot}"
REF="origin/main"
SKIP_TESTS=false
DOCKER_CONTEXT="${HYPERCAL_DOCKER_CONTEXT:-}"
DOCKER="${HYPERCAL_DOCKER_BIN:-docker}"
CONTAINER="${HYPERCAL_CONTAINER_BIN:-container}"
BUILD_BACKEND="${HYPERCAL_BUILD_BACKEND:-auto}"
BUN="${HYPERCAL_BUN_BIN:-bun}"

usage() {
  cat <<'EOF'
Usage: scripts/deploy-local-fallback.sh [--ref <git-ref>] [--skip-tests]

Defaults to origin/main and runs the local test/lint/typecheck gate first.
Use --skip-tests only when the exact commit already passed the same local gate.

Local linux/amd64 image builder (HYPERCAL_BUILD_BACKEND, default auto):
  container  Apple's native `container` CLI (macOS, no always-on Linux VM).
             auto picks it when `container` is installed and
             HYPERCAL_DOCKER_CONTEXT is unset.
  docker     a real Docker Engine on a local Unix socket: HYPERCAL_DOCKER_CONTEXT
             (default `default`) via HYPERCAL_DOCKER_BIN.
Colima is not a supported builder on the dev Mac (removed 2026-09-26); do not
reinstall it or any other Docker VM for this script.
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
# Local image builder. Colima was removed from the dev Mac on 2026-09-26 (its VM
# disk kept growing) and must not come back for this: on macOS the default is
# Apple's native `container` CLI. A real Docker Engine is still accepted, but only
# on a local Unix socket: a remote Docker context is not a local build.
NO_VM='on the dev Mac build with Apple `container` (`container system start`); do not install Colima or another Docker VM'
if [[ "$BUILD_BACKEND" == auto ]]; then
  if [[ -z "$DOCKER_CONTEXT" ]] && command -v "$CONTAINER" >/dev/null 2>&1; then
    BUILD_BACKEND=container
  else
    BUILD_BACKEND=docker
    [[ -n "$DOCKER_CONTEXT" ]] || NO_VM="Apple container CLI not found ($CONTAINER); $NO_VM"
  fi
fi
case "$BUILD_BACKEND" in
  container)
    command -v "$CONTAINER" >/dev/null 2>&1 || { echo "Apple container CLI not found: $CONTAINER" >&2; exit 2; }
    "$CONTAINER" system status >/dev/null 2>&1 || { echo 'Apple container services are stopped: run `container system start` (do not install Colima or another Docker VM)' >&2; exit 2; }
    ;;
  docker)
    DOCKER_CONTEXT="${DOCKER_CONTEXT:-default}"
    endpoint="$("$DOCKER" context inspect "$DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)"
    [[ "$endpoint" == unix://* ]] || { echo "Local Unix-socket Docker context required (context '$DOCKER_CONTEXT' via $DOCKER); $NO_VM" >&2; exit 2; }
    "$DOCKER" --context "$DOCKER_CONTEXT" version >/dev/null 2>&1 || { echo "No Docker Engine answers on $endpoint; $NO_VM" >&2; exit 2; }
    ;;
  *) echo 'HYPERCAL_BUILD_BACKEND must be auto, container or docker' >&2; exit 2 ;;
esac
docker_local() { "$DOCKER" --context "$DOCKER_CONTEXT" "$@"; }
git archive "$SHA" | tar -xf - -C "$LOCAL_SRC"

if [[ "$SKIP_TESTS" == false ]]; then
  echo "== Local verification for $SHA =="
  # Verify the exact source, never a dirty current working tree.
  [[ "$("$BUN" --version)" == 1.4.2 ]] || { echo 'Use the pinned Bun 1.4.2' >&2; exit 2; }
  (cd "$LOCAL_SRC" && "$BUN" install --frozen-lockfile --ignore-scripts && "$BUN" --no-env-file test ./test/ && "$BUN" run lint && "$BUN" node_modules/typescript/bin/tsc --noEmit)
fi

cleanup_remote() {
  ssh -o BatchMode=yes "$HOST" "rm -rf '$REMOTE_SRC'" >/dev/null 2>&1 || true
  rm -rf "$LOCAL_SRC"
}
trap cleanup_remote EXIT

echo "== Building Linux amd64 locally for $SHA ($BUILD_BACKEND) =="
if [[ "$BUILD_BACKEND" == container ]]; then
  "$CONTAINER" build --progress plain --platform linux/amd64 --label "org.opencontainers.image.revision=$SHA" -t "$IMAGE:$SHA" "$LOCAL_SRC"
  # `container image save` writes an OCI image layout; convert it (digest-checked,
  # config bytes unchanged) to the `docker save` format that release-artifact.py
  # and the server's `docker load` identity checks expect.
  "$CONTAINER" image save --platform linux/amd64 "$IMAGE:$SHA" -o "$LOCAL_SRC/image.oci.tar"
  python3 "$LOCAL_SRC/scripts/oci-to-docker-archive.py" "$LOCAL_SRC/image.oci.tar" "$LOCAL_SRC/image.tar" "$IMAGE:$SHA"
  rm -f "$LOCAL_SRC/image.oci.tar"
  gzip -1 "$LOCAL_SRC/image.tar"
  # The archive is the release artifact; don't keep one local image per release.
  "$CONTAINER" image delete "$IMAGE:$SHA" >/dev/null 2>&1 || echo "warning: could not delete local image $IMAGE:$SHA; remove it with \`container image delete\`" >&2
else
  docker_local build --platform linux/amd64 --label "org.opencontainers.image.revision=$SHA" -t "$IMAGE:$SHA" "$LOCAL_SRC"
  docker_local save "$IMAGE:$SHA" | gzip -1 > "$LOCAL_SRC/image.tar.gz"
fi
python3 "$LOCAL_SRC/scripts/release-artifact.py" "$LOCAL_SRC/image.tar.gz" "$SHA" "$IMAGE:$SHA" > "$LOCAL_SRC/artifact.json"
ARCHIVE_SUM="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["archive_sha256"])' "$LOCAL_SRC/artifact.json")"
CONFIG_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["config_digest"])' "$LOCAL_SRC/artifact.json")"

# A later merge must not be overwritten after a long local build.
git fetch origin main
[[ "$(git rev-parse origin/main)" == "$SHA" ]] || { echo 'Release superseded during local build' >&2; exit 2; }
ssh -o BatchMode=yes "$HOST" "mkdir -p '$REMOTE_SRC'"
echo "== Uploading exact git archive $SHA =="
git archive "$SHA" | ssh -o BatchMode=yes "$HOST" "tar -xf - -C '$REMOTE_SRC'"

scp -q -o BatchMode=yes "$LOCAL_SRC/image.tar.gz" "$HOST:$REMOTE_SRC/image.tar.gz"
git fetch origin main
[[ "$(git rev-parse origin/main)" == "$SHA" ]] || { echo 'Release superseded during upload' >&2; exit 2; }
echo "== Loading and deploying verified prebuilt $SHA on $HOST =="
ssh -o BatchMode=yes "$HOST" bash "$REMOTE_SRC/scripts/deploy-prebuilt-image.sh" "$DEPLOY_PATH" "$REMOTE_SRC" "$IMAGE" "$SHA" "$ARCHIVE_SUM" "$CONFIG_ID"

trap - EXIT
cleanup_remote
echo "Deploy complete: $SHA"
