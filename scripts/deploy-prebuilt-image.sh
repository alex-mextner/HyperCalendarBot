#!/usr/bin/env bash
# Remote prebuilt-image activation only: no compiler, package install, or registry credentials.
set -euo pipefail

if [[ "$#" == 1 && "$1" == --activation-control-version ]]; then
  printf 'native-activation-control-v3\n'
  exit 0
fi

DEPLOY_PATH="${1:?Deployment directory required}"
REMOTE_SRC="${2:?Release staging directory required}"
IMAGE="${3:?Image name required}"
SHA="${4:?Source revision required}"
ARCHIVE_SUM="${5:?Archive checksum required}"
CONFIG_ID="${6:?Image config identity required}"
# Validate ownership BEFORE arming any cleanup trap or touching the live service.
# Hosted runs and the local fallback stage under DEPLOY_PATH; /tmp/hypercal-source-* is the
# fallback's namespace before #784 (the odroid's /tmp is a small RAM tmpfs).
python3 -I - "$DEPLOY_PATH" "$REMOTE_SRC" "$SHA" <<'PYGUARD'
from pathlib import Path
import re
import sys

raw_root, raw_stage = Path(sys.argv[1]), Path(sys.argv[2])
revision = sys.argv[3]
try:
    root, stage = raw_root.resolve(strict=True), raw_stage.resolve(strict=True)
except OSError:
    raise SystemExit("Release paths must already exist; no cleanup armed")
if (not raw_root.is_absolute() or not raw_stage.is_absolute()
        or not root.is_dir() or not stage.is_dir() or raw_stage.is_symlink()
        or root == Path("/") or stage == root or stage in root.parents
        or not re.fullmatch(r"[0-9a-f]{40}", revision)):
    raise SystemExit("Unsafe release staging path; no cleanup armed")
hosted = (stage.parent == root
          and re.fullmatch(r"\.incoming-" + revision + r"-\d+-\d+", stage.name))
local = (stage.parent == Path("/tmp").resolve()
         and re.fullmatch(r"hypercal-source-" + revision[:12] + r"-\d+", stage.name))
if not (hosted or local):
    raise SystemExit("Staging is outside the owned release namespaces; no cleanup armed")
