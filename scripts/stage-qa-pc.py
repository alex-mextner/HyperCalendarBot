#!/usr/bin/env python3
"""PC driver of the per-PR stage QA (#840): `stage-qa-pc.py <sha40> [--config FILE]`, token on stdin line 1.

Why this exists on the PC: the stage bot is driven through qa-cli (Telegram Web, logged in on THIS
machine), while the stage instance itself lives on the odroid. The driver ties the two halves together:

  1. PC qa lock (flock, shared with the ESB driver), 2. ssh with the forced-command key to the odroid
  wrapper (it verifies the SHA/PR/artifact itself, starts the stage, prints `STAGE_READY {json}` and then
  WAITS for `DONE` on stdin), 3. the driver re-validates READY against its OWN trusted config and runs
  `stage-smoke.py run` (qa-cli) as a child, 4. `DONE` to ssh, the odroid tears the stage down, 5. the
  final `STAGE_QA_RESULT ...` line goes to stdout and the exit code is the verdict.

Trust: the case list arrives from the odroid but originates in the PR, so it is DATA that is validated
here again (username, sha, floor of cases, required scenarios); nothing PR-controlled is ever executed.
The config is written by the installer, never taken from a PR. The token travels only through the ssh
child's stdin (never argv, env or output).

Streams: only the final STAGE_QA_RESULT line is written to stdout; everything forwarded (odroid output,
SMOKE lines, our own messages) goes to stderr.

Exit codes (same table as odroid-stage-qa.sh): 0 passed, 1 failed, 2 refused, 3 not provisioned,
4 stage infrastructure could not run (the odroid's docker load / compose up failed), 75 lock wait timed
out, 76 superseded; a signal exits 128+signal. A wrapper code this driver does not know is a failure.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import queue
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import NamedTuple

SCRIPT_DIR = Path(__file__).resolve().parent
SMOKE_SCRIPT = SCRIPT_DIR / "stage-smoke.py"

DEFAULT_CONFIG = "~/.config/hypercal-stage-qa/config.json"
LOCK_TAG = "hcb-stage-qa-pc"
LOCK_POLL_SECONDS = 0.2
LOCK_LOG_EVERY_SECONDS = 30
# The odroid waits up to 3000 s for the stage lock and 2400 s for the host deploy lock before it
# prints READY, so READY gets more than their sum.
DEFAULT_READY_TIMEOUT = 7200
DEFAULT_SMOKE_TIMEOUT = 1500
DEFAULT_DONE_TIMEOUT = 600
SMOKE_TERM_GRACE_SECONDS = 3

SHA_PATTERN = re.compile(r"[0-9a-f]{40}")
TOKEN_PATTERN = re.compile(r"[\x21-\x7e]{1,4096}")
USERNAME_PATTERN = re.compile(r"[A-Za-z][A-Za-z0-9_]{4,31}")
TARGET_PATTERN = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9_.:-]*")
PEER_PATTERN = re.compile(r"[0-9]{1,20}")
SMOKE_SUMMARY = re.compile(
    r"^STAGE_SMOKE_(PASSED|FAILED)\b.*?\bcases=([0-9]+)\b.*?\bfailed=([0-9]+)\b"
)

READY_PREFIX = "STAGE_READY "
RESULT_PREFIX = "STAGE_QA_RESULT"

EXIT_PASSED, EXIT_FAILED, EXIT_REFUSED, EXIT_NOT_PROVISIONED, EXIT_INFRA = 0, 1, 2, 3, 4
EXIT_LOCK_TIMEOUT, EXIT_SUPERSEDED = 75, 76
SMOKE_REFUSED, SMOKE_UNAVAILABLE = 64, 69
WRAPPER_CODES = (
    EXIT_FAILED,
    EXIT_REFUSED,
    EXIT_NOT_PROVISIONED,
    EXIT_INFRA,
    EXIT_LOCK_TIMEOUT,
    EXIT_SUPERSEDED,
)
STATUS_BY_CODE = {
    EXIT_PASSED: "passed",
    EXIT_REFUSED: "refused",
    EXIT_NOT_PROVISIONED: "not-provisioned",
    EXIT_INFRA: "infra-error",
    EXIT_LOCK_TIMEOUT: "lock-timeout",
    EXIT_SUPERSEDED: "superseded",
}

_log_lock = threading.Lock()


def log(message):
    with _log_lock:
        try:
            sys.stderr.write(message + "\n")
            sys.stderr.flush()
        except OSError:
            pass


def say(message):
    log(f"stage-qa-pc: {message}")


class Refused(Exception):
    pass


class NotProvisioned(Exception):
    pass


class LockTimeout(Exception):
    pass


class ReadyTimeout(Exception):
    pass


class Terminated(BaseException):
    """Raised by the signal handler; BaseException so no `except Exception` swallows a cancel."""

    def __init__(self, signum):
        super().__init__(signum)
        self.signum = signum


class SignalState:
    signum = None
    cleaning = False


def _on_signal(signum, _frame):
    first = SignalState.signum is None
    if first:
        SignalState.signum = signum
    # Once the cleanup (DONE, ssh wait, lock release) runs it must not be interrupted; a signal that
    # lands then is only remembered for the exit code.
    if first and not SignalState.cleaning:
        raise Terminated(signum)


def install_signal_handlers():
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, _on_signal)


class Verdict(NamedTuple):
    code: int
    cases: int = 0
    failed: int = 0
    # True: the code is the wrapper's own ssh exit status, known only after ssh has been reaped.
    from_wrapper: bool = False


def status_for(code):
    return STATUS_BY_CODE.get(code, "failed")


def wrapper_code(ssh_code):
    """The odroid wrapper's exit status as our verdict; 0 without a pass of ours is never a pass."""
    if ssh_code in WRAPPER_CODES:
        return ssh_code
    if ssh_code == 0:
        say("the odroid wrapper ended with 0 without a completed run; treating it as a failure")
    else:
        say(f"ssh ended with exit status {ssh_code}; treating it as a failure")
    return EXIT_FAILED


