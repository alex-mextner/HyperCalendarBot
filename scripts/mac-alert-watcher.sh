#!/usr/bin/env bash
# Mac alert watcher — polls /admin/alerts/next and launches Claude in a new Terminal window.
#
# One-time install (registers as macOS LaunchAgent — auto-starts on login):
#   ADMIN_ALERT_TOKEN=<token> ./scripts/mac-alert-watcher.sh --install
#
# Uninstall:
#   ./scripts/mac-alert-watcher.sh --uninstall
#
# Manual run:
#   ADMIN_ALERT_TOKEN=<token> ./scripts/mac-alert-watcher.sh
#
# Env vars:
#   ADMIN_ALERT_TOKEN   required — matches ADMIN_ALERT_TOKEN on the server
#   ALERT_ENDPOINT      default: https://hypercal.invntrm.ru/admin/alerts/next
#   ALERT_POLL_INTERVAL default: 30 (seconds)
#   ALERT_TERMINAL      "terminal" (default) or "iterm2"

# -u: error on unset vars  -o pipefail: pipelines fail on first error
# (intentionally no -e: curl failures in the poll loop must not exit the process)
set -uo pipefail

LOG_FILE="/tmp/hypercal-alert-watcher.log"
exec > >(tee -a "$LOG_FILE") 2>&1

PLIST_LABEL="ru.invntrm.hypercal-alert-watcher"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
SCRIPT_PATH="$(cd "$(dirname "$0")"; pwd -P)/$(basename "$0")"
PROJECT_DIR="$(cd "$(dirname "$0")/.."; pwd -P)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  echo "[watcher] uninstalled"
  exit 0
fi

TOKEN="${ADMIN_ALERT_TOKEN:?ADMIN_ALERT_TOKEN is required}"

if [[ "${1:-}" == "--install" ]]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${SCRIPT_PATH}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ADMIN_ALERT_TOKEN</key>
    <string>${TOKEN}</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>/tmp/hypercal-alert-watcher.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/hypercal-alert-watcher.log</string>
</dict>
</plist>
PLIST
  # Restrict to owner-only — plist contains ADMIN_ALERT_TOKEN
  chmod 600 "$PLIST_PATH"
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  launchctl load "$PLIST_PATH"
  echo "[watcher] installed and started — logs: /tmp/hypercal-alert-watcher.log"
  exit 0
fi

ENDPOINT="${ALERT_ENDPOINT:-https://hypercal.invntrm.ru/admin/alerts/next}"
INTERVAL="${ALERT_POLL_INTERVAL:-30}"
TERMINAL="${ALERT_TERMINAL:-terminal}"

# --- Session lock: prevents spawning multiple Claude sessions concurrently ---
LOCK_FILE="/tmp/hypercal-claude-session.lock"
MAX_SESSION_SECONDS="${MAX_SESSION_SECONDS:-900}"  # 15 min — stale lock threshold
COOLDOWN_SECONDS="${COOLDOWN_SECONDS:-300}"         # 5 min — wait after session ends before starting a new one
COOLDOWN_FILE="/tmp/hypercal-claude-session.done"

is_session_active() {
  if [[ ! -f "$LOCK_FILE" ]]; then
    return 1  # no lock — not active
  fi
  local lock_age
  lock_age=$(( $(date +%s) - $(stat -f %m "$LOCK_FILE") ))
  if (( lock_age > MAX_SESSION_SECONDS )); then
    echo "[watcher] stale lock (${lock_age}s old) — removing"
    rm -f "$LOCK_FILE"
    return 1  # stale lock — not active
  fi
  echo "[watcher] session active (${lock_age}/${MAX_SESSION_SECONDS}s) — skipping poll"
  return 0  # lock exists and is fresh — session active
}

