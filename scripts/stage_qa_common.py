"""Shared pieces of the two halves of the per-PR stage QA client (#840).

Imported (never run) by stage-qa-driver.py, which runs on the odroid as the QA runner's job, and by
stage-qa-browser.py, which runs on the QA browser host (the server, an ssh forced command). Both are
installed next to this file from a reviewed `main` checkout (scripts/install-stage-qa.sh and
scripts/install-stage-qa-browser.sh).

Contents: the exit-code table every stage QA component shares (same as odroid-stage-qa.sh), the
`STAGE_QA_RESULT` line, logging that keeps stdout clean, a signal handler that turns SIGTERM/SIGINT/SIGHUP
into an exception the cleanup can run after, and a strict loader for the JSON config files the installers
write (never taken from a pull request).
"""

import argparse
import json
import os
import re
import signal
import stat
import subprocess
import sys
import threading
from typing import NamedTuple

SHA_PATTERN = re.compile(r"[0-9a-f]{40}")
# Telegram bot usernames are 5-32 characters; the same bound as scripts/stage-smoke.py.
USERNAME_PATTERN = re.compile(r"[A-Za-z][A-Za-z0-9_]{4,31}")

EXIT_PASSED, EXIT_FAILED, EXIT_REFUSED, EXIT_NOT_PROVISIONED, EXIT_INFRA = 0, 1, 2, 3, 4
EXIT_LOCK_TIMEOUT, EXIT_SUPERSEDED = 75, 76
STATUS_BY_CODE = {
    EXIT_PASSED: "passed",
    EXIT_REFUSED: "refused",
    EXIT_NOT_PROVISIONED: "not-provisioned",
    EXIT_INFRA: "infra-error",
    EXIT_LOCK_TIMEOUT: "lock-timeout",
    EXIT_SUPERSEDED: "superseded",
}
RESULT_PREFIX = "STAGE_QA_RESULT"
# Printed by the browser half on stdout once it holds the browser lock: from then on the driver may start the stage.
LOCKED_LINE = "STAGE_BROWSER_LOCKED"

_log_lock = threading.Lock()


def log(message):
    with _log_lock:
        try:
            sys.stderr.write(message + "\n")
            sys.stderr.flush()
        except OSError:
            pass


class Refused(Exception):
    pass


class NotProvisioned(Exception):
    pass


class LockTimeout(Exception):
    pass


class ClientGone(Exception):
    """The peer on the other end of the connection closed it before the run started."""


class Verdict(NamedTuple):
    code: int
    cases: int = 0
    failed: int = 0
    # True: the code is a child's own exit status, known only after that child has been reaped.
    from_child: bool = False


def status_for(code):
    return STATUS_BY_CODE.get(code, "failed")


def result_line(sha, verdict):
    return f"{RESULT_PREFIX} status={status_for(verdict.code)} sha={sha} cases={verdict.cases} failed={verdict.failed}"


def print_result(sha, verdict):
    try:
        sys.stdout.write(result_line(sha, verdict) + "\n")
        sys.stdout.flush()
    except OSError:
        pass


# ---------------------------------------------------------------- signals


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
    # Once the cleanup (DONE, child waits, lock release) runs it must not be interrupted; a signal that
    # lands then is only remembered for the exit code.
    if first and not SignalState.cleaning:
        raise Terminated(signum)


def install_signal_handlers():
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, _on_signal)


def terminate_group(proc, grace):
    """TERM the child's whole process group, give it `grace` seconds, then KILL what is left and reap it."""
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    proc.wait()


def verdict_after_signal(verdict):
    if SignalState.signum is None:
        return verdict
    return Verdict(128 + SignalState.signum, verdict.cases, verdict.failed)


# ---------------------------------------------------------------- config files


def bad(message):
    return NotProvisioned(f"config: {message}")


def text_value(raw, key):
    value = raw[key]
    if type(value) is not str or not value:
        raise bad(f"{key} must be a non-empty string")
    return value


def path_value(raw, key):
    value = os.path.expanduser(text_value(raw, key))
    if not os.path.isabs(value):
        raise bad(f"{key} must be an absolute path (or start with ~)")
    return value


def number_value(raw, key, *, minimum, allow_equal):
    value = raw[key]
    if type(value) not in (int, float) or value < minimum or (value == minimum and not allow_equal):
        bound = f">= {minimum}" if allow_equal else f"> {minimum}"
        raise bad(f"{key} must be a number {bound}")
    return value


