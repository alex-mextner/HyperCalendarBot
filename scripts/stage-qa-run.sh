#!/usr/bin/env bash
# Orchestration of one stage QA run after the artifact was verified (#840). Lives in LIB
# (/usr/local/lib/hypercal-stage), installed by hand from a reviewed main checkout, and is exec'd by
# the root entry hypercal-stage-qa, which already holds the stage lock (its fd is inherited) and has
# put the verified artifact data into <work dir>. Nothing in <work dir> is ever executed.
#
# Usage: stage-qa-run.sh <sha40> <work dir>   (GitHub token: one line on fd 3, read once)
#
# Flow: provisioned-files check -> host deploy lock -> "still the PR head" re-check -> disk check +
# docker load -> bot.env from an allow-list of the prod .env -> fresh stage DB -> compose up ->
# health -> stage-smoke.py guard -> print STAGE_READY {json} -> wait for the client's DONE line (or
# EOF) while the cases run elsewhere (the PC driver, scripts/stage-qa-pc.py, through qa-cli) ->
# (always) evidence, compose down, image removal, work dir removal.
# stdin after the token line is the client's channel: DONE or EOF ends the wait.
# stdout carries only the STAGE_READY line and the last line STAGE_QA_RESULT ...; all progress goes
# to stderr.
# Exit: 0 passed (DONE/EOF after READY), 1 failed (health/timeout), 2 refused (guard), 3 not
# provisioned, 75 host lock wait timed out, 76 superseded. The verdict on the cases is the PC's.
# shellcheck disable=SC2329 # the functions below are reached only through traps and step(), which shellcheck cannot see
set -euo pipefail
umask 077

# Fixed on purpose: no environment overrides (sudo resets the environment anyway).
readonly API=https://api.github.com
readonly REPO=alex-mextner/HyperCalendarBot
readonly DEPLOY_PATH=/opt/hypercal
readonly HOST_LOCK_FILE=/run/lock/odroid-deploy.lock
readonly HOST_LOCK_MAX_WAIT=2400
readonly HOST_LOCK_SLICE=30
readonly RUN_TIMEOUT=2400
readonly SAFE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH="$SAFE_PATH"
# GitHub closes the job's output pipes ~10 s after a cancel while teardown still runs; a write to a
# closed pipe must fail that one write, not kill the script before evidence and compose down.
trap '' PIPE

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly LIB
readonly STAGE_DIR="$DEPLOY_PATH/stage"
readonly IMAGE_REPO=ghcr.io/alex-mextner/hypercalendarbot-stage
readonly COMPOSE_PROJECT=hypercalstage
readonly CONTAINER=hypercal-bot-stage
readonly HEALTH_URL=http://127.0.0.1:3002
# Health budgets as in deploy-prebuilt-image.sh.
readonly HEALTH_BASE_BUDGET=240 HEALTH_HARD_CAP=900 HEALTH_POLL=4 HEALTH_STABLE=15 HEALTH_STALL=120
# AI-provider keys and log/timezone settings only. No Telegram, Google, e-mail, MTProto, inline or
# PUBLIC_DOMAIN key of production may reach the stage instance.
readonly ALLOWED_ENV='^(ZAI_|HF_|CLAUDE_|OPENROUTER_|GROQ_|AI_|INTENT_LEARNER_|LOG_LEVEL=|TZ=)'

# stdout is reserved for the result line; everything else goes to stderr.
exec 4>&1 1>&2

# Never exported: children must not inherit the token.
declare +x TOKEN=""
SHA="${1:-}"
WORK="${2:-}"
WORK_OWNED=0
LOADED=0
STACK_TOUCHED=0
STEP_PID=""
WATCHDOG_PID=""

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

compose() {
  docker compose -p "$COMPOSE_PROJECT" --project-directory "$DEPLOY_PATH" --env-file "$STAGE_DIR/stage.env" \
    -f "$LIB/docker-compose.stage.yml" -f "$WORK/image.yml" "$@"
}

# Evidence first: compose down destroys the container and its logs. Best effort, never blocks teardown.
save_evidence() {
  local rc="$1"
  timeout 300 python3 "$LIB/deploy-evidence.py" release-logs --container "$CONTAINER" \
    --logs-root "$STAGE_DIR/evidence" --label "stage-${SHA:0:12}" || echo 'evidence: release-logs failed' >&2
  if ((rc != 0)); then
    timeout 300 python3 "$LIB/deploy-evidence.py" failed --container "$CONTAINER" \
      --logs-root "$STAGE_DIR/evidence" --sha "$SHA" || echo 'evidence: failed bundle failed' >&2
  fi
}

