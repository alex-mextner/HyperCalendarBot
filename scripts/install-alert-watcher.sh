#!/usr/bin/env bash
# Install (or remove) the hcb-alert-watcher systemd USER service on the owner's Ubuntu PC.
#
# The service (scripts/hcb-alert-watcher.ts) probes https://hypercal.mextner.com/ready (HCB_BASE_URL overrides), drains
# /admin/alerts/next and starts one detached omp investigation per incident. It replaces the Mac
# LaunchAgent (scripts/mac-alert-watcher.sh, removed): the Mac is gone, and nothing consumed the
# queue after 2026-09-28.
#
# Usage:
#   scripts/install-alert-watcher.sh                              install or update, enable, start
#   scripts/install-alert-watcher.sh --fetch-token-from HOST      first install: also copy the
#                                                                 production ADMIN_ALERT_TOKEN from
#                                                                 HOST:/opt/hypercal/.env into the keychain
#   scripts/install-alert-watcher.sh --dry-run                    print the unit, change nothing
#   scripts/install-alert-watcher.sh --uninstall                  stop and remove the unit
#
# Safe to run again: an unchanged unit is left alone and a running service is not restarted.
# The token lives only in the OS keychain (ref below); the unit gets it through `keychain exec`, so
# it is never written to a file, an argument list or this script's output.
#
# Env overrides (tests, other checkouts): HCB_REPO_DIR, HCB_OMP_LAUNCHER, XDG_CONFIG_HOME.

set -euo pipefail

UNIT="hcb-alert-watcher.service"
# keychain-cli lets a caller own only its own namespace, so the service is its own caller.
CALLER="hcb-alert-watcher"
SECRET_REF="$CALLER/admin-alert-token"
REMOTE_ENV_FILE="/opt/hypercal/.env"

die() {
  echo "install-alert-watcher: $*" >&2
  exit 1
}

