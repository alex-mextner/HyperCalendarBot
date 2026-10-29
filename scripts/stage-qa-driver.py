#!/usr/bin/env python3
"""Odroid driver of the per-PR stage QA (#840): `stage-qa-driver.py <sha40> [--config FILE]`, token on stdin line 1.

It is the whole body of the `Stage QA run` job (workflow stage-qa.yml), which runs on the stage QA runner of
the odroid. The runner user can run nothing as root except the stage wrapper, and nothing on the browser host
except one forced command; this driver ties the two together, in this order (the order is the point: the
wrapper's watchdog starts when the wrapper takes the host deploy lock, so no wait for the browser host's lock
may happen after it):

  1. open the ssh connection to the browser host (key whose authorized_keys entry is
     `restrict,command=".../stage-qa-browser"`; the SHA is the command line, stdin stays open). The browser half
     takes the browser lock FIRST and prints `STAGE_BROWSER_LOCKED`; until then nothing else runs, so a queued
     run costs the odroid nothing (no stage lock, no host deploy lock held while waiting);
  2. only then start the root wrapper (`sudo -n /usr/local/sbin/hypercal-stage-qa <sha>`): it verifies the SHA,
     the pull request and the build artifact itself, starts the stage instance next to production, prints
     `STAGE_READY {json}` and then WAITS for `DONE` on stdin;
  3. forward that READY payload to the browser host (first stdin line of the connection): there it is
     validated against that host's own config and driven through qa-cli (Telegram Web) in a headless Chromium;
  4. `DONE` to the wrapper: the stage is torn down, always (pass, fail, cancel, timeout, dropped connection);
  5. the last stdout line is `STAGE_QA_RESULT ...` and the exit code is the verdict.

Why the browser is not on this host: the odroid runs production with a few hundred MB of memory to spare,
and Telegram Web needs that much (runbook "Stage QA", "Why the browser runs on the server").

Trust: the config is root-installed (scripts/install-stage-qa.sh), never taken from a PR. The GitHub token goes
only to the wrapper's stdin (never argv, env or output) and never leaves this host: the browser host gets the
READY payload and nothing else.

Streams: only the final STAGE_QA_RESULT line is written to stdout; everything forwarded (wrapper output, the
browser host's output, our own messages) goes to stderr.

Exit codes (same table as odroid-stage-qa.sh): 0 passed, 1 failed, 2 refused, 3 not provisioned / could not
run, 4 stage infrastructure could not run (the wrapper's docker load / compose up failed), 75 a lock wait
timed out, 76 superseded; a signal exits 128+signal. A wrapper code this driver does not know is a failure.

Timeouts (config keys; the workflow's job limit must cover their sum, see stage-qa.yml): `lock_timeout` for the
browser lock (browser half waits at most 2700 s), `ready_timeout` for READY after that (the wrapper waits up to
3000 s for the stage lock and 2400 s for the host deploy lock), `browser_timeout` for the cases (smoke 1500 s),
`done_timeout` for the wrapper's teardown.
"""

from __future__ import annotations

import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from typing import NamedTuple

from stage_qa_common import (
    EXIT_FAILED,
    EXIT_INFRA,
    EXIT_LOCK_TIMEOUT,
    EXIT_NOT_PROVISIONED,
    EXIT_PASSED,
    EXIT_REFUSED,
    EXIT_SUPERSEDED,
    LOCKED_LINE,
    RESULT_PREFIX,
    NotProvisioned,
    Refused,
    SignalState,
    Verdict,
    bad,
    log,
    merge_config,
    number_value,
    path_value,
    read_config_file,
    run_cli,
    string_list_value,
    terminate_group,
    text_value,
)

