#!/usr/bin/env bash
# Root side of the hosted deploy on the odroid (#784). The self-hosted runner user
# `hcb-runner` is not in the docker group and has no general sudo; sudoers lets it
# run only this file, installed by hand as root:root 0755 at
# /usr/local/sbin/hypercal-activate-release. Everything the runner passes is
# untrusted: the release directory is writable by that user, so only the known
# release files are copied, without following symlinks, into a fresh root-owned
# stage, and the activator only ever reads that copy.
#
# Usage: hypercal-activate-release <release-dir> <sha40> <archive-sha256> <sha256:config-digest>
set -euo pipefail
umask 077

# Fixed on purpose: no environment overrides (sudo resets the environment anyway).
readonly WORK_ROOT=/var/lib/hcb-runner/actions-runner/_work
readonly DEPLOY_PATH=/opt/hypercal
readonly IMAGE=ghcr.io/alex-mextner/hypercalendarbot
readonly SAFE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH="$SAFE_PATH"

fail() { echo "hypercal-activate-release: $*" >&2; exit 2; }

(( $# == 4 )) || fail 'usage: hypercal-activate-release <release-dir> <sha40> <archive-sha256> <sha256:config-digest>'
RELEASE="$1"
SHA="$2"
ARCHIVE_SUM="$3"
CONFIG_ID="$4"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'revision must be a full 40-character commit SHA'
[[ "$ARCHIVE_SUM" =~ ^[0-9a-f]{64}$ ]] || fail 'archive checksum must be 64 lowercase hex characters'
[[ "$CONFIG_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'config digest must be sha256:<64 lowercase hex>'
[[ "$RELEASE" =~ ^/[A-Za-z0-9._/-]+$ && "$RELEASE" == "$WORK_ROOT"/* ]] \
  || fail "release directory must be an absolute path under $WORK_ROOT"

# The activator's own guard accepts a hosted stage only as $DEPLOY_PATH/.incoming-<sha>-<n>-<n>.
STAGE="$DEPLOY_PATH/.incoming-$SHA-$(date +%s)-$$"
mkdir -m 0700 "$STAGE"
trap 'rm -rf "$STAGE"' EXIT

python3 - "$RELEASE" "$STAGE" <<'PYCOPY'
import errno
import os
import stat
import sys

release, stage = sys.argv[1], sys.argv[2]
REQUIRED = ("image.tar.gz", "docker-compose.yml", "Caddyfile")
OPTIONAL = ("artifact.json",)
SCRIPTS = (
    "backup-db.sh",
    "healthcheck-alert.sh",
    "prepare-runtime-dirs.sh",
    "release-artifact.py",
    "deploy-prebuilt-image.sh",
    "migration-gate.py",
)
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def refuse(message):
    raise SystemExit("hypercal-activate-release: " + message)


def open_release(path):
    """Open path one component at a time, so no component can be a symlink or `..`."""
    parts = path.split("/")[1:]
    if not parts or any(part in ("", ".", "..") for part in parts):
        refuse("release directory must be a normalized absolute path")
    fd = os.open("/", DIRECTORY)
    try:
        for part in parts:
            try:
                child = os.open(part, DIRECTORY, dir_fd=fd)
            except OSError as error:
                refuse(f"release directory is not a real directory ({os.strerror(error.errno)})")
            os.close(fd)
            fd = child
    except BaseException:
        os.close(fd)
        raise
    return fd


def copy(source_dir, name, target_dir, required):
    try:
        # O_NONBLOCK: a FIFO planted in place of a release file must not hang the deploy.
        source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source_dir)
    except FileNotFoundError:
        if required:
            refuse(f"release file missing: {name}")
        return
    except OSError as error:
        if error.errno == errno.ELOOP:
            refuse(f"release file is a symlink: {name}")
        raise
    try:
        if not stat.S_ISREG(os.fstat(source).st_mode):
            refuse(f"release file is not a regular file: {name}")
        os.set_blocking(source, True)
        target = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=target_dir)
        try:
            while chunk := os.read(source, 1024 * 1024):
                view = memoryview(chunk)
                while view:
                    view = view[os.write(target, view):]
        finally:
            os.close(target)
    finally:
        os.close(source)


release_fd = open_release(release)
stage_fd = os.open(stage, DIRECTORY)
try:
    try:
        scripts_fd = os.open("scripts", DIRECTORY, dir_fd=release_fd)
    except OSError as error:
        refuse(f"release scripts/ is not a real directory ({os.strerror(error.errno)})")
    os.mkdir("scripts", 0o700, dir_fd=stage_fd)
    staged_scripts_fd = os.open("scripts", DIRECTORY, dir_fd=stage_fd)
    for name in REQUIRED:
        copy(release_fd, name, stage_fd, True)
    for name in OPTIONAL:
        copy(release_fd, name, stage_fd, False)
    for name in SCRIPTS:
        copy(scripts_fd, name, staged_scripts_fd, True)
finally:
    os.close(release_fd)
    os.close(stage_fd)
PYCOPY

# The deploy shares the box with the live bots: run the activator (docker load, backup,
# checks) at low CPU and I/O priority. Containers are started by dockerd, so the bot
# itself is not deprioritized.
PRIORITY=(nice -n 10)
if command -v ionice >/dev/null 2>&1; then
  PRIORITY+=(ionice -c 2 -n 7)
fi
rc=0
env -i PATH="$SAFE_PATH" HOME=/root LANG=C.UTF-8 "${PRIORITY[@]}" \
  bash "$STAGE/scripts/deploy-prebuilt-image.sh" "$DEPLOY_PATH" "$STAGE" "$IMAGE" "$SHA" "$ARCHIVE_SUM" "$CONFIG_ID" \
  || rc=$?
rm -rf "$STAGE"
exit "$rc"
