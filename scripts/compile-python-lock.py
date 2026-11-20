"""Regenerate the universal lock with its actual project version in uv's header."""

import argparse
import shlex
import subprocess
from pathlib import Path

import tomllib

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--project-version", help="require the version recorded in a copied command"
    )
    parser.add_argument("--upgrade-package", action="append", default=[], metavar="NAME")
    args = parser.parse_args()
    with (ROOT / "pyproject.toml").open("rb") as stream:
        version = tomllib.load(stream)["project"]["version"]
    if args.project_version is not None and args.project_version != version:
        parser.error(f"requested project version {args.project_version!r} differs from {version!r}")
    recorded_command = shlex.join(
        ["python3", "scripts/compile-python-lock.py", "--project-version", version]
    )
    command = [
        "uv",
        "pip",
        "compile",
        "pyproject.toml",
        "--universal",
        "--generate-hashes",
        "--emit-index-url",
        "--no-strip-extras",
        "--output-file",
        "requirements.lock",
        "--custom-compile-command",
        recorded_command,
    ]
    for package in args.upgrade_package:
        command.extend(["--upgrade-package", package])
    return subprocess.run(command, cwd=ROOT, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
