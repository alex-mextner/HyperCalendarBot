#!/usr/bin/env python3
"""Install/uninstall the intent-learning worker as a macOS LaunchAgent.

  install-intent-worker.py --print-plist   print the plist, change nothing
  install-intent-worker.py --dry-run       verify script/config/python, print the plan, change nothing
  install-intent-worker.py                 verify, write the plist and (re)bootstrap the agent
  install-intent-worker.py --uninstall     boot out and remove this agent's plist only

The plist carries no secrets: ProgramArguments are the python interpreter, the worker
script and --config <private 0600 JSON>. The alert watcher agent is never touched.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import plistlib
import stat
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

LABEL = "ru.invntrm.hypercal-intent-worker"
PROTECTED_LABELS = frozenset({"ru.invntrm.hypercal-alert-watcher"})
LAUNCH_AGENTS = Path.home() / "Library/LaunchAgents"
SCRIPT = Path(__file__).resolve().with_name("intent-worker.py")
THROTTLE_SECONDS = 60

_spec = importlib.util.spec_from_file_location("intent_worker", SCRIPT)
worker = importlib.util.module_from_spec(_spec)
sys.modules.setdefault("intent_worker", worker)
_spec.loader.exec_module(worker)

Runner = Callable[[list[str]], int]


class InstallError(Exception):
    pass


def plist_path(agents_dir: Path = LAUNCH_AGENTS) -> Path:
    if LABEL in PROTECTED_LABELS:
        raise InstallError("refusing to manage a protected LaunchAgent label")
    return agents_dir / f"{LABEL}.plist"


def check_private_dir(path: Path) -> None:
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise InstallError(f"{path} must be a real directory owned by the current user")
    if stat.S_IMODE(info.st_mode) & 0o022:
        raise InstallError(f"{path} must not be writable by group/others")


def verify(config_path: Path, python: Path) -> worker.Config:
    if not SCRIPT.is_file():
        raise InstallError(f"worker script not found: {SCRIPT}")
    if not python.is_absolute() or not os.access(python, os.X_OK):
        raise InstallError("python must be an absolute path to an executable interpreter")
    if not config_path.is_absolute():
        raise InstallError("--config must be an absolute path")
    check_private_dir(config_path.parent)
    try:
        return worker.load_config(config_path)
    except worker.ConfigError as err:
        raise InstallError(f"config rejected: {err}") from None


def build_plist(cfg: worker.Config, config_path: Path, python: Path) -> bytes:
    log_file = str(cfg.state_dir / "worker.log")
    search_path = [str(cfg.claude_path.parent), "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    document = {
        "Label": LABEL,
        "ProgramArguments": [str(python), str(SCRIPT), "--config", str(config_path)],
        "EnvironmentVariables": {"PATH": ":".join(dict.fromkeys(search_path))},
        "WorkingDirectory": str(cfg.state_dir),
        "KeepAlive": True,
        "RunAtLoad": True,
        "ThrottleInterval": THROTTLE_SECONDS,
        "ProcessType": "Background",
        "Umask": 0o077,
        "StandardOutPath": log_file,
        "StandardErrorPath": log_file,
    }
    return plistlib.dumps(document, sort_keys=False)


def run_command(argv: list[str]) -> int:
    return subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, check=False).returncode


def domain() -> str:
    return f"gui/{os.getuid()}"


def install(cfg: worker.Config, plist: bytes, target: Path, runner: Runner) -> None:
    worker.ensure_private_dir(cfg.state_dir)
    target.parent.mkdir(parents=True, exist_ok=True)
    worker.write_private(target, plist)
    runner(["launchctl", "bootout", f"{domain()}/{LABEL}"])
    if runner(["launchctl", "bootstrap", domain(), str(target)]) != 0:
        raise InstallError(f"launchctl bootstrap failed for {target}")


def uninstall(target: Path, runner: Runner) -> None:
    runner(["launchctl", "bootout", f"{domain()}/{LABEL}"])
    if target.exists():
        target.unlink()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install the intent-learning worker LaunchAgent")
    parser.add_argument("--config", type=Path, default=worker.DEFAULT_CONFIG)
    parser.add_argument("--python", type=Path, default=Path(sys.executable))
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--print-plist", action="store_true")
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--uninstall", action="store_true")
    return parser.parse_args(argv)


def main(
    argv: list[str] | None = None, runner: Runner = run_command, agents_dir: Path = LAUNCH_AGENTS
) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        target = plist_path(agents_dir)
        if args.uninstall:
            uninstall(target, runner)
            print(f"uninstalled {LABEL}")
            return 0
        cfg = verify(args.config, args.python)
        plist = build_plist(cfg, args.config, args.python)
        if args.print_plist:
            sys.stdout.write(plist.decode("utf-8"))
            return 0
        if args.dry_run:
            print(
                f"ok: would write {target} and bootstrap {domain()}/{LABEL}; logs {cfg.state_dir}/worker.log"
            )
            return 0
        install(cfg, plist, target, runner)
        print(f"installed {LABEL}; logs {cfg.state_dir}/worker.log")
        return 0
    except InstallError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