def print_result(sha, verdict):
    line = f"STAGE_QA_RESULT status={status_for(verdict.code)} sha={sha} cases={verdict.cases} failed={verdict.failed}"
    try:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()
    except OSError:
        pass


# ---------------------------------------------------------------- config


class Config(NamedTuple):
    ssh_target: str
    ssh_key: str
    ssh_known_hosts: str | None
    username: str
    deny_usernames: tuple
    qa_bin: str
    python: str
    lock_file: str
    lock_max_wait: float
    state_dir: str
    min_cases: int
    required_cases: tuple
    smoke_timeout: float
    ready_timeout: float
    done_timeout: float


DEFAULTS = {
    "deny_usernames": ["HyperCalendarBot"],
    "qa_bin": "~/.local/bin/qa",
    "python": "python3",
    "lock_file": "~/.local/state/hypercal-stage-qa/qa.lock",
    "lock_max_wait": 2700,
    "state_dir": "~/.local/state/hypercal-stage-qa",
    "min_cases": 5,
    "required_cases": [
        "start",
        "ping",
        "today-read-only-calendar",
        "simple-intent-phrase",
        "validation-search-without-query",
    ],
    "smoke_timeout": DEFAULT_SMOKE_TIMEOUT,
    "ready_timeout": DEFAULT_READY_TIMEOUT,
    "done_timeout": DEFAULT_DONE_TIMEOUT,
}
REQUIRED_KEYS = ("ssh_target", "ssh_key", "username")
OPTIONAL_KEYS = ("ssh_known_hosts",)


def normalized_username(name):
    return name.strip().lstrip("@").lower()


def has_stage_marker(username):
    lowered = username.lower()
    return "stage" in lowered or "stg" in lowered


def _bad(message):
    return NotProvisioned(f"config: {message}")


def _text(raw, key):
    value = raw[key]
    if type(value) is not str or not value:
        raise _bad(f"{key} must be a non-empty string")
    return value


def _path(raw, key):
    value = os.path.expanduser(_text(raw, key))
    if not os.path.isabs(value):
        raise _bad(f"{key} must be an absolute path (or start with ~)")
    return value


def _number(raw, key, minimum, allow_equal):
    value = raw[key]
    if type(value) not in (int, float) or value < minimum or (value == minimum and not allow_equal):
        bound = f">= {minimum}" if allow_equal else f"> {minimum}"
        raise _bad(f"{key} must be a number {bound}")
    return value