PYGUARD
STAMP="$(date +%Y-%m-%d_%H-%M-%S)"
# BEGIN ACTIVATION_RECOVERY
# Argument 7 is required from the native root supervisor. An older six-argument
# caller must refuse before changing the runtime, even during a mixed-version rollout.
CONTROL_DIR="${7:-}"
[[ -n "$CONTROL_DIR" ]] || {
  echo 'Native activation supervisor/control required; no activation started' >&2
  exit 2
}
switched=0
finishing=0
activation_outcome=preflight_failed
control_event() {
  python3 -I - "$CONTROL_DIR" "$DEPLOY_PATH" "$REMOTE_SRC" "$SHA" "$PPID" "$$" "$@" <<'CONTROL'
import fcntl
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time

control, root, stage, sha, parent, child, operation, *values = sys.argv[1:]
control, root = Path(control), Path(root).resolve(strict=True)
info = control.lstat()
if (control.is_symlink() or not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700
        or control.resolve(strict=True).parent != root
        or not re.fullmatch(r"\.activation-" + sha + r"-[a-zA-Z0-9_-]+", control.name)):
    raise SystemExit("Unsafe activation control directory; stage retained")


def private_file(name):
    fd = os.open(control / name, os.O_RDWR | os.O_NOFOLLOW)
    details = os.fstat(fd)
    if (not stat.S_ISREG(details.st_mode) or details.st_uid != os.geteuid()
            or stat.S_IMODE(details.st_mode) != 0o600 or details.st_nlink != 1
            or details.st_size > 4096):
        os.close(fd)
        raise SystemExit("Unsafe activation control file; stage retained")
    return os.fdopen(fd, "r+")


with private_file("request.json") as stream:
    request = json.load(stream)
if (not isinstance(request, dict)
        or set(request) != {"version", "sha", "stage", "nonce", "supervisor_pid",
                            "forward_deadline", "minimum_activation_seconds", "recovery_grace_seconds"}
        or type(request["version"]) is not int or request["version"] != 3 or request["sha"] != sha
        or request["stage"] != str(Path(stage).resolve(strict=True))
        or type(request["supervisor_pid"]) is not int
        or request["supervisor_pid"] != int(parent)
        or not isinstance(request["nonce"], str)
        or not re.fullmatch(r"[0-9a-f]{32}", request["nonce"])
        or type(request["forward_deadline"]) not in (int, float)
        or not math.isfinite(request["forward_deadline"]) or request["forward_deadline"] <= 0
        or type(request["minimum_activation_seconds"]) is not int
        or request["minimum_activation_seconds"] != 1500
        or type(request["recovery_grace_seconds"]) not in (int, float)
        or not math.isfinite(request["recovery_grace_seconds"])
        or not 0 < request["recovery_grace_seconds"] <= 1500):
    raise SystemExit("Activation control does not bind this child; stage retained")
if operation == "validate":
    with private_file("lock"):
        pass
    raise SystemExit(0)
if operation == "recovery_budget":
    # Early cancellation has its own earlier ceiling. The supervisor publishes
    # it under the phase lock before signalling this exact child.
    grace = request["recovery_grace_seconds"]
    deadline = request["forward_deadline"] + grace
    now = time.monotonic()
    try:
        with private_file("cancellation.json") as stream:
            cancellation = json.load(stream)
    except FileNotFoundError:
        pass
    else:
        if (not isinstance(cancellation, dict)
                or set(cancellation) != {*request, "child_pid", "at", "recovery_deadline"}
                or any(cancellation.get(k) != v for k, v in request.items())
                or type(cancellation["child_pid"]) is not int
                or cancellation["child_pid"] != int(child)
                or type(cancellation["at"]) not in (int, float)
                or not math.isfinite(cancellation["at"])
                or not 0 < cancellation["at"] <= now
                or type(cancellation["recovery_deadline"]) not in (int, float)
                or not math.isfinite(cancellation["recovery_deadline"])
                or not cancellation["at"] < cancellation["recovery_deadline"]
                or cancellation["recovery_deadline"] > min(deadline, cancellation["at"] + grace)):
            raise SystemExit("Cancellation deadline does not bind this child; stage retained")
        deadline = cancellation["recovery_deadline"]
    print(max(0, int(min(grace, deadline - now))))
    raise SystemExit(0)
if operation == "no_retained":
    # Called while the existing service lock is held; a previous unknown attempt
    # must not be superseded by another release or by this attempt's own journal.
    if any(path != control.resolve(strict=True) for path in root.glob(".activation-*")):
        raise SystemExit("Active or retained activation blocks admission")
    raise SystemExit(0)
if operation in {"lock_budget", "admit_swap"}:
    room = request["forward_deadline"] - time.monotonic() - request["minimum_activation_seconds"]
    if room < (1 if operation == "lock_budget" else 0):
        print("Insufficient forward budget for native activation; no runtime swap started", file=sys.stderr)
        raise SystemExit(75)
    if operation == "lock_budget":
        print(min(2400, int(room)))
    raise SystemExit(0)
with private_file("lock") as lock:
    # FD 8 is held by this shell, not only by this short-lived writer. Bind it
    # to the private no-follow file before using its shared open-file lock.
    inherited, expected = os.fstat(8), os.fstat(lock.fileno())
    if (inherited.st_dev, inherited.st_ino) != (expected.st_dev, expected.st_ino):
        raise SystemExit("Activation lock descriptor mismatch; stage retained")
    fcntl.flock(8, fcntl.LOCK_EX)
    record = {**request, "child_pid": int(child), "at": time.monotonic(),
              "at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if operation == "recovering":
        record["phase"] = "recovering"
    elif operation == "forward":
        record["phase"] = "forward"
    elif operation == "terminal" and len(values) == 2:
        outcome, code = values
        if outcome not in {"preflight_failed", "verified", "rolled_back", "recovery_required"}:
            raise SystemExit("Unknown activation outcome; stage retained")
        record.update(phase="terminal", outcome=outcome, exit_code=int(code))
    else:
        raise SystemExit("Unknown activation control operation; stage retained")
    fd, temporary = tempfile.mkstemp(prefix=".state-", dir=control)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(record, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, control / "state.json")
        directory = os.open(control, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    if operation == "forward":
        fcntl.flock(8, fcntl.LOCK_UN)
CONTROL
}
control_event validate
# Read-only open cannot create or truncate a missing lock. The private directory
# is already validated; each writer rechecks the inherited descriptor identity.
exec 8<"$CONTROL_DIR/lock"
# Every recovery command shares this attempt's remaining allowance. Keep 30 s
# outside command timeouts for kill-after and the terminal proof; the supervisor
# still owns the hard deadline and retains the attempt if either cannot finish.
recovery_limit() {
  local ceiling=$1 reserve=${2:-0} remaining
  remaining=$((RECOVERY_BUDGET - (SECONDS - recovery_started) - reserve - 30))
  ((remaining > 0)) || return 124
  ((remaining <= ceiling)) || remaining=$ceiling
  printf '%s\n' "$remaining"
}
recovery_run() {
  local ceiling=$1 reserve=$2 limit
  shift 2
  limit="$(recovery_limit "$ceiling" "$reserve")" || return 124
  timeout --foreground --kill-after=10 "$limit" "$@"
}
# A closed SSH log pipe must not kill this shell before its recovery trap runs.
trap '' PIPE
finish_activation() {
  local rc=$activation_rc host_restored=0 image_restored=0 phase_published=0
  trap - EXIT
  # Protect the transition and final journal writer. Once the recovery transition
  # is durable, handled traps let bounded recovery children use normal timeouts.
  trap '' INT TERM HUP
  set +e
  if [[ "$switched" == 1 ]]; then
    [[ "$rc" != 0 ]] || rc=1
    activation_outcome=recovery_required
    recovery_started=$SECONDS
    # Retain the existing phase lock through recovery, including a failed phase
    # write. The supervisor cannot relay TERM while it still sees stale forward;
    # its nonblocking lock attempt and absolute hard deadline remain unchanged.
    flock 8
    RECOVERY_BUDGET="$(control_event recovery_budget)" || RECOVERY_BUDGET=0
    if control_event recovering; then
      phase_published=1
      trap ':' INT TERM HUP
    fi
    # A failed journal/log write cannot suppress the actual recovery attempt.
    # Every command still has its own bounded timeout and kill-after reserve.
    FAILED_EVIDENCE="$(recovery_run 300 1200 python3 "$SCRIPT_DIR/deploy-evidence.py" failed --container hypercal-bot --logs-root "$DEPLOY_PATH/logs" \
      --sha "$SHA" --receipt "$DEPLOY_PATH/releases/current.json" 2>&1 | sed -n 's/^EVIDENCE_DIR=//p')"
    [[ -z "$FAILED_EVIDENCE" ]] || printf 'FAILED_EVIDENCE %s\n' "$FAILED_EVIDENCE" >&2
    if old_image_may_run; then
      echo 'Verification failed; restoring image and host files, never restoring an older user database' >&2
      restore_host_files && host_restored=1
      restore_image && image_restored=1
      if [[ "$phase_published" == 1 && "$host_restored" == 1 && "$image_restored" == 1 ]]; then
        activation_outcome=rolled_back
      fi
    fi
  fi
  trap '' INT TERM HUP
  if [[ "$activation_outcome" == verified && "$switched" == 0 ]]; then
    # The current receipt was written before this outcome. Optional tail work
    # or cancellation cannot turn a committed release into a failed attempt.
    rc=0
  fi
  if ! control_event terminal "$activation_outcome" "$rc"; then
    activation_outcome=recovery_required
    rc=1
  fi
  # Only the supervisor may remove the stage, after this process and its group exit.
  if [[ "$activation_outcome" == recovery_required ]]; then
    printf 'ACTIVATION_RETAINED stage=%s outcome=%s\n' "$REMOTE_SRC" "$activation_outcome" >&2
  fi
  exit "$rc"
}
trap 'activation_rc=$? finishing=1; finish_activation' EXIT
trap 'if [[ "$finishing" == 0 ]]; then exit 130; fi' INT
trap 'if [[ "$finishing" == 0 ]]; then exit 143; fi' TERM
trap 'if [[ "$finishing" == 0 ]]; then exit 129; fi' HUP
# Only now may the supervisor deliver its one cooperative cancellation.
control_event forward
# END ACTIVATION_RECOVERY
exec 9>"$DEPLOY_PATH/.release.lock"
flock -n 9 || {
  echo 'Another release owns this service' >&2
  exit 1
}
control_event no_retained
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for helper in odroid-deploy-lock.sh deploy-health.py deploy-evidence.py log-retention.py; do
  [[ -f "$SCRIPT_DIR/$helper" ]] || {
    echo "Release is missing scripts/$helper; the build must ship it (docs/reference/deploy-runbook.md, Release files)" >&2
    exit 1
  }
done
# shellcheck source=odroid-deploy-lock.sh
source "$SCRIPT_DIR/odroid-deploy-lock.sh"
[[ "$(sha256sum "$REMOTE_SRC/image.tar.gz" | cut -d ' ' -f1)" == "$ARCHIVE_SUM" ]] || {
  echo 'Archive checksum mismatch' >&2
  exit 1
}
python3 "$REMOTE_SRC/scripts/release-artifact.py" "$REMOTE_SRC/image.tar.gz" "$SHA" "$IMAGE:$SHA" >"$REMOTE_SRC/artifact.json"
[[ "$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["config_digest"])' "$REMOTE_SRC/artifact.json")" == "$CONFIG_ID" ]] || exit 1
# Both repositories deploy to this one box: serialize with the other one's image load and swap (#823).
# Reserve a full native activation window from the supervisor's absolute deadline.
# Round down to whole lock slices so the shared helper cannot overrun that allowance.
ODROID_DEPLOY_LOCK_MAX_WAIT="$(control_event lock_budget)"
if ((ODROID_DEPLOY_LOCK_MAX_WAIT >= 30)); then
  ODROID_DEPLOY_LOCK_SLICE=30
  ODROID_DEPLOY_LOCK_MAX_WAIT=$((ODROID_DEPLOY_LOCK_MAX_WAIT / 30 * 30))
else
  ODROID_DEPLOY_LOCK_SLICE=1
fi
odroid_deploy_lock_acquire hcb || exit $?
# A successful wait can still exhaust the reserve before image load or backup.
control_event admit_swap
# docker load unpacks the whole archive before it registers the layers, so it needs about twice
# the unpacked image free on the Docker root. Refuse here, with the numbers, rather than fail
# halfway with a bare "no space left on device" as the 2026-09-28 release did (#481).
IMAGE_BYTES="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["image_bytes"])' "$REMOTE_SRC/artifact.json")"
DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}')"
FREE_KIB="$(df -Pk "$DOCKER_ROOT" | awk 'NR == 2 {print $4}')"
[[ "$FREE_KIB" =~ ^[0-9]+$ ]] || {
  echo "Cannot read free space on $DOCKER_ROOT" >&2
  exit 1
}
if ((FREE_KIB * 1024 < 2 * IMAGE_BYTES)); then
  echo "Not enough disk to load the release: $((FREE_KIB * 1024)) bytes free on $DOCKER_ROOT, need $((2 * IMAGE_BYTES)) (twice the $IMAGE_BYTES-byte image). Remove superseded $IMAGE tags first (docs/reference/deploy-runbook.md, Disk space)." >&2
  exit 1
fi
# Docker's image store decides what `.Id` and a container's `.Image` are: the config digest on the
# classic store, the digest of the manifest the archive's index.json names on the containerd store
# (Docker 29 on the odroid, which other projects share, so its store stays). Comparing the config
# digest there refused the first odroid release (run 38018033717, #784). release-artifact.py read
# both digests from the verified archive; compare against the one this daemon uses.
DRIVER_STATUS="$(docker info --format '{{json .DriverStatus}}')"
EXPECTED_IMAGE_ID="$(
  python3 -I - "$DRIVER_STATUS" "$REMOTE_SRC/artifact.json" <<'STORE'
import json,sys
status,artifact=sys.argv[1:]
containerd=["driver-type","io.containerd.snapshotter.v1"] in (json.loads(status) or [])
print(json.load(open(artifact))["manifest_digest" if containerd else "config_digest"])
STORE
)"
[[ "$EXPECTED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo "Release image identity is not a sha256 digest: $EXPECTED_IMAGE_ID" >&2
  exit 1
}
docker load -i "$REMOTE_SRC/image.tar.gz"
LOADED_ID="$(docker image inspect "$IMAGE:$SHA" --format '{{.Id}}')"
[[ "$LOADED_ID" == "$EXPECTED_IMAGE_ID" ]] || {
  echo "Loaded image identity mismatch: loaded=$LOADED_ID expected=$EXPECTED_IMAGE_ID" >&2
  exit 1
}
CURRENT_IMAGE_ID="$(docker inspect hypercal-bot --format '{{.Image}}' 2>/dev/null)" || {
  echo 'Existing HyperCalendar container is required; use a reviewed first-install procedure' >&2
  exit 1
}
ROLLBACK_TAG="$IMAGE:rollback-$STAMP"
docker tag "$CURRENT_IMAGE_ID" "$ROLLBACK_TAG"
# Generic image rollback is safe only while the old image still works on the database the release
# may already have migrated. scripts/migration-gate.py therefore accepts unchanged migration code,
# or new migrations whose shipped docs declare "rollback-compatible: yes" and "data-deletion: no",
# and logs one SCHEMA_GATE audit line. The ordinary clean supervisor environment does not
# forward HYPERCAL_REVIEWED_SCHEMA_TRANSITION; the old standalone and local fallback calls
# refuse before activation. An exceptional transition needs a separately accepted caller
# and migration procedure, not a fabricated private control request.
GATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/migration-gate.py"
ROLLBACK_GUARD="$REMOTE_SRC/rollback-guard"
python3 "$GATE" check hypercal-bot "$IMAGE:$SHA" "${HYPERCAL_REVIEWED_SCHEMA_TRANSITION:-}" "$ROLLBACK_GUARD" \
  || {
    echo 'Schema-changing release requires reviewed migration procedure' >&2
    exit 1
  }
CONFIG_BACKUP="$DEPLOY_PATH/releases/config-$SHA-$STAMP"
mkdir -p "$CONFIG_BACKUP/scripts"
cp "$DEPLOY_PATH/docker-compose.yml" "$DEPLOY_PATH/Caddyfile" "$CONFIG_BACKUP/"
for script in backup-db.sh healthcheck-alert.sh prepare-runtime-dirs.sh; do
  [[ ! -f "$DEPLOY_PATH/scripts/$script" ]] || cp "$DEPLOY_PATH/scripts/$script" "$CONFIG_BACKUP/scripts/"
done
restore_host_files() {
  cp "$CONFIG_BACKUP/docker-compose.yml" "$CONFIG_BACKUP/Caddyfile" "$DEPLOY_PATH/" || return 1
  for name in backup-db.sh healthcheck-alert.sh prepare-runtime-dirs.sh; do
    if [[ -f "$CONFIG_BACKUP/scripts/$name" ]]; then
      cp "$CONFIG_BACKUP/scripts/$name" "$DEPLOY_PATH/scripts/$name" || return 1
    else
      rm -f "$DEPLOY_PATH/scripts/$name" || return 1
    fi
  done
}

HEALTH=""
READY=""
VERDICT_REASON=""
# The verdict probes the bot's own published port on this host: the public ingress (Cloudflare tunnel,
# proxy) answers 502 instantly while the container restarts and is not what this release controls.
# PUBLIC_DOMAIN (root-only .env; last assignment wins, inline " #comment", quotes, CR and spaces
# dropped) is only used for one informational public probe after verification.
HEALTH_URL=http://127.0.0.1:3001
PUBLIC_DOMAIN_VALUE="$(sed -n 's/^PUBLIC_DOMAIN=//p' "$DEPLOY_PATH/.env" 2>/dev/null | tail -n 1 | sed 's/[[:space:]]#.*$//' | tr -d "\"' \r" || true)"
ready_acceptable() { case "$1" in ok | "ok (unverified)") return 0 ;; *) return 1 ;; esac }
# The multi-signal verdict lives in scripts/deploy-health.py (container state, restart count,
# /health, /ready against its pre-deploy value, fresh error logs, load-aware budget); a slow start
# is not a failure, a dead or crash-looping container is. $1 = "health" skips /ready (rollback).
# Sets HEALTH, READY and VERDICT_REASON from its RESULT line; returns its exit status.
wait_for_bot() {
  local out="$REMOTE_SRC/health.out" rc line limit
  local -a health_command=()
  HEALTH=""
  READY=""
  VERDICT_REASON=""
  if [[ "$1" == health ]]; then
    limit="$(recovery_limit 930)" || {
      echo "ROLLBACK FAILED: health recovery allowance exhausted before probing" >&2
      return 124
    }
    health_command=(timeout --foreground --kill-after=10 "$limit")
  fi
  "${health_command[@]}" python3 "$SCRIPT_DIR/deploy-health.py" wait --container hypercal-bot --url "$HEALTH_URL" \
    --mode "$1" --baseline-ready "${BASELINE_READY:-}" \
    --base-budget "${HYPERCAL_HEALTH_BASE_BUDGET:-240}" --hard-cap "${HYPERCAL_HEALTH_HARD_CAP:-900}" \
    --poll "${HYPERCAL_HEALTH_POLL:-4}" --stable "${HYPERCAL_HEALTH_STABLE:-15}" \
    --stall "${HYPERCAL_HEALTH_STALL:-120}" | tee "$out" >&2
  rc="${PIPESTATUS[0]}"
  line="$(sed -n 's/^RESULT //p' "$out" | tail -n 1)"
  HEALTH=""
  READY=""
  VERDICT_REASON="${line#*reason=}"
  if [[ "$line" =~ health=(.*)\ ready=(.*)\ elapsed= ]]; then
    HEALTH="${BASH_REMATCH[1]}"
    READY="${BASH_REMATCH[2]}"
    [[ "$HEALTH" != '<none>' ]] || HEALTH=""
    [[ "$READY" != '<none>' ]] || READY=""
  fi
  return "$rc"
}

