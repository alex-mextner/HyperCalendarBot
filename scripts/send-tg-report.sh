#!/usr/bin/env bash
# Send a MarkdownV2 report to the bot admin via Telegram Bot API.
#
# Usage:
#   scripts/send-tg-report.sh "MarkdownV2 text"
#   echo "text" | scripts/send-tg-report.sh
#
# Env vars (read from .env if not set in environment):
#   BOT_TOKEN        — Telegram bot token
#   BOT_ADMIN_ID     — Telegram user ID of the admin

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")"; pwd -P)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.."; pwd -P)"

# Load .env if tokens not already in environment
if [[ -z "${BOT_TOKEN:-}" || -z "${BOT_ADMIN_ID:-}" ]]; then
  ENV_FILE="$PROJECT_DIR/.env"
  if [[ -f "$ENV_FILE" ]]; then
    BOT_TOKEN=$(grep -E '^BOT_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' || true)
    BOT_ADMIN_ID=$(grep -E '^BOT_ADMIN_ID=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' || true)
  fi
fi

: "${BOT_TOKEN:?BOT_TOKEN is required (env var or .env)}"
: "${BOT_ADMIN_ID:?BOT_ADMIN_ID is required (env var or .env)}"

# Read message from argument or stdin
if [[ $# -gt 0 ]]; then
  MESSAGE="$1"
else
  MESSAGE=$(cat)
fi

if [[ -z "$MESSAGE" ]]; then
  echo "[send-tg-report] error: empty message" >&2
  exit 1
fi

curl -sf -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg chat_id "$BOT_ADMIN_ID" \
    --arg text "$MESSAGE" \
    '{chat_id: $chat_id, text: $text, parse_mode: "MarkdownV2", disable_web_page_preview: true}')"

echo "[send-tg-report] sent"
