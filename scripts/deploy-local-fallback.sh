#!/bin/bash
# Post-merge fallback. It is intentionally unusable directly: gh ship creates a
# one-run guard after all local review/CI/acceptance gates and passes the merge SHA.
set -euo pipefail
SHA="${1:?exact merged SHA required}"
REMOTE="${HYPERCAL_DEPLOY_HOST:-root@104.248.84.190}"
DEPLOY_DIR="${HYPERCAL_DEPLOY_DIR:-/opt/hypercal}"
DOCKER="${HYPERCAL_DOCKER_BIN:-docker}"
CONTEXT="${HYPERCAL_DOCKER_CONTEXT:-colima}"
IMAGE_REPO="${HYPERCAL_IMAGE_REPO:-ghcr.io/alex-mextner/hypercalendarbot}"
IMAGE="${IMAGE_REPO}:${SHA}"
GUARD_FILE="${HYPERCAL_GH_SHIP_GUARD_FILE:-}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo 'full commit SHA required' >&2; exit 2; }
[[ -n "$GUARD_FILE" && -f "$GUARD_FILE" && ! -L "$GUARD_FILE" ]] || { echo 'refusing: local fallback must be invoked by gh ship' >&2; exit 2; }
[[ "${HYPERCAL_SHIP_MERGE_SHA:-}" == "$SHA" && "$(cat "$GUARD_FILE")" == "$SHA" ]] || { echo 'refusing: gh ship guard does not match merge SHA' >&2; exit 2; }
[[ "$REMOTE" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._:-]+$ ]] || { echo 'invalid deploy host' >&2; exit 2; }
[[ "$DEPLOY_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo 'invalid deploy directory' >&2; exit 2; }
[[ "$IMAGE_REPO" =~ ^[a-z0-9._/-]+$ ]] || { echo 'invalid image repository' >&2; exit 2; }

git fetch origin main
git merge-base --is-ancestor "$SHA" origin/main
[[ "$(git rev-parse 'origin/main^{commit}')" == "$SHA" ]] || { echo "refusing: $SHA is not current origin/main" >&2; exit 2; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/src" "$tmp/stage/scripts"
git archive "$SHA" | tar -x -C "$tmp/src"
D=("$DOCKER"); [[ -n "$CONTEXT" ]] && D+=(--context "$CONTEXT")
"${D[@]}" build --platform linux/amd64 --label "org.opencontainers.image.revision=$SHA" -t "$IMAGE" "$tmp/src"
revision="$("${D[@]}" image inspect "$IMAGE" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
arch="$("${D[@]}" image inspect "$IMAGE" --format '{{.Architecture}}')"
[[ "$revision" == "$SHA" && "$arch" == amd64 ]] || { echo 'local image identity mismatch' >&2; exit 1; }
"${D[@]}" run --rm --network none --entrypoint bun "$IMAGE" scripts/runtime-smoke.ts >/dev/null
"${D[@]}" save "$IMAGE" | gzip -1 > "$tmp/stage/image.tar.gz"
cp "$tmp/src/docker-compose.yml" "$tmp/src/Caddyfile" "$tmp/stage/"
cp "$tmp/src/scripts/deploy-bot.sh" "$tmp/src/scripts/backup-db.sh" "$tmp/src/scripts/healthcheck-alert.sh" "$tmp/src/scripts/stage-release.sh" "$tmp/stage/scripts/"
local_sum="$(shasum -a 256 "$tmp/stage/image.tar.gz" | awk '{print $1}')"

remote_stage="${DEPLOY_DIR}/releases/incoming-${SHA}"
ssh -T "$REMOTE" "mkdir -p '$remote_stage/scripts' && chmod 700 '$remote_stage'"
scp -q "$tmp/stage/image.tar.gz" "$tmp/stage/docker-compose.yml" "$tmp/stage/Caddyfile" "$REMOTE:$remote_stage/"
scp -q "$tmp/stage/scripts/"* "$REMOTE:$remote_stage/scripts/"
remote_sum="$(ssh -T "$REMOTE" "sha256sum '$remote_stage/image.tar.gz'" | cut -d' ' -f1)"
[[ "$local_sum" == "$remote_sum" ]] || { echo 'image transfer checksum mismatch' >&2; exit 1; }

ssh -T "$REMOTE" bash -s -- "$remote_stage" "$DEPLOY_DIR" "$IMAGE" "$SHA" "$IMAGE_REPO" <<'REMOTE'
set -euo pipefail
stage="$1"; deploy="$2"; image="$3"; sha="$4"; repo="$5"
docker load -i "$stage/image.tar.gz" >/dev/null
rev="$(docker image inspect "$image" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
[[ "$rev" == "$sha" ]]
chmod +x "$stage/scripts/stage-release.sh"
STAGE="$stage" DEPLOY_DIR="$deploy" IMAGE_REPO="$repo" DEPLOY_SHA="$sha" DEPLOY_IMAGE_PRELOADED=1 \
  "$stage/scripts/stage-release.sh"
REMOTE
health="$(curl -fsS --max-time 10 https://hypercal.invntrm.ru/health)"
ready="$(curl -fsS --max-time 15 https://hypercal.invntrm.ru/ready)"
[[ "$health" == ok && "$ready" =~ ^ok ]]
echo "local_fallback_deployed=$SHA checksum=$local_sum health=$health ready=$ready"