# The previous image ID alone does not show a running bot. Readiness is reported, not required:
# an AI provider outage fails it for every image. CURRENT_IMAGE_ID and the restored container's
# .Image both come from this daemon, so they are the same kind of ID on either image store.
restore_image() {
  printf 'services:\n  bot:\n    image: "%s"\n' "$CURRENT_IMAGE_ID" >"$REMOTE_SRC/rollback.yml"
  (cd "$DEPLOY_PATH" && recovery_run 120 0 docker compose -f docker-compose.yml -f "$REMOTE_SRC/rollback.yml" up -d --no-deps --no-build --pull never --force-recreate bot) || {
    echo "ROLLBACK FAILED: rollback compose failed or exhausted its recovery allowance" >&2
    return 1
  }
  restored="$(recovery_run 30 0 docker inspect hypercal-bot --format '{{.Image}}' 2>/dev/null)" || {
    echo "ROLLBACK FAILED: previous image identity unavailable within recovery allowance" >&2
    return 1
  }
  local health_rc=0
  wait_for_bot health || health_rc=$?
  printf 'ROLLBACK image=%s health=%s ready=%s data=preserved\n' "$restored" "${HEALTH:-<none>}" "${READY:-<none>}" >&2
  [[ "$restored" == "$CURRENT_IMAGE_ID" && "$HEALTH" == ok && "$health_rc" == 0 ]] && return 0
  echo "ROLLBACK FAILED: previous image $CURRENT_IMAGE_ID did not pass the complete health verdict; the bot may be down" >&2
  return 1
}