DEFAULT_CONFIG = "/etc/hypercal-stage-qa/driver.json"
INSTALLER = "scripts/install-stage-qa.sh"
# The browser half waits up to 2700 s for its browser lock; the margin covers ssh connect and start-up.
DEFAULT_LOCK_TIMEOUT = 3000
# After the lock the wrapper waits up to 3000 s for the stage lock and 2400 s for the host deploy lock before it
# prints READY, so READY gets more than their sum.
DEFAULT_READY_TIMEOUT = 5700
# The cases run for at most 1500 s (the browser half's smoke_timeout).
DEFAULT_BROWSER_TIMEOUT = 1800
DEFAULT_DONE_TIMEOUT = 600
KILL_GRACE_SECONDS = 5
POLL_SECONDS = 0.2

TOKEN_PATTERN = re.compile(r"[\x21-\x7e]{1,4096}")
TARGET_PATTERN = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9_.:-]*")
RESULT_FIELDS = re.compile(
    rf"^{RESULT_PREFIX} status=(\S+) sha=(\S+) cases=([0-9]+) failed=([0-9]+)$"
)

READY_PREFIX = "STAGE_READY "
# Exit statuses of the browser host's forced command that are verdicts; anything else (ssh's own 255,
# a signal, a crash of the command itself) means the QA could not run, which is not a verdict on the PR.
BROWSER_CODES = (EXIT_PASSED, EXIT_FAILED, EXIT_REFUSED, EXIT_NOT_PROVISIONED, EXIT_LOCK_TIMEOUT)
WRAPPER_CODES = (
    EXIT_FAILED,
    EXIT_REFUSED,
    EXIT_NOT_PROVISIONED,
    EXIT_INFRA,
    EXIT_LOCK_TIMEOUT,
    EXIT_SUPERSEDED,
)


def say(message):
    log(f"stage-qa-driver: {message}")


# ---------------------------------------------------------------- config


class Config(NamedTuple):
    wrapper: tuple
    browser_target: str
    browser_key: str
    browser_known_hosts: str | None
    lock_timeout: float
    ready_timeout: float
    browser_timeout: float
    done_timeout: float


DEFAULTS = {
    "wrapper": ["sudo", "-n", "/usr/local/sbin/hypercal-stage-qa"],
    "lock_timeout": DEFAULT_LOCK_TIMEOUT,
    "ready_timeout": DEFAULT_READY_TIMEOUT,
    "browser_timeout": DEFAULT_BROWSER_TIMEOUT,
    "done_timeout": DEFAULT_DONE_TIMEOUT,
}
REQUIRED_KEYS = ("browser_target", "browser_key")
OPTIONAL_KEYS = ("browser_known_hosts",)


def load_config(path):
    path = os.path.expanduser(path)
    merged = merge_config(
        read_config_file(path, INSTALLER, allow_root_owner=True),
        DEFAULTS,
        REQUIRED_KEYS,
        OPTIONAL_KEYS,
    )
    target = text_value(merged, "browser_target")
    if not TARGET_PATTERN.fullmatch(target):
        raise bad("browser_target must look like user@host")
    wrapper = string_list_value(merged, "wrapper", allow_empty=False)
    known_hosts = (
        path_value(merged, "browser_known_hosts") if "browser_known_hosts" in merged else None
    )
    return Config(
        wrapper=wrapper,
        browser_target=target,
        browser_key=path_value(merged, "browser_key"),
        browser_known_hosts=known_hosts,
        lock_timeout=number_value(merged, "lock_timeout", minimum=0, allow_equal=False),
        ready_timeout=number_value(merged, "ready_timeout", minimum=0, allow_equal=False),
        browser_timeout=number_value(merged, "browser_timeout", minimum=0, allow_equal=False),
        done_timeout=number_value(merged, "done_timeout", minimum=0, allow_equal=False),
    )


