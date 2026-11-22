#!/usr/bin/env bash
# Root side of the hosted deploy on the odroid (#784). The self-hosted runner user
# `hcb-runner` is not in the docker group and has no general sudo; sudoers lets it run
# only this file, installed by hand as root:root 0755 at
# /usr/local/sbin/hypercal-activate-release.
#
# Trust model: root trusts nothing the runner hands it except a commit SHA and a
# short-lived GitHub token, and the token only authenticates API calls. Root itself
# checks that main still points at the SHA and reads the newest `release-artifact`
# commit status on it. Only the GitHub-hosted build job can post that status (the deploy
# job has no `statuses: write`), and it names the artifact id and digest that job
# uploaded. Root requires that artifact to be `release-<sha>` from the push-to-main run
# of .github/workflows/deploy.yml the status links to, downloads it (the token is not sent
# to the blob-storage redirect), checks the digest, extracts only the known release files
# into a fresh root-owned stage, and runs the staged scripts/deploy-prebuilt-image.sh.
# Code running as hcb-runner can therefore at most redeploy the release that main's
# GitHub-hosted build job recorded, even if it uploads more artifacts into the same run.
#
# Usage: printf '%s\n' "$GITHUB_TOKEN" | sudo -n /usr/local/sbin/hypercal-activate-release <sha40>
# The token is read from stdin only; it never appears in argv, the environment of a
# child process, or any output.
set -euo pipefail
umask 077

# Fixed on purpose: no environment overrides (sudo resets the environment anyway).
readonly API=https://api.github.com
readonly REPO=alex-mextner/HyperCalendarBot
readonly WORKFLOW_PATH=.github/workflows/deploy.yml
readonly DEPLOY_PATH=/opt/hypercal
readonly IMAGE=ghcr.io/alex-mextner/hypercalendarbot
readonly SAFE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH="$SAFE_PATH"
# The runner's working directory is not part of the root helper's import path.
cd /
STARTED="$(python3 -I -c 'import time; print(time.monotonic())')"

fail() {
  echo "hypercal-activate-release: $*" >&2
  exit 2
}

# shellcheck disable=SC2016 # $GITHUB_TOKEN is literal text in the usage line
(($# == 1)) || fail 'usage: printf "%s\n" "$GITHUB_TOKEN" | hypercal-activate-release <sha40>'
SHA="$1"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'revision must be a full 40-character lowercase commit SHA'

# The activator's own guard accepts a stage only as $DEPLOY_PATH/.incoming-<sha>-<n>-<n>.
STAGE="$DEPLOY_PATH/.incoming-$SHA-$(date +%s)-$$"
# The supervisor creates this directory only after Python starts successfully.

# Exec makes this PID the supervisor: cancellation never waits on a Bash
# foreground child before it can start the bounded native recovery protocol.
# The program arrives on fd 3; stdin remains exclusively the token pipe.
exec python3 -I /dev/fd/3 "$API" "$REPO" "$WORKFLOW_PATH" "$IMAGE" "$SHA" "$STAGE" "$STARTED" 3<<'PY'
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

API, REPO, WORKFLOW_PATH, IMAGE, SHA, STAGE, STARTED = sys.argv[1:]
STARTED = float(STARTED)
MAX_ARTIFACT_BYTES = 4 * 1024**3
MAX_JSON_BYTES = 8 * 1024 * 1024
MAX_STATUS_PAGES = 10
STATUS_CONTEXT = "release-artifact"
STATUS_CREATOR = "github-actions[bot]"
STATUS_DESCRIPTION = re.compile(r"artifact ([1-9][0-9]*) (sha256:[0-9a-f]{64})")
RUN_URL = re.compile(r"https://github\.com/" + re.escape(REPO) + r"/actions/runs/([1-9][0-9]*)", re.IGNORECASE)
MAX_REDIRECTS = 3
REQUIRED = ("image.tar.gz", "docker-compose.yml", "Caddyfile")
# The wrapper is installed by hand, so it accepts the helper files of later changes ahead of time and
# a release built before them still deploys. The activator itself (deploy-prebuilt-image.sh) refuses a
# release that lacks a helper it needs, so optional here does not mean optional for the deploy.
OPTIONAL = ("artifact.json",)
OPTIONAL_SCRIPTS = (
    "odroid-deploy-lock.sh",
    "deploy-health.py",
    "deploy-evidence.py",
    "log-retention.py",
)
SCRIPTS = (
    "backup-db.sh",
    "healthcheck-alert.sh",
    "prepare-runtime-dirs.sh",
    "release-artifact.py",
    "deploy-prebuilt-image.sh",
    "migration-gate.py",
)
USER_AGENT = "hypercal-activate-release"


def refuse(message):
    print("hypercal-activate-release: " + message, file=sys.stderr)
    sys.exit(2)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """urllib would forward Authorization to a redirect target; redirects are handled by hand."""

    def redirect_request(self, *args, **kwargs):
        return None


OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)


def read_token():
    token = sys.stdin.readline(4097).rstrip("\n")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{20,4096}", token):
        refuse("a GitHub token is required on stdin")
    return token


def authorized(token, url):
    return urllib.request.Request(
        url,
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": USER_AGENT,
        },
    )