def _string_list(raw, key, allow_empty):
    value = raw[key]
    if type(value) is not list or not all(type(item) is str and item for item in value):
        raise _bad(f"{key} must be a list of non-empty strings")
    if not value and not allow_empty:
        raise _bad(f"{key} must not be empty")
    return tuple(value)


def _check_config_file(path):
    """The config must be a regular file owned by us with no group/world access."""
    try:
        info = os.stat(path)
    except FileNotFoundError:
        raise NotProvisioned(
            f"config {path} not found; run scripts/install-stage-qa-pc.sh"
        ) from None
    except OSError as error:
        raise NotProvisioned(f"config {path} is not readable: {error.strerror}") from None
    if not stat.S_ISREG(info.st_mode):
        raise _bad(f"{path} is not a regular file")
    if info.st_uid != os.geteuid():
        raise _bad(f"{path} is not owned by the current user")
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise _bad(f"{path} has mode {stat.S_IMODE(info.st_mode):04o}; it must be 0600")


def _read_config_values(path):
    """The file's JSON object with the optional keys defaulted; unknown or missing keys are refused."""
    try:
        with open(path, encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError) as error:
        raise _bad(f"{path} is not valid JSON ({error.__class__.__name__})") from None
    if type(raw) is not dict:
        raise _bad(f"{path} must hold a JSON object")
    unknown = sorted(set(raw) - set(DEFAULTS) - set(REQUIRED_KEYS) - set(OPTIONAL_KEYS))
    if unknown:
        raise _bad(f"unknown key(s): {', '.join(unknown)}")
    for key in REQUIRED_KEYS:
        if key not in raw:
            raise _bad(f"missing required key {key}")
    return {**DEFAULTS, **raw}


def _bot_username(merged):
    """The configured stage bot username: a Telegram bot name marked stage/stg."""
    username = _text(merged, "username")
    if not USERNAME_PATTERN.fullmatch(username) or not has_stage_marker(username):
        raise _bad("username must be a Telegram bot username containing stage or stg")
    return username


def load_config(path):
    path = os.path.expanduser(path)
    _check_config_file(path)
    merged = _read_config_values(path)

    target = _text(merged, "ssh_target")
    if not TARGET_PATTERN.fullmatch(target):
        raise _bad("ssh_target must look like user@host")
    username = _bot_username(merged)
    deny = _string_list(merged, "deny_usernames", allow_empty=True)
    if normalized_username(username) in {normalized_username(name) for name in deny}:
        raise _bad("username is in deny_usernames")
    min_cases = merged["min_cases"]
    if type(min_cases) is not int or min_cases < 1:
        raise _bad("min_cases must be an integer >= 1")
    known_hosts = _path(merged, "ssh_known_hosts") if "ssh_known_hosts" in merged else None

    return Config(
        ssh_target=target,
        ssh_key=_path(merged, "ssh_key"),
        ssh_known_hosts=known_hosts,
        username=username,
        deny_usernames=deny,
        qa_bin=_path(merged, "qa_bin"),
        python=_text(merged, "python"),
        lock_file=_path(merged, "lock_file"),
        lock_max_wait=_number(merged, "lock_max_wait", 0, True),
        state_dir=_path(merged, "state_dir"),
        min_cases=min_cases,
        required_cases=_string_list(merged, "required_cases", allow_empty=False),
        smoke_timeout=_number(merged, "smoke_timeout", 0, False),
        ready_timeout=_number(merged, "ready_timeout", 0, False),
        done_timeout=_number(merged, "done_timeout", 0, False),
    )


def check_provisioned(config):
    """Everything the run needs on this PC; returns the resolved ssh client and python."""
    if not os.path.isfile(config.ssh_key):
        raise NotProvisioned(
            f"ssh key {config.ssh_key} not found; run scripts/install-stage-qa-pc.sh"
        )
    if config.ssh_known_hosts and not os.path.isfile(config.ssh_known_hosts):
        raise NotProvisioned(f"ssh known_hosts file {config.ssh_known_hosts} not found")
    if not (os.path.isfile(config.qa_bin) and os.access(config.qa_bin, os.X_OK)):
        raise NotProvisioned(
            f"qa binary {config.qa_bin} not found or not executable (install qa-cli)"
        )
    ssh = shutil.which("ssh")
    if ssh is None:
        raise NotProvisioned("ssh client not found in PATH")
    python = shutil.which(config.python)
    if python is None:
        raise NotProvisioned(f"python {config.python} not found in PATH")
    if not SMOKE_SCRIPT.is_file():
        raise NotProvisioned(
            f"{SMOKE_SCRIPT} not found; reinstall with scripts/install-stage-qa-pc.sh"
        )
    return ssh, python