def check_provisioned(config):
    """Everything the run needs on this host; returns the resolved wrapper argv prefix and ssh client."""
    if not os.path.isfile(config.browser_key):
        raise NotProvisioned(
            f"ssh key {config.browser_key} not found; see the runbook, Stage QA install"
        )
    if config.browser_known_hosts and not os.path.isfile(config.browser_known_hosts):
        raise NotProvisioned(f"ssh known_hosts file {config.browser_known_hosts} not found")
    ssh = shutil.which("ssh")
    if ssh is None:
        raise NotProvisioned("ssh client not found in PATH")
    first = shutil.which(config.wrapper[0])
    if first is None:
        raise NotProvisioned(f"wrapper command {config.wrapper[0]} not found in PATH")
    wrapper = [first, *config.wrapper[1:]]
    if not os.path.isfile(wrapper[-1]):
        raise NotProvisioned(f"wrapper {wrapper[-1]} is not installed; run {INSTALLER} as root")
    return wrapper, ssh


# ---------------------------------------------------------------- children


class Child:
    """A subprocess whose stdout lines go to `on_line` and whose stderr goes to the log."""

    def __init__(self, argv, on_line):
        self.gone = threading.Event()
        self._on_line = on_line
        self.proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            # Own session: a ^C or group kill aimed at the driver must not cut the child before DONE is sent.
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
                self._on_line(raw.rstrip("\r\n"))
        finally:
            self.gone.set()
            self._on_line(None)

    def _read_stderr(self):
        for raw in self.proc.stderr:
            log(raw.rstrip("\r\n"))

    def write_line(self, text):
        try:
            self.proc.stdin.write(text + "\n")
            self.proc.stdin.flush()
        except (OSError, ValueError):
            pass

    def close_stdin(self):
        try:
            self.proc.stdin.close()
        except (OSError, ValueError):
            pass

    def wait(self, timeout, what):
        """The exit status; the child is killed when it outlives `timeout`."""
        try:
            code = self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            say(f"{what} did not finish within {int(timeout)}s; killing it")
            self.kill()
            code = self.proc.wait()
        for thread in self.threads:
            thread.join(timeout=5)
        return code

    def kill(self):
        terminate_group(self.proc, KILL_GRACE_SECONDS)


class WrapperSession:
    """The root wrapper: token in, STAGE_READY out, DONE ends it."""

    def __init__(self, argv):
        self.events = queue.Queue()
        self.ready_seen = False
        self.child = Child(argv, self._on_line)

    @property
    def gone(self):
        return self.child.gone

    def _on_line(self, line):
        if line is None:
            self.events.put(("eof", None))
        elif line.startswith(READY_PREFIX) and not self.ready_seen:
            self.ready_seen = True
            self.events.put(("ready", line[len(READY_PREFIX) :]))
        elif line.startswith(RESULT_PREFIX):
            log(f"wrapper: {line}")
        else:
            log(line)

    def write_line(self, text):
        self.child.write_line(text)

    def wait_ready(self, timeout, abort):
        """("ready", payload) | ("eof", None) the wrapper ended without one | ("timeout", None) | ("aborted", None) `abort()` is true."""
        deadline = time.monotonic() + timeout
        while True:
            try:
                kind, payload = self.events.get(timeout=POLL_SECONDS)
            except queue.Empty:
                if abort():
                    return "aborted", None
                if time.monotonic() >= deadline:
                    return "timeout", None
                continue
            return kind, payload

    def finish(self, done_timeout):
        """ALWAYS: DONE, close stdin, wait for the wrapper (kill after the deadline); returns its exit status."""
        self.write_line("DONE")
        self.child.close_stdin()
        return self.child.wait(done_timeout, "the wrapper")


class BrowserOutcome(NamedTuple):
    kind: str  # "exit" | "timeout" | "wrapper-gone"
    code: int = 0
    result: tuple | None = (
        None  # (status, sha, cases, failed) of the browser host's last STAGE_QA_RESULT line
    )