# The rollback guard lists accepted migrations that do not declare rollback-compatible: yes (only
# a separately reviewed caller could accept them). The old image may start only on a database that records none
# of them: stop the release first so none can commit after the read, and when any is recorded, or
# the read fails, start the release again and leave it to the migration doc's Rollback section.
old_image_may_run() {
  recovery_limit 1 >/dev/null || {
    echo "ROLLBACK_SKIPPED: recovery allowance exhausted before schema guard" >&2
    return 1
  }
  [[ -s "$ROLLBACK_GUARD" ]] || return 0
  # A release that already exited can fail `docker stop`; what matters is that it no longer runs.
  recovery_run 30 0 docker stop hypercal-bot >/dev/null 2>&1
  [[ "$(recovery_run 30 0 docker inspect hypercal-bot --format '{{.State.Running}}' 2>/dev/null)" == false ]] \
    && recovery_run 300 0 python3 "$GATE" unapplied "$CURRENT_IMAGE_ID" "$DEPLOY_PATH/data" "$ROLLBACK_GUARD" && return 0
  recovery_run 30 0 docker start hypercal-bot >/dev/null \
    || echo 'ROLLBACK FAILED: the release could not be started again; the bot may be down' >&2
  printf 'ROLLBACK_SKIPPED image=%s: the database may hold %s, which the old image is not declared to survive; follow the Rollback section of docs/reference/migrations/<name>.md\n' \
    "$(recovery_run 30 0 docker inspect hypercal-bot --format '{{.Image}}' 2>/dev/null)" "$(paste -sd ' ' "$ROLLBACK_GUARD")" >&2
  return 1
}