# ---------------------------------------------------------------- PC lock (same protocol as odroid-deploy-lock.sh)


def start_ticks(pid):
    """Process start time in clock ticks since boot (field 22 of /proc/<pid>/stat); None when gone."""
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8", errors="replace") as handle:
            stat_line = handle.read()
        # After the ")" that closes comm, field 3 is the first word; starttime is field 22 => 20th word.
        return stat_line.rsplit(") ", 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def describe_owner(owner_file):
    try:
        with open(owner_file, encoding="utf-8", errors="replace") as handle:
            lines = handle.read().splitlines()
    except OSError:
        return "unknown"
    fields = dict(line.split("=", 1) for line in lines if "=" in line)
    pid = fields.get("pid", "")
    if not pid.isdigit():
        return "unknown"
    live = start_ticks(pid)
    if live is not None and live == fields.get("start_ticks"):
        return f"{fields.get('repo', '?')} pid={pid} since={fields.get('started', '?')}"
    return f"stale ({fields.get('repo', '?')} pid={pid} is gone)"


class PcLock:
    """Advisory flock(2) on the shared qa lock plus an informational owner file.

    The kernel drops the flock when the holder dies, so a crash never leaves a stale lock; the owner
    file can go stale and is only used to explain a wait (judged by pid + start ticks)."""

    def __init__(self, path, max_wait):
        self.path = path
        self.owner_path = path + ".owner"
        self.max_wait = max_wait
        self.fd = None

    def acquire(self):
        directory = os.path.dirname(self.path)
        os.makedirs(directory, mode=0o700, exist_ok=True)
        # umask 0: the other driver (ESB) may run as another user and must still be able to open these
        # files whichever user created them first; the lock carries no secret.
        previous = os.umask(0)
        try:
            os.close(os.open(self.path, os.O_RDWR | os.O_CREAT, 0o666))
            os.close(os.open(self.owner_path, os.O_RDWR | os.O_CREAT, 0o666))
        finally:
            os.umask(previous)
        fd = os.open(self.path, os.O_RDONLY)
        started = time.monotonic()
        next_log = started
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                pass
            now = time.monotonic()
            waited = now - started
            if now >= next_log:
                say(
                    f"waiting for the PC qa lock, held by: {describe_owner(self.owner_path)} "
                    f"(waited {int(waited)}s of {int(self.max_wait)}s)"
                )
                next_log = now + LOCK_LOG_EVERY_SECONDS
            if waited >= self.max_wait:
                os.close(fd)
                say(
                    f"gave up after {int(waited)}s; the other QA run is still going. Re-run this check when it ends."
                )
                raise LockTimeout()
            time.sleep(min(LOCK_POLL_SECONDS, max(self.max_wait - waited, 0.01)))
        self.fd = fd
        waited = time.monotonic() - started
        if waited >= 1:
            say(f"acquired the PC qa lock after {int(waited)}s")
        # Truncate and rewrite in place: the owner file may belong to another user in a sticky dir.
        try:
            with open(self.owner_path, "w", encoding="utf-8") as handle:
                handle.write(
                    f"repo={LOCK_TAG}\npid={os.getpid()}\nstart_ticks={start_ticks(os.getpid())}\n"
                    f"started={time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n"
                )
        except OSError:
            pass

    def release(self):
        if self.fd is None:
            return
        try:
            with open(self.owner_path, "w", encoding="utf-8"):
                pass
        except OSError:
            pass
        os.close(self.fd)
        self.fd = None


# ---------------------------------------------------------------- READY validation


class Ready(NamedTuple):
    cases: list
    base_cases: int
    peer: str


def _ready_object(payload_text, sha):
    try:
        data = json.loads(payload_text)
    except ValueError:
        raise Refused("STAGE_READY is not valid JSON") from None
    if type(data) is not dict:
        raise Refused("STAGE_READY payload is not an object")
    if data.get("sha") != sha:
        raise Refused("STAGE_READY names another commit than the one requested")
    return data


def _check_ready_bot(username, config):
    if type(username) is not str or normalized_username(username) != normalized_username(
        config.username
    ):
        raise Refused("STAGE_READY names another bot than the configured stage bot")
    if normalized_username(username) in {
        normalized_username(name) for name in config.deny_usernames
    }:
        raise Refused("STAGE_READY names a denied (production) bot")
    if not has_stage_marker(username):
        raise Refused("STAGE_READY bot username does not contain stage or stg")


def _ready_cases(data):
    """The READY case list and its (unique) case names."""
    cases = data.get("cases")
    if type(cases) is not list or not cases:
        raise Refused("STAGE_READY carries no cases")
    names = []
    for case in cases:
        if type(case) is not dict or type(case.get("name")) is not str or not case["name"]:
            raise Refused("STAGE_READY has a case without a name")
        names.append(case["name"])
    if len(set(names)) != len(names):
        raise Refused("STAGE_READY has duplicate case names")
    return cases, names


def _ready_base_count(base, case_count, min_cases):
    if type(base) is not int or not 1 <= base <= case_count:
        raise Refused("STAGE_READY base_cases is not a valid count")
    # The floor is enforced here, not trusted from the odroid: extras (replay) never satisfy it.
    if base < min_cases:
        raise Refused(f"only {base} base cases; at least {min_cases} are required")
    return base


def validate_ready(payload_text, config, sha):
    data = _ready_object(payload_text, sha)
    _check_ready_bot(data.get("username"), config)
    peer = data.get("peer")
    if type(peer) is not str or not PEER_PATTERN.fullmatch(peer):
        raise Refused("STAGE_READY peer is not a numeric bot id")
    cases, names = _ready_cases(data)
    base = _ready_base_count(data.get("base_cases"), len(cases), config.min_cases)
    missing = [name for name in config.required_cases if name not in names[:base]]
    if missing:
        raise Refused(f"required base case(s) missing: {', '.join(missing)}")
    return Ready(cases=cases, base_cases=base, peer=peer)


# ---------------------------------------------------------------- ssh child (the odroid wrapper)


class SshSession:
    def __init__(self, argv):
        self.events = queue.Queue()
        self.result_line = None
        self.ready_seen = False
        self.gone = threading.Event()
        self.proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            # Own session: a ^C or group kill aimed at the driver must not cut ssh before DONE is sent.
            start_new_session=True,
        )
        self.threads = [
            threading.Thread(target=self._read_stdout, daemon=True),
            threading.Thread(target=self._read_stderr, daemon=True),
        ]
        for thread in self.threads:
            thread.start()

    def _read_stdout(self):
        try:
            for raw in self.proc.stdout:
                line = raw.rstrip("\r\n")
                if line.startswith(READY_PREFIX) and not self.ready_seen:
                    self.ready_seen = True
                    self.events.put(("ready", line[len(READY_PREFIX) :]))
                elif line.startswith(RESULT_PREFIX):
                    self.result_line = line
                    log(f"odroid: {line}")
                else:
                    log(line)
        finally:
            self.gone.set()
            self.events.put(("eof", None))

    def _read_stderr(self):
        for raw in self.proc.stderr:
            log(raw.rstrip("\r\n"))

    def write_line(self, text):
        try:
            self.proc.stdin.write(text + "\n")
            self.proc.stdin.flush()
        except (OSError, ValueError):
            pass

    def wait_ready(self, timeout):
        """The READY payload text, or None when ssh ended without one."""
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ReadyTimeout()
            try:
                kind, payload = self.events.get(timeout=min(remaining, 1.0))
            except queue.Empty:
                continue
            return payload if kind == "ready" else None

    def finish(self, done_timeout):
        """ALWAYS: DONE, close stdin, wait for ssh (kill after the deadline); returns its exit status."""
        self.write_line("DONE")
        try:
            self.proc.stdin.close()
        except (OSError, ValueError):
            pass
        try:
            code = self.proc.wait(timeout=done_timeout)
        except subprocess.TimeoutExpired:
            say(f"ssh did not finish within {int(done_timeout)}s after DONE; killing it")
            self.proc.kill()
            code = self.proc.wait()
        for thread in self.threads:
            thread.join(timeout=5)
        return code