action="install"
dry_run=0
fetch_host=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) action="uninstall" ;;
    --dry-run) dry_run=1 ;;
    --fetch-token-from)
      [[ $# -ge 2 ]] || die "--fetch-token-from needs a host (for example root@odroidn2)"
      fetch_host="$2"
      shift
      ;;
    -h | --help)
      sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit_path="$unit_dir/$UNIT"

if [[ "$action" == "uninstall" ]]; then
  if [[ ! -f "$unit_path" ]]; then
    echo "$UNIT is not installed"
    exit 0
  fi
  systemctl --user disable --now "$UNIT" || true
  rm -f "$unit_path"
  systemctl --user daemon-reload
  echo "removed $UNIT (state in ~/.local/state/hcb-alert-watcher and the keychain entry $SECRET_REF are kept)"
  exit 0
fi

# The unit must point at the canonical checkout, not at the worktree this script may run from:
# worktrees are deleted after their pull request merges.
if [[ -n "${HCB_REPO_DIR:-}" ]]; then
  repo="$HCB_REPO_DIR"
else
  script_dir="$(cd "$(dirname "$0")" && pwd -P)"
  common="$(git -C "$script_dir" rev-parse --path-format=absolute --git-common-dir)" \
    || die "cannot find the repository from $script_dir; set HCB_REPO_DIR"
  repo="$(dirname "$common")"
fi
watcher="$repo/scripts/hcb-alert-watcher.ts"
[[ -f "$watcher" ]] || die "$watcher not found: merge the watcher into the checkout at $repo first (or set HCB_REPO_DIR)"

launcher="${HCB_OMP_LAUNCHER:-$HOME/.agents/skills/rig-detached-omp/rig-detached-omp}"
[[ -x "$launcher" ]] || die "the rig-detached-omp launcher is missing at $launcher (it ships with the rig-detached-omp skill: run rig apply)"
bun_bin="$(command -v bun)" || die "bun is not on PATH"
keychain_bin="$(command -v keychain)" || die "keychain is not on PATH"
# The unit runs with a fixed PATH, and so does every omp session it starts. A tool that only the installing
# shell can find would make `tg report`, `ctmux ensure` or `gh` fail at 3 a.m., so check against that PATH.
unit_search_path="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
for tool in omp gh ssh tmux ctmux systemd-run; do
  PATH="$unit_search_path" command -v "$tool" >/dev/null 2>&1 \
    || echo "warning: $tool not found on the unit's PATH ($unit_search_path): sessions needing it will fail" >&2
done
# The unit's PATH is fixed, so notices must not depend on finding tg there: pin the absolute path.
tg_line=""
if tg_bin="$(command -v tg 2>/dev/null)"; then
  tg_line="Environment=HCB_TG_BIN=$tg_bin"
else
  echo "warning: tg not found: the watcher will investigate but cannot tell you when it is blind or fails to launch" >&2
fi

if ! "$keychain_bin" exists --caller "$CALLER" "$SECRET_REF"; then
  if [[ -z "$fetch_host" ]]; then
    die "the alert token is not in the keychain. Store it with: keychain set --caller $CALLER $SECRET_REF (hidden prompt), or copy production's with: $0 --fetch-token-from root@odroidn2"
  fi
  if ((dry_run)); then
    echo "dry run: would copy ADMIN_ALERT_TOKEN from $fetch_host:$REMOTE_ENV_FILE into the keychain as $SECRET_REF"
  else
    # The value only ever sits in this shell variable and the pipe into keychain's stdin.
    # `|| true` runs on the remote side, so ssh's own exit status means only "could not connect or run".
    line="$(ssh -o BatchMode=yes "$fetch_host" "grep -m1 '^ADMIN_ALERT_TOKEN=' $REMOTE_ENV_FILE || true")" \
      || die "ssh to $fetch_host failed (see the message above); nothing was stored"
    value="${line#ADMIN_ALERT_TOKEN=}"
    value="${value//\"/}"
    value="${value//\'/}"
    value="${value%$'\r'}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    [[ -n "$value" ]] || die "no ADMIN_ALERT_TOKEN found in $fetch_host:$REMOTE_ENV_FILE"
    [[ ! "$value" =~ [[:space:]] ]] || die "the ADMIN_ALERT_TOKEN line in $fetch_host:$REMOTE_ENV_FILE contains whitespace (an inline comment?): store it by hand with keychain set --caller $CALLER $SECRET_REF"
    printf '%s' "$value" | "$keychain_bin" set --caller "$CALLER" --label "HyperCalendarBot ADMIN_ALERT_TOKEN (alert watcher)" "$SECRET_REF"
    unset line value
    echo "stored $SECRET_REF in the keychain"
  fi
fi

# Optional override of the probed public host (the script's own default is the production host).
base_url_line=""
if [[ -n "${HCB_BASE_URL:-}" ]]; then
  base_url_line="Environment=HCB_BASE_URL=$HCB_BASE_URL"
fi

# No sandboxing directives on purpose: the omp sessions the watcher starts inherit the unit's
# restrictions, and an investigation needs ssh, docker over ssh, gh and the normal tools.
unit_body="$(
  cat <<EOF
[Unit]
Description=HyperCalendarBot alert watcher: probes /ready, drains /admin/alerts/next, starts an omp investigation
Documentation=file://$repo/docs/reference/deploy-runbook.md
StartLimitIntervalSec=0

[Service]
Type=simple
Environment=PATH=%h/.local/bin:%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=HCB_REPO_DIR=$repo
Environment=HCB_OMP_LAUNCHER=$launcher${tg_line:+
$tg_line}${base_url_line:+
$base_url_line}
# --no-redact: keychain's default masking buffers the child's output until it exits, which for a
# service that never exits means an empty journal. The watcher never prints the token (tested).
ExecStart=$keychain_bin exec --no-redact --caller $CALLER --env ADMIN_ALERT_TOKEN=$SECRET_REF -- $bun_bin $watcher
Restart=always
RestartSec=30
# A stop or restart is a SIGTERM to a process with no handler: that is a clean stop, not a failure.
SuccessExitStatus=143
# 78 = no token: restarting cannot fix a missing secret, and the loop would hide it.
RestartPreventExitStatus=78
Nice=10

[Install]
WantedBy=default.target
EOF
)"

if ((dry_run)); then
  echo "dry run: would write $unit_path"
  echo "$unit_body"
  exit 0
fi

mkdir -p "$unit_dir"
existed=0
changed=1
if [[ -f "$unit_path" ]]; then
  existed=1
  if [[ "$(cat "$unit_path")" == "$unit_body" ]]; then
    changed=0
  fi
fi
if ((changed)); then
  printf '%s\n' "$unit_body" >"$unit_path"
  chmod 644 "$unit_path"
  systemctl --user daemon-reload
fi
systemctl --user enable --now "$UNIT"
if ((changed && existed)); then
  systemctl --user restart "$UNIT"
  echo "$UNIT updated and restarted"
elif ((changed)); then
  echo "$UNIT installed and started"
else
  echo "$UNIT unchanged"
fi

# A user service stops at logout unless the user lingers; the watcher has to outlive the session.
if ! loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q '^Linger=yes$'; then
  echo "warning: linger is off, so the watcher stops when you log out. Run: loginctl enable-linger $(id -un)" >&2
fi
echo "logs: journalctl --user -u $UNIT -f"