# Back up the live DB before replacing any deployed host files or container.
"$DEPLOY_PATH/scripts/backup-db.sh"
# Readiness before the swap. The verdict waives /ready only when it was KNOWINGLY worse (an answered
# 503, e.g. the AI chain is down for every image); a probe that failed or answered something that
# is not a bot response proves nothing, so it leaves readiness required.
BASELINE_CODE="$(curl -sS --max-time 20 -o "$REMOTE_SRC/baseline-ready.body" -w '%{http_code}' "$HEALTH_URL/ready" 2>/dev/null)" || BASELINE_CODE=000
BASELINE_BODY="$(head -c 200 "$REMOTE_SRC/baseline-ready.body" 2>/dev/null | tr -d '\r\n' || true)"
BASELINE_READY=""
if [[ "$BASELINE_CODE" == 200 ]] && ready_acceptable "$BASELINE_BODY"; then BASELINE_READY="$BASELINE_BODY"; fi
if [[ "$BASELINE_CODE" == 503 ]]; then BASELINE_READY="${BASELINE_BODY:-not ready (HTTP 503)}"; fi
CURRENT_REVISION="$(docker inspect hypercal-bot --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null | cut -c1-12)" || CURRENT_REVISION=""

# Image loading, backups and baseline probes consume the same absolute budget.
control_event admit_swap
switched=1
install -d -m 0755 "$DEPLOY_PATH/scripts"
install -m 0644 "$REMOTE_SRC/docker-compose.yml" "$DEPLOY_PATH/docker-compose.yml"
install -m 0644 "$REMOTE_SRC/Caddyfile" "$DEPLOY_PATH/Caddyfile"
for script in backup-db.sh healthcheck-alert.sh prepare-runtime-dirs.sh; do
  install -m 0755 "$REMOTE_SRC/scripts/$script" "$DEPLOY_PATH/scripts/$script"