def api(token, path, shape=dict):
    shown = path.split("?", 1)[0]
    try:
        with OPENER.open(authorized(token, API + path), timeout=30) as response:
            data = response.read(MAX_JSON_BYTES + 1)
    except urllib.error.HTTPError as error:
        refuse(f"GitHub API {shown} answered HTTP {error.code}")
    except OSError as error:
        refuse(f"GitHub API {shown} unreachable ({type(error).__name__})")
    if len(data) > MAX_JSON_BYTES:
        refuse(f"GitHub API {shown} answer is too large")
    try:
        payload = json.loads(data)
    except ValueError:
        refuse(f"GitHub API {shown} answer is not JSON")
    if not isinstance(payload, shape):
        refuse(f"GitHub API {shown} answer is not a JSON {shape.__name__}")
    return payload


def same_repository(value):
    return isinstance(value, dict) and str(value.get("full_name", "")).lower() == REPO.lower()


def main_still_targets_release(token):
    ref = api(token, f"/repos/{REPO}/git/ref/heads/main")
    target = ref.get("object")
    main = target.get("sha") if isinstance(target, dict) else None
    if main != SHA:
        shown = main if isinstance(main, str) and re.fullmatch(r"[0-9a-f]{40}", main) else "<unreadable>"
        refuse(f"superseded: main is {shown}, not {SHA}")


def pinned_release(token):
    """(artifact id, digest, run id) recorded by the GitHub-hosted build job's commit status.

    The deploy job itself runs on the odroid runner, so anything there can upload more
    release-<sha> artifacts into the same trusted run. Only the build job, on a GitHub-hosted
    runner, holds `statuses: write`; the newest `release-artifact` status it posted names the
    one artifact to deploy.
    """
    for page in range(1, MAX_STATUS_PAGES + 1):
        query = urllib.parse.urlencode({"per_page": 100, "page": page})
        statuses = api(token, f"/repos/{REPO}/commits/{SHA}/statuses?{query}", shape=list)
        # Newest first, so the first release-artifact entry is the current one.
        status = next((s for s in statuses if isinstance(s, dict) and s.get("context") == STATUS_CONTEXT), None)
        if status is not None or not statuses:
            break
    else:
        refuse(f"no {STATUS_CONTEXT} status within the newest {MAX_STATUS_PAGES * 100} statuses on {SHA}")
    if status is None:
        refuse(f"no {STATUS_CONTEXT} commit status on {SHA}; the build job did not record a release")
    if status.get("state") != "success":
        refuse(f"{STATUS_CONTEXT} status is {status.get('state')!r}, not 'success'")
    creator = status.get("creator")
    if not isinstance(creator, dict) or creator.get("login") != STATUS_CREATOR:
        refuse(f"{STATUS_CONTEXT} status was not posted by {STATUS_CREATOR}")
    described = STATUS_DESCRIPTION.fullmatch(str(status.get("description")))
    if described is None:
        refuse(f"{STATUS_CONTEXT} status description is not 'artifact <id> sha256:<hex>'")
    run = RUN_URL.fullmatch(str(status.get("target_url")))
    if run is None:
        refuse(f"{STATUS_CONTEXT} status target is not a workflow run of {REPO}")
    return int(described[1]), described[2], int(run[1])


