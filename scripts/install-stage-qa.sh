#!/usr/bin/env bash
# Installs the root side of the per-PR stage QA (#840) on the odroid, by hand, as root, from a
# reviewed main checkout:   sudo scripts/install-stage-qa.sh [<checkout>]   (default: the cwd)
#
# Why by hand: root runs everything installed here on behalf of PR runs, so it must come from code
# a human reviewed on main, never from a PR artifact or the runner's workspace.
#
# Installs   LIB (/usr/local/lib/hypercal-stage): the helper files of the contract, copied into a
#            fresh dir and swapped in while holding the stage lock (no run is in flight);
#            /usr/local/sbin/hypercal-stage-qa: the root entry (root:root 0755).
# Keeps      the previous LIB as <LIB>.bak-<UTC stamp> and the previous entry as <entry>.bak-<stamp>,
#            and prints the one-line rollback command.
# Refuses    a non-root caller, a checkout that is not a git checkout, a layout where any listed file is
#            missing, and uncommitted changes to (or untracked) listed files.
set -euo pipefail
umask 077

# Fixed on purpose: no environment overrides.
readonly LIB_DIR=/usr/local/lib/hypercal-stage
readonly ENTRY_PATH=/usr/local/sbin/hypercal-stage-qa
readonly REQUIRED_EUID=0
readonly INSTALL_OWNER=root:root
readonly STAGE_LOCK_FILE=/run/lock/hypercal-stage.lock
readonly STAGE_LOCK_WAIT=60
readonly SAFE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH="$SAFE_PATH"

readonly -a LIB_SOURCES=(
  scripts/stage-fetch-artifact.py
  scripts/stage-qa-run.sh
  scripts/stage-smoke.py
  docker-compose.stage.yml
  scripts/release-artifact.py
  scripts/odroid-deploy-lock.sh
  scripts/deploy-health.py
  scripts/deploy-evidence.py
  scripts/prepare-runtime-dirs.sh
  scripts/log-retention.py
)
readonly ENTRY_SOURCE=scripts/odroid-stage-qa.sh

fail() {
  local code="${2:-2}"
  echo "install-stage-qa: $1" >&2
  exit "$code"
}

NEW_LIB=""
NEW_ENTRY=""
cleanup() {
  [[ -z "$NEW_LIB" ]] || rm -rf -- "$NEW_LIB"
  [[ -z "$NEW_ENTRY" ]] || rm -f -- "$NEW_ENTRY"
}
trap cleanup EXIT

((EUID == REQUIRED_EUID)) || fail 'must run as root (the files it installs are executed as root)'
(($# <= 1)) || fail 'usage: install-stage-qa.sh [<checkout>]'
SRC="$(cd "${1:-$PWD}" && pwd -P)" || fail 'checkout directory not found'

ALL_SOURCES=("${LIB_SOURCES[@]}" "$ENTRY_SOURCE")
for rel in "${ALL_SOURCES[@]}"; do
  [[ -f "$SRC/$rel" && ! -L "$SRC/$rel" ]] || fail "unknown checkout layout: $rel is missing in $SRC"
done

[[ -e "$SRC/.git" ]] || fail "$SRC is not a git checkout; install from a reviewed main checkout"
# safe.directory on the command line only: root must be able to read a checkout owned by another user.
git_in_src() { git -c safe.directory="$SRC" -C "$SRC" "$@"; }
DIRTY="$(git_in_src status --porcelain -- "${ALL_SOURCES[@]}")" || fail 'git status failed in the checkout'
[[ -z "$DIRTY" ]] || fail "uncommitted or untracked changes to installed files (install only reviewed, committed code):
$DIRTY"
# Only reviewed, merged code: HEAD must be origin/main or an ancestor of it. There is deliberately
# no override; fetch origin and check out main instead.
git_in_src rev-parse --verify --quiet refs/remotes/origin/main >/dev/null \
  || fail 'the checkout has no origin/main ref: install from a checkout of main (git fetch origin)'
git_in_src merge-base --is-ancestor HEAD refs/remotes/origin/main \
  || fail 'the checkout HEAD is not on origin/main: install only merged, reviewed code'
HEAD_SHA="$(git_in_src rev-parse --short=12 HEAD)" || fail 'cannot read the checkout revision'
BRANCH="$(git_in_src branch --show-current || true)"

# Hold the stage lock while swapping: a run in flight keeps the stage lock for its whole life, so
# the install waits for it instead of swapping the scripts under it.
mkdir -p -- "$(dirname "$STAGE_LOCK_FILE")"
(
  umask 0
  : >>"$STAGE_LOCK_FILE"
)
exec {LOCK_FD}<"$STAGE_LOCK_FILE"
flock -w "$STAGE_LOCK_WAIT" "$LOCK_FD" \
  || fail "a stage QA run holds $STAGE_LOCK_FILE; nothing was changed, retry when it ends" 75

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_LIB="$LIB_DIR.bak-$STAMP"
BACKUP_ENTRY="$ENTRY_PATH.bak-$STAMP"
[[ ! -e "$BACKUP_LIB" && ! -e "$BACKUP_ENTRY" ]] || fail "a backup for $STAMP already exists; retry in a second"

mkdir -p -- "$(dirname "$LIB_DIR")" "$(dirname "$ENTRY_PATH")"
NEW_LIB="$(mktemp -d "$LIB_DIR.new.XXXXXX")"
chmod 0755 "$NEW_LIB"
for rel in "${LIB_SOURCES[@]}"; do
  mode=0644
  [[ "$rel" != *.sh && "$rel" != *.py ]] || mode=0755
  install -m "$mode" "$SRC/$rel" "$NEW_LIB/$(basename "$rel")"
done
chown -R "$INSTALL_OWNER" "$NEW_LIB"
NEW_ENTRY="$ENTRY_PATH.new.$$"
install -m 0755 "$SRC/$ENTRY_SOURCE" "$NEW_ENTRY"
chown "$INSTALL_OWNER" "$NEW_ENTRY"

ROLLBACK=()
if [[ -e "$LIB_DIR" ]]; then
  mv -T -- "$LIB_DIR" "$BACKUP_LIB"
  ROLLBACK+=("rm -rf -- $(printf '%q' "$LIB_DIR")" "mv -T -- $(printf '%q %q' "$BACKUP_LIB" "$LIB_DIR")")
else
  ROLLBACK+=("rm -rf -- $(printf '%q' "$LIB_DIR")")
fi
mv -T -- "$NEW_LIB" "$LIB_DIR"
NEW_LIB=""

if [[ -e "$ENTRY_PATH" ]]; then
  cp -p -- "$ENTRY_PATH" "$BACKUP_ENTRY"
  ROLLBACK+=("mv -f -- $(printf '%q %q' "$BACKUP_ENTRY" "$ENTRY_PATH")")
else
  ROLLBACK+=("rm -f -- $(printf '%q' "$ENTRY_PATH")")
fi
mv -f -- "$NEW_ENTRY" "$ENTRY_PATH"
NEW_ENTRY=""

printf 'installed stage QA from %s (%s) into %s and %s\n' "$HEAD_SHA" "${BRANCH:-detached}" "$LIB_DIR" "$ENTRY_PATH"
ROLLBACK_COMMAND=""
for part in "${ROLLBACK[@]}"; do ROLLBACK_COMMAND+="${ROLLBACK_COMMAND:+ && }$part"; done
printf 'rollback: %s\n' "$ROLLBACK_COMMAND"