def browser_argv(config, ssh, sha):
    argv = [
        ssh,
        "-i",
        config.browser_key,
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
    if config.browser_known_hosts:
        argv += ["-o", f"UserKnownHostsFile={config.browser_known_hosts}"]
    # The forced command on the browser host reads the SHA from SSH_ORIGINAL_COMMAND.
    return [*argv, config.browser_target, sha]


class BrowserSession:
    """The ssh connection to the browser host's forced command: LOCKED line first, then (after the READY
    payload line) the cases and the result line. Its stdin stays open: the browser host treats its end as
    "the odroid side is gone" and stops (frees the lock, stops the cases)."""

    def __init__(self, argv):
        self.locked = threading.Event()
        self.result = None
        self._stopped = False
        self.child = Child(argv, self._on_line)

    def _on_line(self, line):
        if line is None:
            return
        match = RESULT_FIELDS.match(line)
        if line == LOCKED_LINE:
            self.locked.set()
            log(f"browser host: {line}")
        elif match:
            self.result = (match.group(1), match.group(2), int(match.group(3)), int(match.group(4)))
            log(f"browser host: {line}")
        else:
            log(line)

    @property
    def exited(self):
        return self.child.proc.poll() is not None

    def wait_locked(self, timeout):
        """ "locked" | "exit" the connection ended first | "timeout"."""
        deadline = time.monotonic() + timeout
        while True:
            if self.locked.wait(POLL_SECONDS):
                return "locked"
            if self.exited:
                # The LOCKED line may still be in the pipe when the process is already gone.
                self.child.gone.wait(KILL_GRACE_SECONDS)
                return "locked" if self.locked.is_set() else "exit"
            if time.monotonic() >= deadline:
                return "timeout"

    def send_payload(self, payload):
        self.child.write_line(payload)

    def wait_verdict(self, timeout, wrapper_gone):
        deadline = time.monotonic() + timeout
        while True:
            try:
                code = self.child.proc.wait(timeout=POLL_SECONDS)
                kind = "exit"
            except subprocess.TimeoutExpired:
                if wrapper_gone.is_set():
                    say(
                        "the wrapper ended while the browser host was running the cases; stopping them"
                    )
                    kind, code = "wrapper-gone", 0
                elif time.monotonic() >= deadline:
                    say(f"the browser host did not finish within {int(timeout)}s; stopping it")
                    kind, code = "timeout", 0
                else:
                    continue
            self.stop()
            return BrowserOutcome(kind, code, self.result)

    def exit_outcome(self):
        """The connection has ended: its exit status and last result line."""
        self.stop()
        return BrowserOutcome("exit", self.child.proc.returncode, self.result)

    def stop(self):
        """Close stdin (the browser half stops and frees its lock), kill what does not follow, join the readers
        (so the last result line is parsed before it is read). Idempotent."""
        if self._stopped:
            return
        self._stopped = True
        self.child.close_stdin()
        try:
            self.child.proc.wait(timeout=KILL_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            self.child.kill()
        self.child.wait(KILL_GRACE_SECONDS, "the browser host connection")


def browser_verdict(sha, outcome):
    """The browser host's exit status as our verdict. 0 without a pass result line is never a pass."""
    status, result_sha, cases, failed = outcome.result if outcome.result else (None, sha, 0, 0)
    code = outcome.code
    if result_sha != sha:
        say(
            f"the browser host answered for commit {result_sha}, not {sha}; the QA could not run (not a verdict on the PR)"
        )
        return Verdict(EXIT_NOT_PROVISIONED, cases, failed)
    if code == EXIT_PASSED:
        if status == "passed" and failed == 0 and cases >= 1:
            return Verdict(EXIT_PASSED, cases, failed)
        say(
            "the browser host exited 0 without a pass result covering at least one case; treating it as a failure"
        )
        return Verdict(EXIT_FAILED, cases, failed)
    if code in BROWSER_CODES:
        return Verdict(code, cases, failed)
    say(
        f"the browser host connection ended with exit status {code}; the QA could not run (not a verdict on the PR)"
    )
    return Verdict(EXIT_NOT_PROVISIONED, cases, failed)


def browser_ended_early(sha, browser, when):
    """The browser half ended before it was sent the payload: its exit status is the verdict, but never a pass."""
    say(f"the browser host ended {when}")
    outcome = browser.exit_outcome()
    if outcome.code == EXIT_PASSED:
        say("the browser host exited 0 before the cases ran; treating it as a failure")
        return Verdict(EXIT_FAILED)
    return browser_verdict(sha, outcome)


def wrapper_code(code):
    """The wrapper's exit status as our verdict; 0 without a completed run is never a pass."""
    if code in WRAPPER_CODES:
        return code
    if code == 0:
        say("the wrapper ended with 0 without a completed run; treating it as a failure")
    else:
        say(f"the wrapper ended with exit status {code}; treating it as a failure")
    return EXIT_FAILED


# ---------------------------------------------------------------- the run


def drive(config, sha, token, session, browser):
    """With the browser lock held: stage up (wrapper), READY to the browser host, its verdict."""
    session.write_line(token)
    kind, payload = session.wait_ready(config.ready_timeout, lambda: browser.exited)
    if kind == "timeout":
        say(f"no STAGE_READY within {int(config.ready_timeout)}s; giving up")
        return Verdict(EXIT_FAILED)
    if kind == "aborted":
        return browser_ended_early(sha, browser, "while the wrapper was starting the stage")
    if kind == "eof":
        say("the wrapper ended before STAGE_READY")
        return Verdict(EXIT_FAILED, from_child=True)
    browser.send_payload(payload)
    outcome = browser.wait_verdict(config.browser_timeout, session.gone)
    if outcome.kind == "timeout":
        return Verdict(EXIT_NOT_PROVISIONED)
    if outcome.kind == "wrapper-gone":
        return Verdict(EXIT_FAILED, from_child=True)
    return browser_verdict(sha, outcome)


def await_browser_lock(config, sha, browser):
    """None once the browser host holds its lock (the stage may start); otherwise the verdict of this run."""
    kind = browser.wait_locked(config.lock_timeout)
    if kind == "locked":
        return None
    if kind == "timeout":
        say(
            f"the browser host did not take its lock within {int(config.lock_timeout)}s; the QA could not run"
        )
        return Verdict(EXIT_NOT_PROVISIONED)
    return browser_ended_early(sha, browser, "before it took its lock")


def run_session(config, wrapper, ssh, sha, token):
    browser = BrowserSession(browser_argv(config, ssh, sha))
    session = None
    verdict = Verdict(EXIT_FAILED)
    code = None
    try:
        verdict = await_browser_lock(config, sha, browser)
        if verdict is None:
            session = WrapperSession([*wrapper, sha])
            verdict = drive(config, sha, token, session, browser)
    finally:
        SignalState.cleaning = True
        # The browser half first: it frees its lock when the connection closes, and the wrapper's teardown
        # then runs without anything else holding the run up.
        browser.stop()
        if session is not None:
            code = session.finish(config.done_timeout)
    if session is not None and session.ready_seen and code != 0:
        say(
            f"stage teardown reported exit status {code}; see the wrapper output above (not a verdict of this run)"
        )
    if verdict.from_child:
        return Verdict(wrapper_code(code), verdict.cases, verdict.failed)
    return verdict


def read_token():
    token = sys.stdin.readline(4098).rstrip("\n")
    if not TOKEN_PATTERN.fullmatch(token):
        raise Refused("the token (first stdin line) is missing or malformed")
    return token


def execute(sha, config_path):
    token = read_token()
    config = load_config(config_path)
    wrapper, ssh = check_provisioned(config)
    return run_session(config, wrapper, ssh, sha, token)


def main(argv):
    return run_cli(
        "stage-qa-driver.py",
        "Run the per-PR stage QA from the odroid (token on stdin).",
        DEFAULT_CONFIG,
        "driver config",
        argv,
        execute,
    )


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