# Runs on pass, fail, SIGTERM and timeout. The stage instance exists only while the locks are held,
# so it is always removed here; logs and evidence are never deleted (log-retention.py owns that).
finish() {
  local rc=$?
  trap '' TERM INT HUP USR1
  trap - EXIT
  set +e
  [[ -z "$WATCHDOG_PID" ]] || kill "$WATCHDOG_PID" 2>/dev/null
  if ((STACK_TOUCHED)); then
    save_evidence "$rc"
    compose down --timeout 10 || echo 'teardown: compose down failed; the stage may still be up' >&2
  fi
  if ((LOADED)); then timeout 120 docker rmi "$IMAGE_REPO:$SHA" || true; fi
  if ((WORK_OWNED)); then rm -rf -- "$WORK"; fi
  printf 'STAGE_QA_RESULT status=%s sha=%s cases=0 failed=0\n' "$(result_status "$rc")" "${SHA:--}" >&4
  exit "$rc"
}

# A trap only runs between commands, so every long child runs in the background and is waited for;
# a signal then interrupts the wait and the child (and its children) is killed here.
on_signal() {
  if [[ -n "$STEP_PID" ]]; then
    pkill -TERM -P "$STEP_PID" 2>/dev/null || true
    kill "$STEP_PID" 2>/dev/null || true
  fi
  exit "$1"
}
trap finish EXIT
trap 'on_signal 143' TERM
trap 'on_signal 130' INT
trap 'on_signal 129' HUP
trap 'echo "stage QA run timed out after ${RUN_TIMEOUT}s" >&2; on_signal 1' USR1

step() {
  local rc=0
  "$@" &
  STEP_PID=$!
  wait "$STEP_PID" || rc=$?
  STEP_PID=""
  return "$rc"
}

die() {
  local rc="$1"
  shift
  echo "stage-qa-run: $*" >&2 || true
  exit "$rc"
}
not_provisioned() {
  echo "STAGE_QA_NOT_PROVISIONED: $*" >&2 || true
  exit 3
}

# Validate ownership of the work dir BEFORE it can be removed by the exit trap.
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die 2 'revision must be a full 40-character lowercase commit SHA'
[[ -n "$WORK" && -d "$WORK" && ! -L "$WORK" && "$(dirname -- "$WORK")" == "$DEPLOY_PATH" &&
"$(basename -- "$WORK")" =~ ^\.stage-incoming-$SHA-[0-9]+-[0-9]+$ ]] \
  || die 2 'work dir is outside the owned .stage-incoming-<sha>-<n>-<n> namespace'
WORK_OWNED=1
{ IFS= read -r -u 3 TOKEN; } 2>/dev/null || true
exec 3<&-
[[ -n "$TOKEN" ]] || die 2 'the GitHub token must arrive on fd 3'

has_value() { grep -Eq "^$2=." "$1"; }

# --- provisioned? Everything root cannot create itself (the stage bot's identity). ---
[[ -f "$STAGE_DIR/stage.env" ]] || not_provisioned "$STAGE_DIR/stage.env is missing"
for key in BOT_TOKEN BOT_USERNAME STAGE_REDIS_PASSWORD; do
  has_value "$STAGE_DIR/stage.env" "$key" || not_provisioned "stage.env has no $key"
done
[[ -f "$LIB/stage-smoke.py" ]] || not_provisioned "$LIB/stage-smoke.py is missing"
[[ -f "$LIB/docker-compose.stage.yml" ]] || not_provisioned "$LIB/docker-compose.stage.yml is missing"
for helper in odroid-deploy-lock.sh deploy-health.py deploy-evidence.py prepare-runtime-dirs.sh stage-fetch-artifact.py; do
  [[ -f "$LIB/$helper" ]] || not_provisioned "$LIB/$helper is missing"
done
[[ -s "$WORK/stage-smoke-cases.json" ]] || not_provisioned 'the artifact carries no stage-smoke cases'
[[ -s "$WORK/image.tar.gz" && -s "$WORK/artifact.json" ]] || die 2 'the verified artifact is incomplete'

install -d -m 0700 "$STAGE_DIR/evidence"