def ssh_argv(config, ssh, sha):
    argv = [
        ssh,
        "-i",
        config.ssh_key,
        "-o",
        "BatchMode=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=4",
        "-o",
        "ConnectTimeout=30",
    ]
    if config.ssh_known_hosts:
        argv += ["-o", f"UserKnownHostsFile={config.ssh_known_hosts}"]
    # The forced command on the odroid reads the SHA from SSH_ORIGINAL_COMMAND.
    return [*argv, config.ssh_target, sha]


# ---------------------------------------------------------------- smoke child


class SmokeOutcome(NamedTuple):
    kind: str  # "exit" | "timeout" | "ssh-gone"
    code: int = 0
    summary: tuple | None = None  # (status, cases, failed) of the last STAGE_SMOKE_* line


def kill_group(proc):
    """TERM the whole process group, then KILL what is left (qa/agent-browser grandchildren)."""
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=SMOKE_TERM_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    proc.wait()


def smoke_command(config, python, sha, ready, cases_file):
    command = [
        python,
        str(SMOKE_SCRIPT),
        "run",
        "--cases-json",
        cases_file,
        "--username",
        config.username,
        "--peer",
        ready.peer,
        "--sha",
        sha,
    ]
    for name in config.deny_usernames:
        command += ["--deny", name]
    return [
        *command,
        "--receipt",
        os.path.join(config.state_dir, "receipts", f"{sha}.json"),
        "--qa-bin",
        config.qa_bin,
        "--min-cases",
        str(config.min_cases),
        "--base-cases",
        str(ready.base_cases),
    ]


