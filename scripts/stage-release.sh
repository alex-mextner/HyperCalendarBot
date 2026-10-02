#!/bin/bash
# Install one staged release configuration transactionally, then invoke deploy-bot.sh.
set -euo pipefail
STAGE="${STAGE:?STAGE is required}"
DEPLOY_DIR="${DEPLOY_DIR:?DEPLOY_DIR is required}"
DEPLOY_SHA="${DEPLOY_SHA:?DEPLOY_SHA is required}"
IMAGE_REPO="${IMAGE_REPO:?IMAGE_REPO is required}"
DEPLOY_IMAGE_DIGEST="${DEPLOY_IMAGE_DIGEST:-}"
DEPLOY_IMAGE_PRELOADED="${DEPLOY_IMAGE_PRELOADED:-0}"
[[ "$STAGE" == "$DEPLOY_DIR"/releases/incoming-* ]] || { echo 'invalid stage directory' >&2; exit 2; }
BACKUP="$STAGE/config-before"
mkdir -p "$BACKUP" "$DEPLOY_DIR/scripts"
cp "$DEPLOY_DIR/docker-compose.yml" "$DEPLOY_DIR/Caddyfile" "$BACKUP/"
ASSETS=(deploy-bot.sh backup-db.sh healthcheck-alert.sh stage-release.sh)
for file in "${ASSETS[@]}"; do
  [[ -f "$DEPLOY_DIR/scripts/$file" ]] && cp "$DEPLOY_DIR/scripts/$file" "$BACKUP/$file" || true
done
restore_config() {
  cp "$BACKUP/docker-compose.yml" "$DEPLOY_DIR/docker-compose.yml"
  cp "$BACKUP/Caddyfile" "$DEPLOY_DIR/Caddyfile"
  for file in "${ASSETS[@]}"; do
    [[ -f "$BACKUP/$file" ]] && cp "$BACKUP/$file" "$DEPLOY_DIR/scripts/$file" || true
  done
  caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
}
trap restore_config ERR INT TERM HUP
install -m 0644 "$STAGE/docker-compose.yml" "$DEPLOY_DIR/docker-compose.yml"
install -m 0644 "$STAGE/Caddyfile" "$DEPLOY_DIR/Caddyfile"
for file in "${ASSETS[@]}"; do install -m 0755 "$STAGE/scripts/$file" "$DEPLOY_DIR/scripts/$file"; done
DEPLOY_DIR="$DEPLOY_DIR" IMAGE_REPO="$IMAGE_REPO" DEPLOY_SHA="$DEPLOY_SHA" \
  DEPLOY_IMAGE_DIGEST="$DEPLOY_IMAGE_DIGEST" DEPLOY_IMAGE_PRELOADED="$DEPLOY_IMAGE_PRELOADED" \
  "$DEPLOY_DIR/scripts/deploy-bot.sh"
trap - ERR INT TERM HUP
rm -rf "$STAGE"
