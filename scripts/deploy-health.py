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
from pathlib import Path
import re
import subprocess
import sys
import time

READY_OK = ("ok", "ok (unverified)")


def sanitize(text):
    return re.sub(r"[^A-Za-z0-9 ()._:-]", "?", text.strip())[:80] or "<none>"


def sh(cmd, timeout=30):
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, errors="replace")
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
        done = subprocess.run(["docker", "inspect", "--format", "{{json .State}}|{{.RestartCount}}", name],
                              capture_output=True, text=True, timeout=30, errors="replace")
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
            if line.startswith("some"):
                if float(re.search(r"avg10=([0-9.]+)", line).group(1)) >= io_threshold:
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
    print(f"RESULT verdict={verdict} health={sanitize(health)} ready={sanitize(ready)} elapsed={elapsed}s reason={reason}")
    return code


def wait(args):
    base = args.url.rstrip("/")
    started = time.monotonic()
    state, baseline_restarts = container_state(args.container)
    if not isinstance(state, dict):
        baseline_restarts = 0
    # /ready is waived only when it was KNOWINGLY worse before the deploy (an answered 5xx such as "ai
    # chain down"). An empty baseline means the probe itself failed, which proves nothing: require it.
    waived = bool(args.baseline_ready) and args.baseline_ready not in READY_OK
    ready_required = args.mode != "health" and not waived
    if args.mode != "health" and waived:
        print(f"HEALTH ready not required: it was '{sanitize(args.baseline_ready)}' before this deploy")
    unknown_streak = 0
    health = ready = ""
    last_marker = None
    last_code_shape = None
    last_progress = started
    ok_since = None
    last_report = 0.0
    seen_restarts = baseline_restarts
    started_at = ""
    while True:
        now = time.monotonic()
        elapsed = now - started
        state, restarts = container_state(args.container)
        if state is MISSING:
            return result(3, "dead", health, ready, "container does not exist", started)
        if state is UNKNOWN:
            # The Docker daemon or API hiccuped: that says nothing about the container. Keep polling;
            # only a persistent failure to read it is a verdict.
            unknown_streak += 1
            if unknown_streak >= UNKNOWN_LIMIT:
                return result(4, "unhealthy", health, ready, f"docker inspect failed {unknown_streak} times in a row", started)
            time.sleep(args.poll)
            continue
        unknown_streak = 0
        started_at = state.get("StartedAt", started_at)
        if state.get("OOMKilled"):
            return result(3, "dead", health, ready, "container was OOM-killed", started)
        if state.get("Restarting") or (restarts - baseline_restarts) >= 2:
            return result(3, "dead", health, ready, f"crash loop (restart count {baseline_restarts}->{restarts})", started)
        if state and not state.get("Running"):
            return result(3, "dead", health, ready,
                          f"container is {state.get('Status', 'not running')} exit_code={state.get('ExitCode', '?')}", started)
        if restarts != seen_restarts:
            ok_since = None  # a single restart is not yet a loop, but it restarts the stability window
            seen_restarts = restarts

        health = probe(f"{base}/health")
        ready = probe(f"{base}/ready") if args.mode != "health" else ready
        marker = log_marker(args.container)
        shape = (bool(health), bool(ready), state.get("Health", {}).get("Status") if isinstance(state.get("Health"), dict) else None)
        if marker != last_marker or shape != last_code_shape:
            last_progress = now
        last_marker, last_code_shape = marker, shape

        healthy = health == "ok" and (not ready_required or ready in READY_OK)
        if healthy:
            ok_since = ok_since if ok_since is not None else now
            if now - ok_since >= args.stable:
                errors, fatal = fresh_error_counts(args.container, started_at)
                if fatal:
                    return result(3, "dead", health, ready, f"{fatal} fatal (level>=60) log lines since start", started)
                if errors > args.max_error_logs:
                    return result(4, "unhealthy", health, ready,
                                  f"{errors} level>=50 log lines since start (limit {args.max_error_logs})", started)
                note = f"{errors} level>=50 log lines since start" if errors else "no level>=50 log lines"
                return result(0, "ok", health, ready, f"stable for {args.stable}s, {note}", started)
        else:
            ok_since = None
            if elapsed >= args.base_budget:
                saturated = host_saturated(args.proc_dir, args.io_psi_threshold, args.load_factor)
                progressing = (now - last_progress) <= args.stall
                if elapsed >= args.hard_cap:
                    return result(4, "unhealthy", health, ready, f"hard cap {args.hard_cap}s reached", started)
                if not (saturated and progressing):
                    why = "host not saturated" if not saturated else f"no progress for {int(now - last_progress)}s"
                    return result(4, "unhealthy", health, ready,
                                  f"not healthy after {int(elapsed)}s of {args.base_budget}s budget ({why})", started)
                if elapsed - last_report >= 20 or last_report == 0:
                    print(f"HEALTH extended past the {args.base_budget}s budget at {int(elapsed)}s: host saturated, container alive and progressing")
                    last_report = elapsed
        if elapsed - last_report >= 20 and not healthy:
            print(f"HEALTH t={int(elapsed)}s health={sanitize(health)} ready={sanitize(ready)} restarts={restarts}")
            last_report = elapsed
        time.sleep(args.poll)


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