def release_artifact(token):
    """The pinned release-<sha> artifact, checked against the status and its push-to-main run."""
    artifact_id, digest, run_id = pinned_release(token)
    artifact = api(token, f"/repos/{REPO}/actions/artifacts/{artifact_id}")
    if type(artifact.get("id")) is not int or artifact["id"] != artifact_id or artifact.get("name") != "release-" + SHA:
        refuse(f"artifact {artifact_id} is not release-{SHA}")
    if artifact.get("expired") is not False:
        refuse(f"artifact {artifact_id} has expired")
    if artifact.get("digest") != digest:
        refuse(f"artifact {artifact_id} digest differs from the build job's status")
    size = artifact.get("size_in_bytes")
    # `type(...) is int`, not isinstance: a JSON true/false would otherwise pass as 1/0.
    if type(size) is not int or not 0 < size <= MAX_ARTIFACT_BYTES:
        refuse("artifact size is missing or above 4 GiB")
    workflow_run = artifact.get("workflow_run")
    if not isinstance(workflow_run, dict) or workflow_run.get("id") != run_id:
        refuse(f"artifact {artifact_id} was not uploaded by run {run_id} named in the build job's status")
    details = api(token, f"/repos/{REPO}/actions/runs/{run_id}")
    if not (
        details.get("id") == run_id
        and details.get("event") == "push"
        and details.get("head_branch") == "main"
        and details.get("head_sha") == SHA
        and details.get("path") == WORKFLOW_PATH
        and same_repository(details.get("repository"))
        and same_repository(details.get("head_repository"))
    ):
        refuse(f"run {run_id} is not a push-to-main run of {WORKFLOW_PATH} for {SHA}")
    return artifact_id, digest


def write_new(path, source, what):
    """Stream source into a new 0600 file, at most 4 GiB actually written; return its sha256 hex."""
    digest = hashlib.sha256()
    written = 0
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        while chunk := source.read(1024 * 1024):
            written += len(chunk)
            if written > MAX_ARTIFACT_BYTES:
                refuse(f"{what} is larger than 4 GiB")
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                view = view[os.write(fd, view) :]
    finally:
        os.close(fd)
    return digest.hexdigest()


def download(token, artifact_id, expected_digest, path):
    url = f"{API}/repos/{REPO}/actions/artifacts/{artifact_id}/zip"
    request = authorized(token, url)
    for _ in range(MAX_REDIRECTS + 1):
        try:
            with OPENER.open(request, timeout=60) as response:
                actual = "sha256:" + write_new(path, response, "artifact download")
            break
        except urllib.error.HTTPError as error:
            location = (
                error.headers.get("Location") if error.code in (301, 302, 303, 307, 308) else None
            )
            error.close()
            if not location:
                refuse(f"artifact download answered HTTP {error.code}")
            url = urllib.parse.urljoin(url, location)
            if urllib.parse.urlsplit(url).scheme != urllib.parse.urlsplit(API).scheme:
                refuse("artifact download redirect changes the URL scheme")
            # Every redirect target gets a fresh request: the GitHub token must not reach the storage host.
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        except OSError as error:
            refuse(f"artifact download failed ({type(error).__name__})")
    else:
        refuse(f"artifact download redirected more than {MAX_REDIRECTS} times")
    if actual != expected_digest:
        refuse("artifact digest mismatch")