is_in_cooldown() {
  if [[ ! -f "$COOLDOWN_FILE" ]]; then
    return 1
  fi
  local cooldown_age
  cooldown_age=$(( $(date +%s) - $(stat -f %m "$COOLDOWN_FILE") ))
  if (( cooldown_age > COOLDOWN_SECONDS )); then
    rm -f "$COOLDOWN_FILE"
    return 1  # cooldown expired
  fi
  echo "[watcher] in cooldown (${cooldown_age}/${COOLDOWN_SECONDS}s) — skipping"
  return 0
}

echo "[watcher] started — polling ${ENDPOINT} every ${INTERVAL}s"

open_in_terminal() {
  local text="$1"
  local tmpscript
  tmpscript=$(mktemp /tmp/hypercal-XXXXXX)

  # Build a structured prompt: invoke the debugging skill, provide context,
  # and instruct Claude to send a Telegram report when done.
  local prompt
  prompt=$(printf '%s' "\
Use the /systematic-debugging skill to investigate this alert.

=== ALERT ===
%s
=============

Project directory: %q

After your investigation:
1. Identify the root cause and fix it if possible (run tests, commit, push).
2. Send a Telegram report using:
   bash scripts/send-tg-report.sh \"\$REPORT\"
   where REPORT is MarkdownV2-formatted text. Use this structure:

*CI Alert Report*

*Status:* fixed \\| not fixed \\| no action needed
*Root cause:* one sentence

*What happened:*
\`\`\`
brief description
\`\`\`

*Actions taken:*
• action 1
• action 2

*Next steps* \\(if any\\):
• step

Escape all MarkdownV2 special chars in dynamic values: \\_ \\* \\[ \\] \\( \\) \\~ \\\` \\> \\# \\+ \\- \\= \\| \\{ \\} \\. \\!
" "$text" "$PROJECT_DIR")

  CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude 2>/dev/null || echo "${HOME}/.local/bin/claude")}"
  # Create the lock BEFORE launching — prevents races during Terminal startup
  date +%s > "$LOCK_FILE"
  echo "[watcher] lock acquired: $LOCK_FILE"

  # printf %q produces shell-safe escaping for the prompt argument
  # No exec — shell must survive to clean up the lockfile after Claude exits.
  printf '#!/bin/sh\ncd %q\n%q --dangerously-skip-permissions --permission-mode bypassPermissions %q\nrm -f %q\ndate +%%s > %q\necho "[claude-session] done — lock released, cooldown started"\n' \
    "$PROJECT_DIR" "$CLAUDE_BIN" "$prompt" "$LOCK_FILE" "$COOLDOWN_FILE" > "$tmpscript"
  chmod +x "$tmpscript"

  # Open the script file directly — Terminal/iTerm2 execute it in a new window.
  # No osascript or Accessibility permission required.
  case "$TERMINAL" in
    iterm2)
      open -a iTerm "$tmpscript"
      ;;
    *)
      open -a Terminal "$tmpscript"
      ;;
  esac
  # tmpscript is left for Terminal to read; /tmp is cleared on reboot
}

while true; do
  # Skip polling entirely if a Claude session is already running or in cooldown.
  # This prevents consuming alerts from the queue that would be wasted.
  if is_session_active; then
    sleep "$INTERVAL"
    continue
  fi
  if is_in_cooldown; then
    sleep "$INTERVAL"
    continue
  fi

  RESPONSE=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Bearer ${TOKEN}" \
    "${ENDPOINT}" 2>/dev/null) || true

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')

  if [[ "$HTTP_CODE" == "200" ]]; then
    TEXT=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['text'])" 2>/dev/null || echo "$BODY")
    SOURCE=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['source'])" 2>/dev/null || echo "unknown")
    echo "[watcher] alert from ${SOURCE}: ${TEXT:0:80}..."
    open_in_terminal "$TEXT"

  elif [[ "$HTTP_CODE" != "204" ]]; then
    echo "[watcher] unexpected HTTP ${HTTP_CODE}: ${BODY:0:100}" >&2
  fi

  sleep "$INTERVAL"
done