# --- host deploy lock: the stage instance must never overlap a prod (or ExpenseSyncBot) deploy. ---
# shellcheck source=odroid-deploy-lock.sh
source "$LIB/odroid-deploy-lock.sh"
ODROID_DEPLOY_LOCK_FILE="$HOST_LOCK_FILE"
ODROID_DEPLOY_LOCK_MAX_WAIT="$HOST_LOCK_MAX_WAIT"
ODROID_DEPLOY_LOCK_SLICE="$HOST_LOCK_SLICE"
odroid_deploy_lock_acquire hcb-stage || exit $?

# The run budget counts from here: the host-lock wait (up to 40 min behind a prod deploy) must not
# eat the time the stage itself needs. The watchdog exits by itself when this process is gone.
RUN_STARTED=$SECONDS
(
  deadline=$((RUN_STARTED + RUN_TIMEOUT))
  while kill -0 "$$" 2>/dev/null; do
    if ((SECONDS >= deadline)); then
      kill -USR1 "$$" 2>/dev/null
      exit 0
    fi
    sleep 1
  done
) &
WATCHDOG_PID=$!

# A run killed uncleanly (SIGKILL, power loss) left its containers and image behind; the locks prove
# nothing of the stage is legitimately alive, so remove them before taking memory and disk again.
docker rm -f "$CONTAINER" hypercal-stage-redis >/dev/null 2>&1 || true
# Only this stage repository's images: whatever `docker image ls` returns, a production image is never removed here.
while IFS= read -r stale_image; do
  [[ "$stale_image" == "$IMAGE_REPO":* ]] && docker rmi "$stale_image" >/dev/null 2>&1 || true
done < <(docker image ls "$IMAGE_REPO" --format '{{.Repository}}:{{.Tag}}' 2>/dev/null || true)

# The wait can take many minutes: the PR may have been force-pushed, merged or closed meanwhile.
current_head() {
  printf '%s\n' "$TOKEN" | python3 "$LIB/stage-fetch-artifact.py" current --api "$API" --repo "$REPO" --sha "$SHA"
}
current_rc=0
step current_head || current_rc=$?
TOKEN=""
case "$current_rc" in
  0) ;;
  76) exit 76 ;;
  *) die 2 'could not confirm the SHA is still the head of an open PR' ;;
esac

# --- disk check and image load (same reasoning as deploy-prebuilt-image.sh, #481, #784) ---
IMAGE_BYTES="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["image_bytes"])' "$WORK/artifact.json")"
[[ "$IMAGE_BYTES" =~ ^[0-9]+$ ]] || die 2 'artifact.json has no image_bytes'
DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}')"
FREE_KIB="$(df -Pk "$DOCKER_ROOT" | awk 'NR == 2 {print $4}')"
[[ "$FREE_KIB" =~ ^[0-9]+$ ]] || die 2 "cannot read free space on $DOCKER_ROOT"
((FREE_KIB * 1024 >= 2 * IMAGE_BYTES)) \
  || die 2 "not enough disk to load the stage image: $((FREE_KIB * 1024)) bytes free on $DOCKER_ROOT, need $((2 * IMAGE_BYTES))"
DRIVER_STATUS="$(docker info --format '{{json .DriverStatus}}')"
EXPECTED_IMAGE_ID="$(
  python3 - "$DRIVER_STATUS" "$WORK/artifact.json" <<'STORE'