def extract_known_files(zip_path):
    """Copy only the fixed release paths; member names never build a path. Return each file's sha256."""
    os.mkdir(os.path.join(STAGE, "scripts"), 0o700)
    wanted = [(name, True) for name in REQUIRED]
    wanted += [(name, False) for name in OPTIONAL]
    wanted += [("scripts/" + name, True) for name in SCRIPTS]
    wanted += [("scripts/" + name, False) for name in OPTIONAL_SCRIPTS]
    sums = {}
    with zipfile.ZipFile(zip_path) as archive:
        names = archive.namelist()
        for name, required in wanted:
            count = names.count(name)
            if count == 0:
                if required:
                    refuse(f"release file missing from artifact: {name}")
                continue
            if count > 1:
                refuse(f"release file appears twice in artifact: {name}")
            info = archive.getinfo(name)
            if info.is_dir():
                refuse(f"release file is not a regular file: {name}")
            with archive.open(info) as source:
                sums[name] = write_new(os.path.join(STAGE, name), source, f"release file {name}")
    return sums


def release_config_digest(archive_sum):
    """Image config digest of the staged, verified release, checked against its archive checksum."""
    image = os.path.join(STAGE, "image.tar.gz")
    inspected = subprocess.run(
        [sys.executable, os.path.join(STAGE, "scripts/release-artifact.py"), image, SHA, f"{IMAGE}:{SHA}"],
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")},
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=remaining_budget(),
    )
    if inspected.returncode != 0:
        lines = inspected.stderr.strip().splitlines()
        refuse("release image rejected: " + (lines[-1] if lines else f"exit {inspected.returncode}"))
    try:
        artifact = json.loads(inspected.stdout)
    except ValueError:
        refuse("release-artifact.py printed no JSON")
    if not isinstance(artifact, dict):
        refuse("release-artifact.py printed no JSON object")
    config = artifact.get("config_digest")
    if artifact.get("archive_sha256") != archive_sum or not re.fullmatch(r"sha256:[0-9a-f]{64}", str(config)):
        refuse("release image identity is inconsistent")
    return config



# Native activation supervision. Fixed production budgets have no environment
# override; the caller's 4500-second transport cap leaves room beyond 2700+1500.
FORWARD_BUDGET = 2700
RECOVERY_GRACE = 1500
MINIMUM_ACTIVATION_SECONDS = 1500
STOP_REQUESTED = 0


def request_stop(signum, _frame):
    global STOP_REQUESTED
    if not STOP_REQUESTED:
        STOP_REQUESTED = signum


def remaining_budget():
    if STOP_REQUESTED:
        raise SystemExit(128 + STOP_REQUESTED)
    remaining = STARTED + FORWARD_BUDGET - time.monotonic()
    if remaining <= 0:
        raise SystemExit(124)
    return remaining


def require_activation_budget():
    if remaining_budget() < MINIMUM_ACTIVATION_SECONDS:
        report("Insufficient remaining budget; no native activation started", error=True)
        raise SystemExit(75)


def preflight_stop(signum, _frame):
    raise SystemExit(124 if signum == signal.SIGALRM else 128 + signum)


def require_no_retained_activation():
    # A prior unknown attempt remains an explicit operator hold. Do not infer
    # recovery from an old PID, a new commit or a journal timestamp.
    if any(Path(STAGE).parent.glob(".activation-*")):
        refuse("active or retained activation blocks admission; no activation started")


def private_record(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "r") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1
                or info.st_size > 4096):
            raise ValueError("unsafe activation state")
        return json.load(stream)


