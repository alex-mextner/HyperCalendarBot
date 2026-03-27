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

set -euo pipefail

PLIST_LABEL="ru.invntrm.hypercal-alert-watcher"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
SCRIPT_PATH="$(cd "$(dirname "$0")"; pwd -P)/$(basename "$0")"

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
  <key>StandardOutPath</key>
  <string>/tmp/hypercal-alert-watcher.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/hypercal-alert-watcher.log</string>
</dict>
</plist>
PLIST
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  launchctl load "$PLIST_PATH"
  echo "[watcher] installed and started — logs: /tmp/hypercal-alert-watcher.log"
  exit 0
fi

ENDPOINT="${ALERT_ENDPOINT:-https://hypercal.invntrm.ru/admin/alerts/next}"
INTERVAL="${ALERT_POLL_INTERVAL:-30}"
TERMINAL="${ALERT_TERMINAL:-terminal}"

echo "[watcher] started — polling ${ENDPOINT} every ${INTERVAL}s"

while true; do
  RESPONSE=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Bearer ${TOKEN}" \
    "${ENDPOINT}" 2>/dev/null)

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | head -n -1)

  if [[ "$HTTP_CODE" == "200" ]]; then
    TEXT=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['text'])" 2>/dev/null || echo "$BODY")
    SOURCE=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['source'])" 2>/dev/null || echo "unknown")
    echo "[watcher] alert from ${SOURCE}: ${TEXT:0:80}..."

    # Escape single quotes and backslashes for AppleScript string safety
    SAFE_TEXT="${TEXT//\\/\\\\}"
    SAFE_TEXT="${SAFE_TEXT//\"/\\\"}"
    SAFE_TEXT="${SAFE_TEXT//\'/\'\\\'\'}"
    CMD="claude --dangerously-skip-permissions --permission-mode bypassPermissions '${SAFE_TEXT}'"

    if [[ "$TERMINAL" == "iterm2" ]]; then
      osascript <<APPLESCRIPT
tell application "iTerm2"
  activate
  set newWindow to (create window with default profile)
  tell current session of newWindow
    write text "${CMD}"
  end tell
end tell
APPLESCRIPT
    else
      osascript <<APPLESCRIPT
tell application "Terminal"
  activate
  do script "${CMD}"
end tell
APPLESCRIPT
    fi

  elif [[ "$HTTP_CODE" != "204" ]]; then
    echo "[watcher] unexpected HTTP ${HTTP_CODE}: ${BODY:0:100}" >&2
  fi

  sleep "$INTERVAL"
done