import json,sys
status,artifact=sys.argv[1:]
containerd=["driver-type","io.containerd.snapshotter.v1"] in (json.loads(status) or [])
print(json.load(open(artifact))["manifest_digest" if containerd else "config_digest"])
STORE
)"
[[ "$EXPECTED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || die 2 'stage image identity is not a sha256 digest'

load_image() { gzip -dc "$WORK/image.tar.gz" | docker load; }
LOADED=1
step load_image || die 1 'docker load failed'
LOADED_ID="$(docker image inspect "$IMAGE_REPO:$SHA" --format '{{.Id}}')"
[[ "$LOADED_ID" == "$EXPECTED_IMAGE_ID" ]] || die 2 'loaded stage image identity does not match the verified artifact'

# --- bot.env: allow-list of prod .env + the stage bot's own identity, nothing else ---
build_bot_env() {
  local target="$STAGE_DIR/bot.env" tmp="$STAGE_DIR/bot.env.new"
  {
    if [[ -f "$DEPLOY_PATH/.env" ]]; then tr -d '\r' <"$DEPLOY_PATH/.env" | grep -E "$ALLOWED_ENV" || true; fi
    for key in BOT_TOKEN BOT_USERNAME; do grep -E "^$key=" "$STAGE_DIR/stage.env" | tail -n 1; done
  } >"$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$target"
}
build_bot_env

# Fresh database every run: a PR must not see (or depend on) rows an earlier PR left behind.
install -d -m 0755 "$STAGE_DIR/data" "$STAGE_DIR/logs"
find "$STAGE_DIR/data" -maxdepth 1 -type f \
  \( -name '*.db' -o -name '*.db-*' -o -name '*.sqlite' -o -name '*.sqlite-*' -o -name '*.sqlite3' -o -name '*.sqlite3-*' \) -delete
bash "$LIB/prepare-runtime-dirs.sh" "$STAGE_DIR"

printf 'services:\n  bot-stage:\n    image: "%s"\n' "$IMAGE_REPO:$SHA" >"$WORK/image.yml"
STACK_TOUCHED=1
step compose up -d --no-build --pull never --force-recreate || die 1 'compose up failed'

step python3 "$LIB/deploy-health.py" wait --container "$CONTAINER" --url "$HEALTH_URL" --mode health \
  --base-budget "$HEALTH_BASE_BUDGET" --hard-cap "$HEALTH_HARD_CAP" --poll "$HEALTH_POLL" \
  --stable "$HEALTH_STABLE" --stall "$HEALTH_STALL" || die 1 'the stage instance did not become healthy'

# --- guard: the cases and the stage bot's identity, validated on the odroid ---
# The cases run on the PC (qa-cli drives Telegram Web there); the odroid only proves the target is
# the stage bot and not production, with the same guard the PC repeats on its side.
extra=()
[[ ! -f "$WORK/stage-smoke-cases.replay.json" ]] || extra=(--extra-cases "$WORK/stage-smoke-cases.replay.json")
run_guard() {
  python3 "$LIB/stage-smoke.py" guard --cases "$WORK/stage-smoke-cases.json" "${extra[@]}" \
    --min-cases 5 \
    --require-case start --require-case ping --require-case today-read-only-calendar \
    --require-case simple-intent-phrase --require-case validation-search-without-query \
    --stage-env "$STAGE_DIR/stage.env" --prod-env "$DEPLOY_PATH/.env" \
    --deny HyperCalendarBot >"$WORK/guard.out"
}
guard_rc=0
step run_guard || guard_rc=$?
((guard_rc == 0)) || die 2 "the stage guard refused the run (exit $guard_rc)"

# Only the validated fields go to the client, as one compact line.
READY_LINE="$(
  python3 - "$SHA" "$WORK/guard.out" <<'READY'
import json, re, sys
sha, path = sys.argv[1:]
lines = [l for l in open(path, encoding="utf-8").read().splitlines() if l.startswith("STAGE_GUARD ")]
try:
    if len(lines) != 1:
        raise ValueError("expected exactly one STAGE_GUARD line")
    guard = json.loads(lines[0][len("STAGE_GUARD "):])
    username, peer, cases, base = guard["username"], guard["peer"], guard["cases"], guard["base_cases"]
    if (not isinstance(username, str) or not re.fullmatch(r"[A-Za-z0-9_]{3,64}", username)
            or not isinstance(peer, str) or not re.fullmatch(r"[0-9]+", peer)
            or not isinstance(cases, list) or not cases or type(base) is not int or not 0 < base <= len(cases)):
        raise ValueError("malformed STAGE_GUARD")
except (ValueError, KeyError, TypeError) as error:
    print(f"stage guard output rejected: {error}", file=sys.stderr)
    raise SystemExit(1)
print(json.dumps({"sha": sha, "username": username, "peer": peer, "cases": cases, "base_cases": base},
                 separators=(",", ":"), ensure_ascii=True))
READY
)" || die 2 'the stage guard printed no valid STAGE_GUARD line'
printf 'STAGE_READY %s\n' "$READY_LINE" >&4

# --- hold the stage until the PC has run its cases ---
# DONE (or the ssh connection dropping = EOF) ends the wait; the watchdog budget counts from the
# host lock. read runs in this shell (not a child) so DONE is consumed from the real stdin.
while :; do
  remaining=$((RUN_STARTED + RUN_TIMEOUT - SECONDS))
  ((remaining >= 1)) || die 1 "stage QA run timed out after ${RUN_TIMEOUT}s waiting for the client to finish"
  read_rc=0
  # One-second slices: bash runs a trapped signal's handler only after read returns, so a long
  # read would delay the teardown of a cancelled job until the budget ends.
  IFS= read -r -t 1 client_line || read_rc=$?
  if ((read_rc == 0)); then
    [[ "$client_line" != DONE ]] || break
  elif ((read_rc > 128)); then
    continue
  else
    break
  fi
done
exit 0
