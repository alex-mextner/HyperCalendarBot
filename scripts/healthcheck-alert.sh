#!/bin/bash
# Polls the bot readiness endpoint every run (called by cron every 2 minutes).
# Sends Telegram alerts to the admin on failure and recovery.
# State files: /tmp/hypercal-down — present while bot is considered down;
# /tmp/hypercal-unverified-since — when the bot came back up but could not yet
# confirm the outage is over.

set -euo pipefail

# /ready, not /health: /health is pure process liveness, while this watchdog has
# to notice the failure users actually feel — a running bot whose whole AI
# provider chain is dead answers nobody, and /health says "ok" throughout.
HEALTH_URL="https://hypercal.invntrm.ru/ready"
ALERT_URL="https://hypercal.invntrm.ru/admin/alerts"
ENV_FILE="/opt/hypercal/.env"
STATE_FILE="/tmp/hypercal-down"
# When the unverified wait began. Separate from STATE_FILE because that one is
# created when the outage starts, and the wait has to be measured from when the
# bot came back up without proof — otherwise a long outage makes the wait expire
# on its very first unverified answer.
UNVERIFIED_FILE="/tmp/hypercal-unverified-since"
TIMEOUT=10
RETRY_COUNT=3
RETRY_DELAY=15
# How long to keep the "down" state while the bot answers 200 but cannot confirm
# the provider chain works. Past this the state is dropped WITHOUT announcing a
# recovery: there is still no proof to announce, but keeping it would suppress
# the alert for the next, unrelated outage.
UNVERIFIED_HOLD=1800

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

# The body matters as much as the status: a bot that restarted since the last
# check answers "ok (unverified)" — it is alive, but no provider has answered in
# this process, so it cannot confirm the outage is over.
BODY_FILE=$(mktemp)
trap 'rm -f "$BODY_FILE"' EXIT

probe_health() {
  curl -s -o "$BODY_FILE" -w "%{http_code}" --max-time "$TIMEOUT" "$HEALTH_URL" 2>/dev/null || echo "000"
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
  # Any real failure ends an unverified wait: there is something to see again.
  rm -f "$UNVERIFIED_FILE"
  if [[ ! -f "$STATE_FILE" ]]; then
    touch "$STATE_FILE"
    REASON=$(head -c 200 "$BODY_FILE" 2>/dev/null || true)
    # The body says which failure this is, and the right reaction differs: a
    # process that has not started comes back with a restart, while a dead
    # provider chain does not — restarting only throws away the evidence.
    ADVICE=""
    if [[ "$REASON" == "ai chain down" ]]; then
      ADVICE="
Every AI provider is failing. A restart will not fix this and clears the record — check provider quotas, keys and model ids first."
    fi
    MSG="HyperCalendarBot DOWN — readiness returned HTTP ${HTTP_CODE}${REASON:+ (${REASON})}"
    send_telegram "🚨 <b>HyperCalendarBot DOWN</b>
Readiness: <code>${HEALTH_URL}</code>
HTTP status: <code>${HTTP_CODE}</code>${REASON:+
Reason: <code>${REASON}</code>}${ADVICE}"
    push_alert "$MSG"
  fi
else
  if [[ -f "$STATE_FILE" ]]; then
    # Announce recovery only on proof. The likeliest reaction to a DOWN alert is
    # restarting the bot, and a restarted process starts with an empty outage
    # record — announcing "recovered" on that would be reporting a recovery
    # nobody verified, while every provider was still dead. Stay down and quiet
    # until a real user request gets a real answer.
    #
    # The cost is a recovery message delayed until the first request after a
    # plain crash-restart, where nothing was ever wrong with the providers. A
    # late true message beats a prompt false one.
    BODY=$(cat "$BODY_FILE")
    if [[ "$BODY" == "ok" ]]; then
      rm -f "$STATE_FILE" "$UNVERIFIED_FILE"
      send_telegram "✅ <b>HyperCalendarBot UP</b> — recovered"
    elif [[ "$BODY" == "ok (unverified)" ]]; then
      # The bot is up but has served nobody since it started, so it cannot say
      # whether the outage ended. Wait — but not forever: while this state file
      # exists the DOWN branch stays silent, so an indefinite wait would swallow
      # the alert for a *different* outage starting later. On a bot quiet enough
      # to sit unverified this long, that silence is the worse failure.
      [[ -f "$UNVERIFIED_FILE" ]] || date +%s > "$UNVERIFIED_FILE"
      WAITED=$(( $(date +%s) - $(cat "$UNVERIFIED_FILE") ))
      if (( WAITED > UNVERIFIED_HOLD )); then
        rm -f "$STATE_FILE" "$UNVERIFIED_FILE"
        echo "$(date -u +%FT%TZ) dropping down-state after ${WAITED}s unverified; no recovery announced" >&2
      fi
    else
      # Neither answer this script knows. Most likely the endpoint's contract
      # changed and this branch stopped recognising a real recovery — which would
      # keep the state file forever and suppress every future DOWN alert. Say so
      # in the cron log rather than sitting in a silence that looks identical to
      # a bot nobody has messaged yet.
      echo "$(date -u +%FT%TZ) unexpected /ready body, recovery not recognised: ${BODY:0:120}" >&2
    fi
  fi
fi