done

"$DEPLOY_PATH/scripts/prepare-runtime-dirs.sh" "$DEPLOY_PATH"

echo "Rotating host logs before restart"
for file in healthcheck.log backup.log; do
  if [[ -s "$DEPLOY_PATH/logs/$file" ]]; then
    mv "$DEPLOY_PATH/logs/$file" "$DEPLOY_PATH/logs/${file%.log}_${STAMP}.log"
    gzip "$DEPLOY_PATH/logs/${file%.log}_${STAMP}.log"
  fi
done

# The outgoing container's complete log goes to the host before the recreate destroys it (owner
# requirement 7). Best effort: it never blocks the release.
timeout --foreground --kill-after=10 300 python3 "$SCRIPT_DIR/deploy-evidence.py" release-logs --container hypercal-bot --logs-root "$DEPLOY_PATH/logs" \
  --label "${CURRENT_REVISION:-${CURRENT_IMAGE_ID:7:12}}" >&2 || true

# Pin the runtime selector, independent of environment or stale :latest aliases.
printf 'services:\n  bot:\n    image: "%s"\n' "$IMAGE:$SHA" >"$REMOTE_SRC/image.yml"
cd "$DEPLOY_PATH"
timeout --foreground --kill-after=10 120 docker compose -f docker-compose.yml -f "$REMOTE_SRC/image.yml" up -d --no-deps --no-build --pull never --force-recreate bot
# Do not reload the shared server proxy: this release changes no proxy routing.