def string_list_value(raw, key, allow_empty):
    value = raw[key]
    if type(value) is not list or not all(type(item) is str and item for item in value):
        raise bad(f"{key} must be a list of non-empty strings")
    if not value and not allow_empty:
        raise bad(f"{key} must not be empty")
    return tuple(value)


def read_config_file(path, installer, allow_root_owner):
    """The JSON object in `path`, which must be a regular file nobody but its owner can write.

    `allow_root_owner`: the odroid driver's config is installed by root and read by the runner user, so
    it may be root-owned (and world-readable: it holds paths and a host name, no secret); the browser
    host's config belongs to the user the forced command runs as and no one else may even read it (0600
    or stricter). Either way a file anyone else could edit is refused, because it decides what is trusted."""
    try:
        info = os.stat(path)
    except FileNotFoundError:
        raise NotProvisioned(f"config {path} not found; run {installer}") from None
    except OSError as error:
        raise NotProvisioned(f"config {path} is not readable: {error.strerror}") from None
    if not stat.S_ISREG(info.st_mode):
        raise bad(f"{path} is not a regular file")
    owners = {os.geteuid(), 0} if allow_root_owner else {os.geteuid()}
    if info.st_uid not in owners:
        raise bad(
            f"{path} is not owned by {'root or ' if allow_root_owner else ''}the current user"
        )
    mode = stat.S_IMODE(info.st_mode)
    if allow_root_owner:
        if mode & 0o022:
            raise bad(f"{path} has mode {mode:04o}; group/other must not be able to write it")
    elif mode & 0o077:
        raise bad(f"{path} has mode {mode:04o}; group/other must have no access to it")
    try:
        with open(path, encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError) as error:
        raise bad(f"{path} is not valid JSON ({error.__class__.__name__})") from None
    if type(raw) is not dict:
        raise bad(f"{path} must hold a JSON object")
    return raw


def merge_config(raw, defaults, required, optional):
    unknown = sorted(set(raw) - set(defaults) - set(required) - set(optional))
    if unknown:
        raise bad(f"unknown key(s): {', '.join(unknown)}")
    for key in required:
        if key not in raw:
            raise bad(f"missing required key {key}")
    return {**defaults, **raw}


# ---------------------------------------------------------------- command line


class ResultParser(argparse.ArgumentParser):
    """A refused usage still ends with exactly one result line on stdout and the refused exit code."""

    def error(self, message):
        log(f"{self.prog}: {message}")
        print_result("-", Verdict(EXIT_REFUSED))
        sys.exit(EXIT_REFUSED)


def run_cli(
    prog, description, default_config, config_help, argv, execute, client_gone_message=None
):
    """Parse `<sha40> [--config FILE]`, run `execute(sha, config_path)` and turn every outcome into a result line.

    No -h/--help: the argument is the client's ssh command line (or a job's), and nothing but the result line
    (plus what the caller deliberately prints) may reach stdout. `client_gone_message`: when set, a ClientGone
    raised by `execute` is a failed run with that message."""
    parser = ResultParser(prog=prog, add_help=False, description=description)
    parser.add_argument("sha", help="the 40-hex commit to check")
    parser.add_argument(
        "--config", default=default_config, help=f"{config_help} (default %(default)s)"
    )
    args = parser.parse_args(argv)
    if not SHA_PATTERN.fullmatch(args.sha):
        log(f"{prog}: the argument must be a 40-hex commit SHA")
        print_result("-", Verdict(EXIT_REFUSED))
        return EXIT_REFUSED
    install_signal_handlers()
    try:
        verdict = execute(args.sha, args.config)
    except Refused as error:
        log(f"{prog}: {error}")
        verdict = Verdict(EXIT_REFUSED)
    except NotProvisioned as error:
        log(f"STAGE_QA_NOT_PROVISIONED: {error}")
        verdict = Verdict(EXIT_NOT_PROVISIONED)
    except LockTimeout:
        verdict = Verdict(EXIT_LOCK_TIMEOUT)
    except ClientGone:
        log(f"{prog}: {client_gone_message or 'the peer went away before the run started'}")
        verdict = Verdict(EXIT_FAILED)
    except Terminated as signalled:
        log(f"{prog}: terminated by signal {signalled.signum}")
        verdict = Verdict(128 + signalled.signum)
    verdict = verdict_after_signal(verdict)
    print_result(args.sha, verdict)
    return verdict.code
