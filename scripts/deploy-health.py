#!/usr/bin/env python3
"""Decide whether a freshly started release is healthy, dead, or merely slow (#823).

The old activator polled /health 15 times (~163 s) and rolled back when the clock ran out. On
2026-10-24 the odroid was I/O saturated by an overlapping deploy (iowait 33-62 %), the release
needed longer than that, and a healthy release was rolled back into a 6-minute outage. A slow
start is not a failure; a dead or crash-looping instance is. The verdict therefore combines:

  container   running, not restarting, no OOM kill, restart count not climbing (crash loop = 2+)
  /health     must answer `ok`
  /ready      must be `ok` or `ok (unverified)`, unless it was already worse before the deploy
              (an AI-provider outage fails readiness for every image, so it is not this release's fault)
  stability   health stays ok, container stays up, for --stable seconds
  fresh logs  any pino fatal (level >= 60) since start fails; more than --max-error-logs
              level >= 50 lines in the window fails (an error storm); fewer are only reported
  budget      --base-budget seconds; past it the wait continues only while the host is saturated
              (PSI io or load) AND the container is alive AND made progress within --stall seconds,
              never past --hard-cap. Dead stays immediate: no waiting for a container that exited.

Output: progress lines, then one `RESULT verdict=<ok|dead|unhealthy> health=<body> ready=<body>
reason=<text>` line. Exit 0 ok, 3 dead, 4 unhealthy (alive, never became healthy within the cap).
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

READY_OK = ("ok", "ok (unverified)")


def sanitize(text):
    return re.sub(r"[^A-Za-z0-9 ()._:-]", "?", text.strip())[:80] or "<none>"


def sh(cmd, timeout=30):
    try:
        done = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, errors="replace", check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        return 1, ""
    return done.returncode, done.stdout


def probe(url):
    code, out = sh(["curl", "-fsS", "--max-time", "20", url], timeout=30)
    return out.strip() if code == 0 else ""


MISSING = "missing"
UNKNOWN = "unknown"
UNKNOWN_LIMIT = 5


def container_state(name):
    """(state dict, restart count); (MISSING, 0) when docker says there is no such container, (UNKNOWN, 0)
    for any other failure to read it (daemon unreachable, timeout, garbled answer)."""
    try:
        done = subprocess.run(
            ["docker", "inspect", "--format", "{{json .State}}|{{.RestartCount}}", name],
            capture_output=True,
            text=True,
            timeout=30,
            errors="replace",
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return UNKNOWN, 0
    if done.returncode != 0:
        return (MISSING if "No such" in done.stderr else UNKNOWN), 0
    try:
        state_json, restarts = done.stdout.strip().rsplit("|", 1)
        return json.loads(state_json), int(restarts)
    except ValueError:
        return UNKNOWN, 0


def log_marker(name):
    """Cheap progress signal: the newest log line (with its timestamp) changes while the app boots."""
    _, out = sh(["docker", "logs", "--timestamps", "--tail", "1", name], timeout=20)
    return out.strip()[-200:]


def fresh_error_counts(name, since):
    _, out = sh(["docker", "logs", "--since", since, name], timeout=60) if since else (0, "")
    fatal = errors = 0
    for line in out.splitlines():
        match = re.search(r'"level"\s*:\s*(\d+)', line)
        if match and int(match.group(1)) >= 50:
            errors += 1
            fatal += int(match.group(1)) >= 60
    return errors, fatal


def host_saturated(proc_dir, io_threshold, load_factor):
    """True while the host is I/O-bound or overloaded (the situation that made 06a32c61 slow)."""
    try:
        for line in (Path(proc_dir) / "pressure/io").read_text().splitlines():
            if (
                line.startswith("some")
                and float(re.search(r"avg10=([0-9.]+)", line).group(1)) >= io_threshold
            ):
                return True
    except (OSError, AttributeError, ValueError):
        pass
    try:
        load1 = float((Path(proc_dir) / "loadavg").read_text().split()[0])
        return load1 > load_factor * (os.cpu_count() or 1)
    except (OSError, ValueError, IndexError):
        return False


def result(code, verdict, health, ready, reason, started):
    elapsed = int(time.monotonic() - started)
    print(
        f"RESULT verdict={verdict} health={sanitize(health)} ready={sanitize(ready)} elapsed={elapsed}s reason={reason}"
    )
    return code


class HealthWait:
    """One `wait` run: the mutable poll state plus one method per phase of a poll.

    Every phase returns the process exit code once it reaches a verdict, or None to keep polling.
    """

    def __init__(self, args):
        self.args = args
        self.base = args.url.rstrip("/")
        self.started = time.monotonic()
        state, restarts = container_state(args.container)
        self.baseline_restarts = restarts if isinstance(state, dict) else 0
        self.ready_required = self._ready_required()
        self.unknown_streak = 0
        self.health = self.ready = ""
        self.last_marker = None
        self.last_code_shape = None
        self.last_progress = self.started
        self.ok_since = None
        self.last_report = 0.0
        self.seen_restarts = self.baseline_restarts
        self.started_at = ""

    def _ready_required(self):
        # /ready is waived only when it was KNOWINGLY worse before the deploy (an answered 5xx such as "ai
        # chain down"). An empty baseline means the probe itself failed, which proves nothing: require it.
        if self.args.mode == "health":
            return False
        baseline = self.args.baseline_ready
        if bool(baseline) and baseline not in READY_OK:
            print(f"HEALTH ready not required: it was '{sanitize(baseline)}' before this deploy")
            return False
        return True

    def finish(self, code, verdict, reason):
        return result(code, verdict, self.health, self.ready, reason, self.started)

    def run(self):
        while True:
            code = self.poll_once()
            if code is not None:
                return code
            time.sleep(self.args.poll)

    def poll_once(self):
        now = time.monotonic()
        elapsed = now - self.started
        state, restarts = container_state(self.args.container)
        if state is UNKNOWN:
            return self._unreadable_container()
        self.unknown_streak = 0
        code = self._container_verdict(state, restarts)
        if code is not None:
            return code
        if restarts != self.seen_restarts:
            self.ok_since = (
                None  # a single restart is not yet a loop, but it restarts the stability window
            )
            self.seen_restarts = restarts
        self._probe_endpoints(state, now)
        if self._is_healthy():
            return self._stable_verdict(now)
        self.ok_since = None
        if elapsed >= self.args.base_budget:
            code = self._past_budget_verdict(now, elapsed)
            if code is not None:
                return code
        self._report_progress(elapsed, restarts)
        return None

    def _unreadable_container(self):
        # The Docker daemon or API hiccuped: that says nothing about the container. Keep polling;
        # only a persistent failure to read it is a verdict.
        self.unknown_streak += 1
        if self.unknown_streak >= UNKNOWN_LIMIT:
            return self.finish(
                4, "unhealthy", f"docker inspect failed {self.unknown_streak} times in a row"
            )
        return None

    def _container_verdict(self, state, restarts):
        if state is MISSING:
            return self.finish(3, "dead", "container does not exist")
        self.started_at = state.get("StartedAt", self.started_at)
        if state.get("OOMKilled"):
            return self.finish(3, "dead", "container was OOM-killed")
        if state.get("Restarting") or (restarts - self.baseline_restarts) >= 2:
            return self.finish(
                3, "dead", f"crash loop (restart count {self.baseline_restarts}->{restarts})"
            )
        if state and not state.get("Running"):
            return self.finish(
                3,
                "dead",
                f"container is {state.get('Status', 'not running')} exit_code={state.get('ExitCode', '?')}",
            )
        return None

    def _probe_endpoints(self, state, now):
        self.health = probe(f"{self.base}/health")
        base = self.base
        self.ready = probe(f"{base}/ready") if self.args.mode != "health" else self.ready
        marker = log_marker(self.args.container)
        docker_health = (
            state.get("Health", {}).get("Status") if isinstance(state.get("Health"), dict) else None
        )
        shape = (bool(self.health), bool(self.ready), docker_health)
        if marker != self.last_marker or shape != self.last_code_shape:
            self.last_progress = now
        self.last_marker, self.last_code_shape = marker, shape

    def _is_healthy(self):
        return self.health == "ok" and (not self.ready_required or self.ready in READY_OK)

    def _stable_verdict(self, now):
        self.ok_since = self.ok_since if self.ok_since is not None else now
        if now - self.ok_since < self.args.stable:
            return None
        errors, fatal = fresh_error_counts(self.args.container, self.started_at)
        if fatal:
            return self.finish(3, "dead", f"{fatal} fatal (level>=60) log lines since start")
        if errors > self.args.max_error_logs:
            return self.finish(
                4,
                "unhealthy",
                f"{errors} level>=50 log lines since start (limit {self.args.max_error_logs})",
            )
        note = f"{errors} level>=50 log lines since start" if errors else "no level>=50 log lines"
        return self.finish(0, "ok", f"stable for {self.args.stable}s, {note}")

    def _past_budget_verdict(self, now, elapsed):
        """Not healthy and past --base-budget: fail, or announce the extension while the host justifies it."""
        args = self.args
        saturated = host_saturated(args.proc_dir, args.io_psi_threshold, args.load_factor)
        progressing = (now - self.last_progress) <= args.stall
        if elapsed >= args.hard_cap:
            return self.finish(4, "unhealthy", f"hard cap {args.hard_cap}s reached")
        if not (saturated and progressing):
            why = (
                "host not saturated"
                if not saturated
                else f"no progress for {int(now - self.last_progress)}s"
            )
            return self.finish(
                4,
                "unhealthy",
                f"not healthy after {int(elapsed)}s of {args.base_budget}s budget ({why})",
            )
        if elapsed - self.last_report >= 20 or self.last_report == 0:
            print(
                f"HEALTH extended past the {args.base_budget}s budget at {int(elapsed)}s: host saturated, container alive and progressing"
            )
            self.last_report = elapsed
        return None

    def _report_progress(self, elapsed, restarts):
        if elapsed - self.last_report >= 20:
            print(
                f"HEALTH t={int(elapsed)}s health={sanitize(self.health)} ready={sanitize(self.ready)} restarts={restarts}"
            )
            self.last_report = elapsed


def wait(args):
    return HealthWait(args).run()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=["wait"])
    parser.add_argument("--container", required=True)
    parser.add_argument("--url", required=True)
    parser.add_argument("--mode", choices=["ready", "health"], default="ready")
    parser.add_argument("--baseline-ready", default="ok", help="/ready body before this deploy")
    parser.add_argument("--base-budget", type=float, default=240.0)
    parser.add_argument("--hard-cap", type=float, default=900.0)
    parser.add_argument("--poll", type=float, default=4.0)
    parser.add_argument("--stable", type=float, default=15.0)
    parser.add_argument("--stall", type=float, default=120.0)
    parser.add_argument("--max-error-logs", type=int, default=5)
    parser.add_argument("--io-psi-threshold", type=float, default=20.0)
    parser.add_argument("--load-factor", type=float, default=1.5)
    parser.add_argument("--proc-dir", default="/proc")
    return wait(parser.parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