def run_smoke(config, python, sha, ready, ssh_gone):
    receipts = os.path.join(config.state_dir, "receipts")
    os.makedirs(receipts, mode=0o700, exist_ok=True)
    # mkstemp creates the file 0600; the cases are PR data but there is no reason to expose them.
    handle, cases_file = tempfile.mkstemp(
        prefix=f"cases-{sha[:12]}-", suffix=".json", dir=config.state_dir
    )
    proc = None
    summary = [None]
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(ready.cases, stream)
        proc = subprocess.Popen(
            smoke_command(config, python, sha, ready, cases_file),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            start_new_session=True,
        )

        def forward():
            for raw in proc.stdout:
                line = raw.rstrip("\r\n")
                log(line)
                match = SMOKE_SUMMARY.match(line)
                if match:
                    summary[0] = (match.group(1), int(match.group(2)), int(match.group(3)))

        reader = threading.Thread(target=forward, daemon=True)
        reader.start()
        deadline = time.monotonic() + config.smoke_timeout
        outcome = None
        while outcome is None:
            try:
                code = proc.wait(timeout=0.2)
                outcome = "exit"
            except subprocess.TimeoutExpired:
                if ssh_gone.is_set():
                    say("the odroid wrapper ended while the smoke was running; stopping the smoke")
                    kill_group(proc)
                    outcome, code = "ssh-gone", 0
                elif time.monotonic() >= deadline:
                    say(
                        f"the smoke timed out after {int(config.smoke_timeout)}s; killing its process group"
                    )
                    kill_group(proc)
                    outcome, code = "timeout", 0
        reader.join(timeout=5)
        return SmokeOutcome(outcome, code, summary[0])
    finally:
        if proc is not None and proc.poll() is None:
            kill_group(proc)
        try:
            os.unlink(cases_file)
        except OSError:
            pass


def smoke_verdict(config, outcome):
    """exit 0 -> 0 (only with a real pass summary), 1 -> 1, 64 -> 2, 69 -> 3, anything else -> 1."""
    cases, failed = (outcome.summary[1], outcome.summary[2]) if outcome.summary else (0, 0)
    if outcome.code == 0:
        passed = (
            outcome.summary is not None
            and outcome.summary[0] == "PASSED"
            and failed == 0
            and cases >= config.min_cases
        )
        if passed:
            return Verdict(EXIT_PASSED, cases, failed)
        say(
            "the smoke exited 0 without a pass summary covering the required cases; treating it as a failure"
        )
        return Verdict(EXIT_FAILED, cases, failed)
    if outcome.code == SMOKE_REFUSED:
        return Verdict(EXIT_REFUSED, cases, failed)
    if outcome.code == SMOKE_UNAVAILABLE:
        say("qa-cli is unavailable or not logged in on this PC")
        return Verdict(EXIT_NOT_PROVISIONED, cases, failed)
    return Verdict(EXIT_FAILED, cases, failed)


