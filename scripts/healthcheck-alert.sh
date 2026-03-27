#!/bin/bash
# Polls the bot health endpoint every run (called by cron every 2 minutes).
# Sends Telegram alerts to the admin on failure and recovery.
# State file: /tmp/hypercal-down — present while bot is considered down.

set -euo pipefail

HEALTH_URL="https://hypercal.invntrm.ru/health"
ALERT_URL="https://hypercal.invntrm.ru/admin/alerts"
ENV_FILE="/opt/hypercal/.env"
STATE_FILE="/tmp/hypercal-down"
TIMEOUT=10

# Read secrets from .env
BOT_TOKEN=$(grep -m1 "^BOT_TOKEN=" "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
ADMIN_ID=$(grep -m1 "^BOT_ADMIN_ID=" "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
ADMIN_ALERT_TOKEN=$(grep -m1 "^ADMIN_ALERT_TOKEN=" "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")

if [[ -z "$BOT_TOKEN" || -z "$ADMIN_ID" ]]; then
  echo "ERROR: BOT_TOKEN or BOT_ADMIN_ID not found in $ENV_FILE" >&2
  exit 1
fi

send_telegram() {
  local text="$1"
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    --max-time "$TIMEOUT" \
    -d "chat_id=${ADMIN_ID}" \
    -d "text=${text}" \
    -d "parse_mode=HTML" \
    -o /dev/null
}

# Post to alert queue so mac-alert-watcher triggers Claude investigation
push_alert() {
  local text="$1"
  if [[ -n "$ADMIN_ALERT_TOKEN" ]]; then
    curl -sf -X POST "$ALERT_URL" \
      --max-time "$TIMEOUT" \
      -H "Authorization: Bearer ${ADMIN_ALERT_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{\"text\": $(echo -n "$text" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'), \"source\": \"healthcheck\"}" \
      -o /dev/null || true
  fi
}

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" "$HEALTH_URL" 2>/dev/null || echo "000")

if [[ "$HTTP_CODE" != "200" ]]; then
  if [[ ! -f "$STATE_FILE" ]]; then
    touch "$STATE_FILE"
    MSG="HyperCalendarBot DOWN — health returned HTTP ${HTTP_CODE}"
    send_telegram "🚨 <b>HyperCalendarBot DOWN</b>
Health: <code>${HEALTH_URL}</code>
HTTP status: <code>${HTTP_CODE}</code>"
    push_alert "$MSG"
  fi
else
  if [[ -f "$STATE_FILE" ]]; then
    rm -f "$STATE_FILE"
    send_telegram "✅ <b>HyperCalendarBot UP</b> — recovered"
  fi
fi
