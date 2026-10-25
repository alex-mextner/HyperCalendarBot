#!/usr/bin/env python3
"""Keep container logs and failure evidence on the host before a deploy recreates a container.

Why (#823, owner requirement 7): a rollback force-recreates the container, and `docker logs`
of the recreated-over container are gone with it. On 2026-10-24 that destroyed the only direct
evidence of why release 06a32c61 was rolled back. The activator therefore calls this before it
replaces or force-recreates anything:

  release-logs  copy the outgoing container's complete log to <logs-root>/release-<label>-<stamp>/
  failed        save a bounded, redacted evidence bundle of a release that did not come up to
                <logs-root>/failed-<sha12>-<stamp>/ and print `EVIDENCE_DIR=<path>`

Both are best effort by design: they never raise into the deploy (exit status is always 0 unless
the arguments are wrong), because losing evidence is bad but blocking a rollback is worse.
Directories are 0700 and files 0600: container logs hold chat traffic. The bundle's text files
are redacted (tokens, keys, passwords, message text fields); the raw gzip kept next to them is
the "never delete logs" copy and stays root-only. Retention is scripts/log-retention.py's job.
"""

import argparse
import datetime
import gzip
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading

TAIL_LINES = 400
TAIL_MAX_BYTES = 256 * 1024
INSPECT_KEEP = ("Id", "Created", "Image", "Name", "RestartCount", "State")
CONFIG_KEEP = ("Image", "Labels", "Healthcheck")
HOST_KEEP = ("RestartPolicy", "Memory", "NanoCpus", "LogConfig")

SECRET_PATTERNS = [
    # No \b before the digits: in a bot URL they follow the literal "bot" (".../bot123456789:TOKEN/...").
    (re.compile(r"(?<![0-9])\d{6,12}:[A-Za-z0-9_-]{30,}"), "[telegram-token]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"), "[jwt]"),
    (re.compile(r"\b(?:sk|pk|gh[pousr]|glpat|xox[abp])[-_][A-Za-z0-9_-]{16,}\b"), "[api-key]"),
    (re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}"), "Bearer [redacted]"),
    (re.compile(
        r"""(?i)(["']?(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|session[_-]?string)["']?\s*[:=]\s*)(["']?)[^\s"',}&]+"""
    ), r"\1\2[redacted]"),
    (re.compile(r"://([^/\s:@]*):[^/\s@]+@"), r"://\1:[redacted]@"),
]
# Message content must not be copied (ticket #823): blank the value of these JSON string fields.
CONTENT_FIELD = re.compile(
    r'("(?:text|caption|prompt|content|query|transcript|body|message_text|question|answer)"\s*:\s*)"(?:[^"\\]|\\.)*"'
)


def redact(text):
    text = CONTENT_FIELD.sub(r'\1"[redacted]"', text)
    for pattern, replacement in SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")


def make_dir(root, name):
    """Create <root>/<name>, or <name>-2, -3, ...: two attempts in one second must not share (and truncate) a directory."""
    Path(root).mkdir(mode=0o755, parents=True, exist_ok=True)
    for attempt in range(1, 1000):
        path = Path(root) / (name if attempt == 1 else f"{name}-{attempt}")
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            continue
        path.chmod(0o700)
        return path
    raise FileExistsError(f"no free evidence directory name under {root} for {name}")


def write_private(path, data):
    mode = "wb" if isinstance(data, bytes) else "w"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, mode) as handle:
        handle.write(data)


def run(cmd, timeout=60):
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, errors="replace")
    except (OSError, subprocess.TimeoutExpired) as error:
        return 1, "", f"{type(error).__name__}"
    return done.returncode, done.stdout, done.stderr


RAW_LOG_SECONDS = 120


def save_raw_log(container, target):
    """Stream `docker logs` (stdout+stderr, timestamped) through gzip; return bytes of the gz or None.

    Bounded in time: a stalled daemon or logging driver must not hold up the rollback that follows
    (what was copied by then is kept and flagged in a .note file).
    """
    try:
        with subprocess.Popen(
            ["docker", "logs", "--timestamps", container],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        ) as proc:
            expired = threading.Event()

            def stop():
                expired.set()
                proc.kill()

            timer = threading.Timer(RAW_LOG_SECONDS, stop)
            timer.start()
            try:
                fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=6) as out:
                    shutil.copyfileobj(proc.stdout, out, 1024 * 1024)
                code = proc.wait()
            finally:
                timer.cancel()
            if code != 0 or expired.is_set():
                note = Path(target).with_suffix(".note")
                why = f"stopped after {RAW_LOG_SECONDS}s" if expired.is_set() else f"docker logs exited {code}"
                write_private(note, f"{why}; the gz may be partial or empty\n")
        return os.path.getsize(target)
    except OSError as error:
        print(f"deploy-evidence: raw log not saved ({type(error).__name__})", file=sys.stderr)
        return None