ACTUAL_IMAGE_ID="$(docker inspect hypercal-bot --format '{{.Image}}')"
if [[ "$ACTUAL_IMAGE_ID" != "$EXPECTED_IMAGE_ID" ]]; then
  echo "Container image mismatch: running=$ACTUAL_IMAGE_ID expected=$EXPECTED_IMAGE_ID" >&2
  exit 1
fi

if ! wait_for_bot ready; then
  if [[ "$HEALTH" != ok ]]; then
    echo "Health check failed after deploy: $VERDICT_REASON" >&2
  elif ! ready_acceptable "$READY"; then
    echo "Readiness path is not returning a bot response: ${READY:-<empty>} ($VERDICT_REASON)" >&2
  else
    echo "Release did not stay healthy: $VERDICT_REASON" >&2
  fi
  exit 1
fi

REVISION="$(docker image inspect "$IMAGE:$SHA" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
[[ "$REVISION" == "$SHA" ]] || exit 1
# Runtime verification is the commit point. Metadata or alias failures cannot undo it.
# A receipt failure retains the attempt without restoring a previously running image.
activation_outcome=recovery_required switched=0
printf 'RUNTIME_VERIFIED sha=%s image=%s ready=%s\n' "$REVISION" "$ACTUAL_IMAGE_ID" "$READY"
# config_digest is the release identity on every store; image_id is what this daemon reports as the
# container's .Image, which scripts/post-ship-deploy.py compares with the live container.
python3 -I - "$DEPLOY_PATH/releases/current.json" "$REVISION" "$CONFIG_ID" "$ACTUAL_IMAGE_ID" "$ARCHIVE_SUM" "$READY" "$ROLLBACK_TAG" <<'RECEIPT'
import datetime,json,os,sys
path,sha,config,image,archive,ready,rollback=sys.argv[1:]
record={"revision":sha,"config_digest":config,"image_id":image,"archive_sha256":archive,"ready":ready,"rollback_image":rollback,"verified_at":datetime.datetime.now(datetime.timezone.utc).isoformat()}
with open(path+'.tmp','w') as f:json.dump(record,f,indent=2)
os.replace(path+'.tmp',path)
RECEIPT
activation_outcome=verified
# Informational work follows the receipt. It is bounded and cannot fail the
# verified release; cancellation still reaches the terminal proof promptly.
if [[ "$PUBLIC_DOMAIN_VALUE" =~ ^[A-Za-z0-9.-]+$ ]]; then
  PUBLIC_HEALTH="$(timeout --foreground --kill-after=10 25 curl -sS --max-time 20 "https://$PUBLIC_DOMAIN_VALUE/health" 2>/dev/null || true)"
  printf 'PUBLIC_PROBE host=%s health=%s (informational: the release is verified on its own port)\n' "$PUBLIC_DOMAIN_VALUE" "${PUBLIC_HEALTH:-<none>}" || true