def write_record(control, name, record):
    fd, temporary = tempfile.mkstemp(prefix=".record-", dir=control)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(record, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, control / name)
        directory = os.open(control, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def child_state(control, request, pid):
    try:
        state = private_record(control / "state.json")
        if not isinstance(state, dict) or any(state.get(k) != v for k, v in request.items()):
            return {}
        if type(state.get("child_pid")) is not int or state["child_pid"] != pid:
            return {}
        if (type(state.get("at")) not in (int, float)
                or not math.isfinite(state["at"]) or not 0 < state["at"] <= time.monotonic()):
            return {}
        return state
    except (OSError, ValueError):
        return {}


def group_has_live_descendants(pid):
    # The leader is still an unreaped child (waitid WNOWAIT), so its process-group
    # ID cannot be recycled before this check/termination. Read only proc metadata.
    try:
        entries = Path("/proc").iterdir()
        for path in entries:
            if not path.name.isdecimal() or int(path.name) == pid:
                continue
            try:
                fields = (path / "stat").read_text().rsplit(")", 1)[1].split()
                if fields[0] != "Z" and int(fields[2]) == pid and int(fields[3]) == pid:
                    return True
            except (OSError, ValueError, IndexError):
                continue
    except OSError:
        return True
    return False


def signal_owned_group(child, signum):
    try:
        os.killpg(child.pid, signum)
    except ProcessLookupError:
        pass


def report(message, *, error=False):
    # Status transport is optional. Neither a closed pipe nor a stalled reader
    # may delay recovery or hard termination. Child output uses a private file.
    descriptor, flags = None, None
    try:
        descriptor = (sys.stderr if error else sys.stdout).fileno()
        flags = fcntl.fcntl(descriptor, fcntl.F_GETFL)
        fcntl.fcntl(descriptor, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        os.write(descriptor, (message + "\n").encode("utf-8", errors="replace")[:4096])
    except (OSError, ValueError, AttributeError):
        pass
    finally:
        if flags is not None:
            try:
                fcntl.fcntl(descriptor, fcntl.F_SETFL, flags)
            except OSError:
                pass


def retain_unknown(control, request, child, reason):
    record = {**request, "child_pid": child.pid, "at": time.monotonic(),
              "at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "phase": "terminal", "outcome": "unknown", "reason": reason}
    try:
        write_record(control, "supervisor.json", record)
    except OSError:
        report("ACTIVATION_RETAINED: state write failed; never remove the stage", error=True)
    report(f"ACTIVATION_RETAINED stage={STAGE} control={control} outcome=unknown reason={reason}", error=True)


def kill_owned_group(child):
    signal_owned_group(child, signal.SIGKILL)
    try:
        child.wait(timeout=10)
    except subprocess.TimeoutExpired:
        # Uninterruptible kernel I/O may outlive SIGKILL. The retained unknown
        # journal continues to block admission; never claim cleanup or recovery.
        pass


def wait_for_activation(child, control, request, lock):
    recovery_deadline = None
    stop_code = 0
    cancel_sent = False
    cancel_record_failed = False
    while os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None:
        now = time.monotonic()
        cancelled = STOP_REQUESTED or now >= STARTED + FORWARD_BUDGET
        if STOP_REQUESTED:
            stop_code = stop_code or 128 + STOP_REQUESTED
        if cancelled:
            if recovery_deadline is None:
                recovery_deadline = min(now + RECOVERY_GRACE,
                                        STARTED + FORWARD_BUDGET + RECOVERY_GRACE)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            # Recovery retains this lock even if its next state write fails.
            # Read only the atomically published, bound phase for its deadline;
            # a busy lock never permits cooperative group cancellation.
            state = child_state(control, request, child.pid)
        else:
            try:
                state = child_state(control, request, child.pid)
                if (cancelled and not cancel_sent and not cancel_record_failed
                        and now < recovery_deadline):
                    if state.get("phase") == "forward":
                        # Bind the remaining grace before TERM. A delayed Bash trap
                        # must not restart the allowance from its later entry time.
                        try:
                            write_record(control, "cancellation.json", {
                                **request, "child_pid": child.pid, "at": now,
                                "recovery_deadline": recovery_deadline,
                            })
                        except OSError:
                            # No cancellation without durable deadline handoff.
                            # The unchanged hard deadline retains this attempt.
                            cancel_record_failed = True
                            report("Cancellation deadline unavailable; retaining supervision", error=True)
                        else:
                            # Forward is durable only after the recovery traps are
                            # armed; the same lock protects the recovery transition.
                            signal_owned_group(child, signal.SIGTERM)
                            stop_code = stop_code or 124
                            cancel_sent = True
                    elif state.get("phase") in {"recovering", "terminal"}:
                        cancel_sent = True
                    # Missing startup proof never authorizes an early TERM. The
                    # unchanged outer hard deadline still retains and reaps it.
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)
        if state.get("phase") == "recovering":
            end = min(state["at"] + RECOVERY_GRACE,
                      STARTED + FORWARD_BUDGET + RECOVERY_GRACE)
            recovery_deadline = min(recovery_deadline or end, end)
        if recovery_deadline is not None and now >= recovery_deadline:
            retain_unknown(control, request, child, "recovery_deadline")
            kill_owned_group(child)
            return 124, {}
        time.sleep(0.05)
    state = child_state(control, request, child.pid)
    if group_has_live_descendants(child.pid):
        retain_unknown(control, request, child, "unfinished_child_group")
        kill_owned_group(child)
        return stop_code or 1, {}
    rc = child.wait(timeout=10)
    rc = 128 - rc if rc < 0 else rc
    if (state.get("phase") != "terminal" or type(state.get("exit_code")) is not int
            or state["exit_code"] != rc):
        retain_unknown(control, request, child, "missing_terminal_proof")
        return stop_code or rc or 1, {}
    if state.get("outcome") == "verified":
        if rc:
            retain_unknown(control, request, child, "verified_exit_mismatch")
            return rc, {}
        # Receipt-bound success and a fully exited group are authoritative even
        # when cancellation arrived during optional work after the commit point.
        return 0, state
    return stop_code or rc, state


def preserve_activation_output(control, *, preserve=True):
    # DEPLOY/logs is bot-owned and bind-mounted. Keep supervisor evidence outside
    # that tree so prepare-runtime-dirs cannot chown it to the application.
    logs = Path(STAGE).parent / ".native-activation-logs"
    if preserve:
        logs.mkdir(mode=0o700, exist_ok=True)
        info = logs.lstat()
        if (not stat.S_ISDIR(info.st_mode) or logs.is_symlink()
                or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700):
            raise ValueError("unsafe native activation log directory")
    source = control / "activation.log"
    descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
            raise ValueError("unsafe native activation log")
        destination = source
        if preserve:
            destination = logs / (control.name.removeprefix(".") + ".log")
            # An exclusive link preserves evidence without overwriting another run.
            os.link(source, destination, follow_symlinks=False)
            source.unlink()
        report(f"ACTIVATION_LOG path={destination}")
        stream.seek(max(0, info.st_size - 16384))
        tail = stream.read(16384).decode("utf-8", errors="replace")
        for line in tail.splitlines():
            report(line, error=True)


def supervise_activation(archive_sum, config_id):
    control = None
    child = None
    try:
        require_activation_budget()
        require_no_retained_activation()
        require_activation_protocol()
        control = Path(tempfile.mkdtemp(prefix=f".activation-{SHA}-", dir=Path(STAGE).parent))
        request = {"version": 3, "sha": SHA, "stage": str(Path(STAGE).resolve(strict=True)),
                   "nonce": secrets.token_hex(16), "supervisor_pid": os.getpid(),
                   "forward_deadline": STARTED + FORWARD_BUDGET,
                   "minimum_activation_seconds": MINIMUM_ACTIVATION_SECONDS,
                   "recovery_grace_seconds": RECOVERY_GRACE}
        write_record(control, "request.json", request)
        lock_fd = os.open(control / "lock", os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(lock_fd, "r+") as lock:
            output_fd = os.open(control / "activation.log",
                                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(output_fd, "wb") as output:
                priority = ["nice", "-n", "10"]
                if shutil.which("ionice"):
                    priority += ["ionice", "-c", "2", "-n", "7"]
                command = [*priority, "bash", str(Path(STAGE) / "scripts/deploy-prebuilt-image.sh"),
                           str(Path(STAGE).parent), STAGE, IMAGE, SHA, archive_sum, config_id, str(control)]
                require_activation_budget()
                child = subprocess.Popen(
                    command, start_new_session=True, stdin=subprocess.DEVNULL, cwd="/",
                    stdout=output, stderr=output,
                    env={"PATH": os.environ["PATH"], "HOME": "/root", "LANG": "C.UTF-8"},
                )
                rc, state = wait_for_activation(child, control, request, lock)
    except BaseException:
        # This cleanup is valid only before any native child can mutate runtime.
        if child is None:
            shutil.rmtree(STAGE, ignore_errors=True)
            if control is not None:
                shutil.rmtree(control, ignore_errors=True)
        raise
    outcome = state.get("outcome", "unknown")
    if outcome in {"preflight_failed", "verified", "rolled_back"}:
        try:
            preserve_activation_output(control)
        except (OSError, ValueError):
            retain_unknown(control, request, child, "log_preservation_failed")
            return rc or 1
        shutil.rmtree(STAGE)
        shutil.rmtree(control)
        report(f"ACTIVATION_COMPLETE sha={SHA} outcome={outcome}")
    else:
        report(f"ACTIVATION_RETAINED stage={STAGE} control={control} outcome={outcome}", error=True)
        try:
            preserve_activation_output(control, preserve=False)
        except (OSError, ValueError):
            report("ACTIVATION_LOG unavailable; the attempt remains retained", error=True)
    return rc or (0 if outcome in {"preflight_failed", "verified", "rolled_back"} else 1)


def require_activation_protocol():
    probe = subprocess.run(
        ["bash", str(Path(STAGE) / "scripts/deploy-prebuilt-image.sh"), "--activation-control-version"],
        stdin=subprocess.DEVNULL, capture_output=True, text=True, cwd="/",
        env={"PATH": os.environ["PATH"], "HOME": "/root", "LANG": "C.UTF-8"},
        timeout=min(10, remaining_budget()),
    )
    if probe.returncode or probe.stdout.strip() != "native-activation-control-v3":
        refuse("release helper lacks native-activation-control-v3; no activation started")


def main():
    # Failed interpreter startup creates no stage. An existing path is refused
    # before entering cleanup, so this attempt never removes another directory.
    Path(STAGE).mkdir(mode=0o700)
    # During preparation no runtime mutation has happened. The alarm bounds all
    # reads and the inspector, including a source that keeps delivering bytes.
    try:
        for signum in (signal.SIGUSR1, signal.SIGUSR2, signal.SIGQUIT):
            signal.signal(signum, signal.SIG_IGN)
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGALRM):
            signal.signal(signum, preflight_stop)
        signal.setitimer(signal.ITIMER_REAL, remaining_budget())
        require_no_retained_activation()
        token = read_token()
        main_still_targets_release(token)
        artifact_id, expected_digest = release_artifact(token)
        zip_path = os.path.join(STAGE, "release.zip")
        download(token, artifact_id, expected_digest, zip_path)
        del token
        sums = extract_known_files(zip_path)
        os.unlink(zip_path)
        archive_sum = sums["image.tar.gz"]
        config_id = release_config_digest(archive_sum)
        signal.setitimer(signal.ITIMER_REAL, 0)
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(signum, request_stop)
        signal.signal(signal.SIGALRM, signal.SIG_IGN)
    except BaseException:
        # Preparation never started a runtime child. Finish only this attempt's
        # cleanup even if cancellation is relayed again or its alarm fires.
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGALRM):
            signal.signal(signum, signal.SIG_IGN)
        signal.setitimer(signal.ITIMER_REAL, 0)
        shutil.rmtree(STAGE, ignore_errors=True)
        raise
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
    return supervise_activation(archive_sum, config_id)


if __name__ == "__main__":
    raise SystemExit(main())
PY