def tail_redacted(gz_path):
    """Last TAIL_LINES lines, redacted, at most TAIL_MAX_BYTES, read back from the saved gzip."""
    lines = []
    try:
        with gzip.open(gz_path, "rt", errors="replace") as handle:
            for line in handle:
                lines.append(line)
                if len(lines) > TAIL_LINES:
                    lines.pop(0)
    except (OSError, EOFError):
        pass
    text = redact("".join(lines))
    return text[-TAIL_MAX_BYTES:]


def keep(source, wanted):
    return {key: source[key] for key in wanted if key in source}


def inspect_summary(container):
    code, out, _ = run(["docker", "inspect", container])
    if code != 0:
        return None
    try:
        data = json.loads(out)[0]
    except (ValueError, IndexError, TypeError):
        return None
    summary = keep(data, INSPECT_KEEP)
    # Config.Env holds every production secret; never copy it.
    summary["Config"] = keep(data.get("Config") or {}, CONFIG_KEEP)
    summary["HostConfig"] = keep(data.get("HostConfig") or {}, HOST_KEEP)
    return summary


def host_snapshot():
    parts = []
    for label, path in (("loadavg", "/proc/loadavg"), ("pressure/io", "/proc/pressure/io"),
                        ("pressure/memory", "/proc/pressure/memory"), ("pressure/cpu", "/proc/pressure/cpu")):
        try:
            parts.append(f"## {label}\n{Path(path).read_text()}")
        except OSError:
            parts.append(f"## {label}\n(unavailable)\n")
    for label, cmd in (("free -m", ["free", "-m"]), ("uptime", ["uptime"]), ("df -h /", ["df", "-h", "/"]),
                       ("docker ps", ["docker", "ps", "--format", "{{.Names}}\t{{.Status}}"]),
                       ("iostat/vmstat", ["vmstat", "1", "2"])):
        _, out, err = run(cmd, timeout=20)
        parts.append(f"## {label}\n{out or err}")
    return "\n".join(parts)


def state_line(summary, tail_text):
    state = (summary or {}).get("State") or {}
    health = (state.get("Health") or {}).get("Status", "none")
    errors = len(re.findall(r'"level"\s*:\s*(?:5\d|[6-9]\d)\b', tail_text))
    return (
        f"status={state.get('Status', '?')} exit_code={state.get('ExitCode', '?')} "
        f"oom_killed={state.get('OOMKilled', '?')} restarts={(summary or {}).get('RestartCount', '?')} "
        f"container_health={health} level50plus_in_tail={errors}"
    )


def cmd_release_logs(args):
    directory = make_dir(args.logs_root, f"release-{args.label}-{stamp()}")
    size = save_raw_log(args.container, directory / "container.log.gz")
    summary = inspect_summary(args.container)
    write_private(directory / "inspect.json", json.dumps(summary, indent=2, default=str) + "\n")
    print(f"RELEASE_LOGS dir={directory} bytes={size if size is not None else 'none'}")


def cmd_failed(args):
    directory = make_dir(args.logs_root, f"failed-{args.sha[:12]}-{stamp()}")
    size = save_raw_log(args.container, directory / "container.log.gz")
    summary = inspect_summary(args.container)
    write_private(directory / "inspect.json", json.dumps(summary, indent=2, default=str) + "\n")
    tail = tail_redacted(directory / "container.log.gz") if size is not None else ""
    write_private(directory / "container.tail.redacted.log", tail)
    write_private(directory / "state.txt", state_line(summary, tail) + "\n")
    if args.receipt and Path(args.receipt).is_file():
        try:
            write_private(directory / "receipt.json", redact(Path(args.receipt).read_text()))
        except OSError:
            pass
    write_private(directory / "host-load.txt", redact(host_snapshot()))
    print(f"EVIDENCE_DIR={directory}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    release = sub.add_parser("release-logs")
    release.add_argument("--container", required=True)
    release.add_argument("--logs-root", required=True)
    release.add_argument("--label", required=True, help="short revision or image id of the outgoing release")
    failed = sub.add_parser("failed")
    failed.add_argument("--container", required=True)
    failed.add_argument("--logs-root", required=True)
    failed.add_argument("--sha", required=True)
    failed.add_argument("--receipt", default="")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,80}", getattr(args, "label", None) or getattr(args, "sha", "") or "x"):
        parser.error("label/sha must be a short plain token")
    try:
        {"release-logs": cmd_release_logs, "failed": cmd_failed}[args.command](args)
    except Exception as error:  # evidence is best effort and must never block a rollback
        print(f"deploy-evidence: {args.command} failed ({type(error).__name__})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
