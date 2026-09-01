#!/bin/bash
# Polls the bot readiness endpoint every run (called by cron every 2 minutes).
# Sends Telegram alerts to the admin on failure and recovery.
# State file: /tmp/hypercal-down — present while bot is considered down.

set -euo pipefail

# /ready, not /health: /health is pure process liveness, while this watchdog has
# to notice the failure users actually feel — a running bot whose whole AI
# provider chain is dead answers nobody, and /health says "ok" throughout.
HEALTH_URL="https://hypercal.invntrm.ru/ready"
ALERT_URL="https://hypercal.invntrm.ru/admin/alerts"
ENV_FILE="/opt/hypercal/.env"
STATE_FILE="/tmp/hypercal-down"
TIMEOUT=10
RETRY_COUNT=3
RETRY_DELAY=15

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

probe_health() {
  curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" "$HEALTH_URL" 2>/dev/null || echo "000"
}

# Retry to avoid false positives during deploys (container swap ~10-15s).
# Only alert if all attempts fail — a transient single 503 is not an outage.
HTTP_CODE=$(probe_health)
attempt=1
while [[ "$HTTP_CODE" != "200" && $attempt -lt $RETRY_COUNT ]]; do
  sleep "$RETRY_DELAY"
  attempt=$((attempt + 1))
  HTTP_CODE=$(probe_health)
done

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