fi
timeout --foreground --kill-after=10 20 docker tag "$IMAGE:$SHA" "$IMAGE:latest" \
  || echo 'IMAGE_ALIAS update failed; the verified release stays in place' >&2
printf 'DEPLOYED sha=%s image=%s health=%s ready=%s\n' "$REVISION" "$ACTUAL_IMAGE_ID" "$HEALTH" "$READY" || true

# Every release keeps the previous image under a new ~2 GB rollback tag; 42 of them filled the
# shared host on 2026-09-28 (#481). Keep the five newest rollback tags and the current and previous
# releases, and remove every other tag of this repository. Docker removes an image with its last
# tag and refuses (without -f) one a container still uses. This runs after the commit point, so a
# failure is reported and never fails or undoes the verified release.
timeout --foreground --kill-after=10 120 python3 -I - "$IMAGE" "$SHA" "$CURRENT_IMAGE_ID" 5 <<'RETENTION' || echo 'IMAGE_RETENTION failed; the verified release stays in place' >&2
import re,signal,subprocess,sys


def cancel_retention(signum, _frame):
    # A foreground timeout signals this Python process. Unwind subprocess.run
    # so it kills and waits for its current owned command instead of orphaning it.
    raise SystemExit(128 + signum)


signal.signal(signal.SIGTERM, cancel_retention)
image,sha,previous,keep=sys.argv[1],sys.argv[2],sys.argv[3],int(sys.argv[4])
listing=subprocess.run(["docker","images","--no-trunc","--format","{{.Tag}}\t{{.ID}}",image],check=True,capture_output=True,text=True,timeout=20).stdout
tags=dict(line.split("\t") for line in listing.splitlines())
tags.pop("<none>",None)
# The stamp is %Y-%m-%d_%H-%M-%S, so name order is age order; other rollback-* names count as oldest.
rollbacks=sorted((t for t in tags if re.fullmatch(r"rollback-\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d",t)),reverse=True)
keep_tags={sha,"latest",*rollbacks[:keep]}
keep_ids={previous,*(tags[t] for t in keep_tags if t in tags)}
failed=False
for tag in sorted(t for t in tags if t not in keep_tags and tags[t] not in keep_ids):
    result=subprocess.run(["docker","image","rm",f"{image}:{tag}"],capture_output=True,text=True,timeout=20)
    if result.returncode:
        failed=True
        print(f"IMAGE_RETENTION kept={image}:{tag} error={result.stderr.strip()}",file=sys.stderr)
    else:
        print(f"IMAGE_RETENTION removed={image}:{tag}")
sys.exit(1 if failed else 0)
RETENTION

# Log retention (owner requirement 7): deploys and rollbacks never delete logs; only a violated size,
# file-count or free-space criterion does, oldest first, sparing the last deploy's and the last
# failure's directories (scripts/log-retention.py). After the commit point, so a problem here is
# reported and never fails or undoes the verified release.
# The installed copy is what root cron runs between deploys (disk-space watchdog, runbook).
# The private control directory owns a partial copy until atomic publication.
# os.replace refuses a cross-filesystem move instead of copying over the old file.
if timeout --foreground --kill-after=10 10 install -m 0755 "$SCRIPT_DIR/log-retention.py" "$CONTROL_DIR/log-retention.py" >&2 \
    && timeout --foreground --kill-after=10 10 python3 -I - "$CONTROL_DIR/log-retention.py" "$DEPLOY_PATH/scripts/log-retention.py" <<'PUBLISH_RETENTION'
import os,sys
os.replace(sys.argv[1], sys.argv[2])
PUBLISH_RETENTION
then
  :
else
  echo 'LOG_RETENTION install failed; cron keeps running the previous copy' >&2
fi
# Let the existing compression cleanup preserve a retryable original on soft timeout.
timeout --foreground --kill-after=10 60 python3 -I - "$SCRIPT_DIR/log-retention.py" --root "$DEPLOY_PATH/logs" --env-file "$DEPLOY_PATH/.env" --alert <<'LOG_RETENTION' >&2 \
  || echo 'LOG_RETENTION reported a violated criterion; the verified release stays in place' >&2
import runpy, signal, sys

def terminate(signum, _frame):
    raise SystemExit(128 + signum)

signal.signal(signal.SIGTERM, terminate)
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
LOG_RETENTION
