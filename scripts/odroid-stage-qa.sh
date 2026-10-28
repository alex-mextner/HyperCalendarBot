#!/usr/bin/env bash
# Root entry of the per-PR stage QA (#840), installed by hand as root:root 0755 at
# /usr/local/sbin/hypercal-stage-qa (scripts/install-stage-qa.sh). The dedicated self-hosted
# runner user may run only this file through sudoers.
#
# Trust model: PR code never runs here. Root trusts nothing the runner hands it except a commit
# SHA and a short-lived GitHub token, and the token only authenticates API calls made by the
# installed LIB/stage-fetch-artifact.py, which verifies the SHA is the head of an open PR of this
# repository and downloads only the data of the build job's artifact (the image and the case list).
# Every script root executes comes from LIB, installed from a reviewed main checkout, never from
# the artifact.
#
# Usage: printf '%s\n' "$GITHUB_TOKEN" | sudo -n /usr/local/sbin/hypercal-stage-qa <sha40>
#        or, as the forced command of the PC driver's ssh key (SHA in SSH_ORIGINAL_COMMAND, no args):
#        printf '%s\n' "$GITHUB_TOKEN" | ssh <odroid> <sha40>
# After the stage is up and guarded the run prints one STAGE_READY {json} line and keeps the stage
# until the client writes DONE (or closes stdin).
# The token is read from stdin only; it lives in a shell variable that is never exported, is
# handed to the fetcher on a pipe and to the run script on a pipe fd that it closes after one read,
# so it is never in argv, the environment or an output.
#
# Order (memory: a stage instance must never overlap a prod deploy): stage lock (own file, many PR
# runs queue here) -> verify + download -> exec LIB/stage-qa-run.sh, which takes the host deploy
# lock and runs the stage. The stage lock fd stays open across the exec, so it is held until the
# run ends. Exit codes and the last stdout line (STAGE_QA_RESULT ...) follow the stage QA contract:
# 0 passed, 1 failed, 2 refused, 3 not provisioned, 75 lock wait timed out, 76 superseded.
set -euo pipefail
umask 077

# Fixed on purpose: no environment overrides (sudo resets the environment anyway).
readonly API=https://api.github.com
readonly REPO=alex-mextner/HyperCalendarBot
readonly DEPLOY_PATH=/opt/hypercal
readonly LIB=/usr/local/lib/hypercal-stage
readonly STAGE_LOCK_FILE=/run/lock/hypercal-stage.lock
readonly STAGE_LOCK_MAX_WAIT=3000
readonly STAGE_LOCK_SLICE=30
readonly SAFE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH="$SAFE_PATH"
# GitHub closes the job's output pipes ~10 s after a cancel while this script still tears down;
# a write to a closed pipe must fail that one write, not kill the script mid-cleanup.
trap '' PIPE

# Never exported: children must not inherit the token.
declare +x TOKEN=""
SHA=""
WORK=""
CHILD_PID=""

result_status() {
  case "$1" in
    0) echo passed ;;
    2) echo refused ;;
    3) echo not-provisioned ;;
    75) echo lock-timeout ;;
    76) echo superseded ;;
    *) echo failed ;;
  esac
}

# The result line is printed last, after the work dir is gone, whatever ended the run.
finish() {
  local rc=$?
  trap - EXIT
  [[ -z "$WORK" ]] || rm -rf -- "$WORK"
  printf 'STAGE_QA_RESULT status=%s sha=%s cases=0 failed=0\n' "$(result_status "$rc")" "${SHA:--}"
  exit "$rc"
}

# A cancelled job must not leave a verification child running; the trap only runs between
# commands, so every long child is started in the background and waited for.
on_signal() {
  [[ -z "$CHILD_PID" ]] || kill "$CHILD_PID" 2>/dev/null || true
  exit "$1"
}
trap finish EXIT
trap 'on_signal 143' TERM
trap 'on_signal 130' INT
trap 'on_signal 129' HUP

fail() {
  echo "hypercal-stage-qa: $*" >&2 || true
  exit 2
}

# Called as an ssh forced command (the PC driver, scripts/stage-qa-pc.py) it has no arguments and
# the client's command line, which sshd leaves in SSH_ORIGINAL_COMMAND, must be exactly the SHA.
# With one argument (the sudo path) the environment is ignored.
# shellcheck disable=SC2016 # $GITHUB_TOKEN is literal text in the usage line
case "$#" in
  0) CANDIDATE="${SSH_ORIGINAL_COMMAND-}" ;;
  1) CANDIDATE="$1" ;;
  *) fail 'usage: printf "%s\n" "$GITHUB_TOKEN" | hypercal-stage-qa [<sha40>]' ;;
esac
[[ "$CANDIDATE" =~ ^[0-9a-f]{40}$ ]] || fail 'revision must be a full 40-character lowercase commit SHA'
SHA="$CANDIDATE"
IFS= read -r TOKEN || true
[[ -n "$TOKEN" ]] || fail 'the GitHub token must be the first line of stdin'

for helper in stage-fetch-artifact.py stage-qa-run.sh odroid-deploy-lock.sh; do
  if [[ ! -f "$LIB/$helper" ]]; then
    echo "STAGE_QA_NOT_PROVISIONED: $LIB/$helper is not installed (scripts/install-stage-qa.sh)" >&2
    exit 3
  fi
done

# shellcheck source=odroid-deploy-lock.sh
source "$LIB/odroid-deploy-lock.sh"
ODROID_DEPLOY_LOCK_FILE="$STAGE_LOCK_FILE"
ODROID_DEPLOY_LOCK_MAX_WAIT="$STAGE_LOCK_MAX_WAIT"
ODROID_DEPLOY_LOCK_SLICE="$STAGE_LOCK_SLICE"
odroid_deploy_lock_acquire hcb-stage-qa || exit $?

# The stage lock proves no other run is alive, so any work dir left here belongs to a run that died
# uncleanly (SIGKILL, power loss). Remove it: it holds a multi-hundred-MB image archive.
find "$DEPLOY_PATH" -mindepth 1 -maxdepth 1 -type d -name '.stage-incoming-*' -exec rm -rf -- {} +

WORK="$DEPLOY_PATH/.stage-incoming-$SHA-$(date +%s)-$$"
mkdir -m 0700 "$WORK"

printf '%s\n' "$TOKEN" | python3 "$LIB/stage-fetch-artifact.py" fetch \
  --api "$API" --repo "$REPO" --sha "$SHA" --out "$WORK" >&2 &
CHILD_PID=$!
fetch_rc=0
wait "$CHILD_PID" || fetch_rc=$?
CHILD_PID=""
case "$fetch_rc" in
  0) ;;
  76) exit 76 ;;
  *) exit 2 ;;
esac

# The run script re-checks that the SHA is still the PR head after the host lock wait, so it gets
# the token on fd 3 (a pipe holding one line), not in argv or the environment.
exec 3< <(printf '%s\n' "$TOKEN")
TOKEN=""
trap - EXIT TERM INT HUP
exec bash "$LIB/stage-qa-run.sh" "$SHA" "$WORK"