# ---------------------------------------------------------------- the run


def drive(config, python, sha, token, session):
    session.write_line(token)
    try:
        payload = session.wait_ready(config.ready_timeout)
    except ReadyTimeout:
        say(f"no STAGE_READY within {int(config.ready_timeout)}s; giving up")
        return Verdict(EXIT_FAILED)
    if payload is None:
        say("the odroid wrapper ended before STAGE_READY")
        return Verdict(EXIT_FAILED, from_wrapper=True)
    try:
        ready = validate_ready(payload, config, sha)
    except Refused as error:
        say(f"refusing the odroid's READY: {error}")
        return Verdict(EXIT_REFUSED)
    outcome = run_smoke(config, python, sha, ready, session.gone)
    if outcome.kind == "timeout":
        return Verdict(EXIT_FAILED)
    if outcome.kind == "ssh-gone":
        return Verdict(EXIT_FAILED, from_wrapper=True)
    return smoke_verdict(config, outcome)


def run_session(config, ssh, python, sha, token):
    session = SshSession(ssh_argv(config, ssh, sha))
    verdict = Verdict(EXIT_FAILED)
    ssh_code = None
    try:
        verdict = drive(config, python, sha, token, session)
    finally:
        SignalState.cleaning = True
        ssh_code = session.finish(config.done_timeout)
    if session.ready_seen and ssh_code != 0:
        say(
            f"odroid teardown reported exit status {ssh_code}; see the odroid output above "
            f"(not a verdict of this run)"
        )
    if verdict.from_wrapper:
        return Verdict(wrapper_code(ssh_code), verdict.cases, verdict.failed)
    return verdict


def read_token():
    token = sys.stdin.readline(4098).rstrip("\n")
    if not TOKEN_PATTERN.fullmatch(token):
        raise Refused("the token (first stdin line) is missing or malformed")
    return token


def execute(sha, config_path):
    token = read_token()
    config = load_config(config_path)
    ssh, python = check_provisioned(config)
    os.makedirs(config.state_dir, mode=0o700, exist_ok=True)
    lock = PcLock(config.lock_file, config.lock_max_wait)
    lock.acquire()
    try:
        return run_session(config, ssh, python, sha, token)
    finally:
        SignalState.cleaning = True
        lock.release()


class Parser(argparse.ArgumentParser):
    def error(self, message):
        log(f"stage-qa-pc: {message}")
        print_result("-", Verdict(EXIT_REFUSED))
        sys.exit(EXIT_REFUSED)


def main(argv):
    parser = Parser(
        prog="stage-qa-pc.py", description="Run the per-PR stage QA from this PC (token on stdin)."
    )
    parser.add_argument("sha", help="the 40-hex commit to check")
    parser.add_argument(
        "--config", default=DEFAULT_CONFIG, help="driver config (default %(default)s)"
    )
    args = parser.parse_args(argv)
    if not SHA_PATTERN.fullmatch(args.sha):
        say("the argument must be a 40-hex commit SHA")
        print_result("-", Verdict(EXIT_REFUSED))
        return EXIT_REFUSED
    install_signal_handlers()
    try:
        verdict = execute(args.sha, args.config)
    except Refused as error:
        say(str(error))
        verdict = Verdict(EXIT_REFUSED)
    except NotProvisioned as error:
        log(f"STAGE_QA_NOT_PROVISIONED: {error}")
        verdict = Verdict(EXIT_NOT_PROVISIONED)
    except LockTimeout:
        verdict = Verdict(EXIT_LOCK_TIMEOUT)
    except Terminated as signalled:
        say(f"terminated by signal {signalled.signum}")
        verdict = Verdict(128 + signalled.signum)
    if SignalState.signum is not None:
        verdict = Verdict(128 + SignalState.signum, verdict.cases, verdict.failed)
    print_result(args.sha, verdict)
    return verdict.code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
