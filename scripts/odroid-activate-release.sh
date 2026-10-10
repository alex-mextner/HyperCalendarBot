#!/usr/bin/env bash
# Root side of the hosted deploy on the odroid (#784). The self-hosted runner user
# `hcb-runner` is not in the docker group and has no general sudo; sudoers lets it run
# only this file, installed by hand as root:root 0755 at
# /usr/local/sbin/hypercal-activate-release.
#
# Trust model: root trusts nothing the runner hands it except a commit SHA and a
# short-lived GitHub token, and the token only authenticates API calls. Root itself
# checks that main still points at the SHA, finds the one `release-<sha>` artifact
# uploaded by a push-to-main run of .github/workflows/deploy.yml in this repository,
# downloads it (the token is not sent to the blob-storage redirect), checks it against
# the artifact digest GitHub recorded at upload, extracts only the known release files
# into a fresh root-owned stage, and runs the staged scripts/deploy-prebuilt-image.sh.
# Code running as hcb-runner can therefore at most redeploy the current main release.
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

fail() { echo "hypercal-activate-release: $*" >&2; exit 2; }

(( $# == 1 )) || fail 'usage: printf "%s\n" "$GITHUB_TOKEN" | hypercal-activate-release <sha40>'
SHA="$1"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'revision must be a full 40-character lowercase commit SHA'

# The activator's own guard accepts a stage only as $DEPLOY_PATH/.incoming-<sha>-<n>-<n>.
STAGE="$DEPLOY_PATH/.incoming-$SHA-$(date +%s)-$$"
mkdir -m 0700 "$STAGE"
trap 'rm -rf "$STAGE"' EXIT

# The Python program comes in on fd 3 so that stdin stays the token pipe.
RESULT="$(python3 /dev/fd/3 "$API" "$REPO" "$WORKFLOW_PATH" "$IMAGE" "$SHA" "$STAGE" 3<<'PY'
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile

API, REPO, WORKFLOW_PATH, IMAGE, SHA, STAGE = sys.argv[1:]
MAX_ARTIFACT_BYTES = 4 * 1024**3
MAX_JSON_BYTES = 8 * 1024 * 1024
MAX_ARTIFACT_PAGES = 10
MAX_REDIRECTS = 3
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
    return urllib.request.Request(url, headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
    })


def api(token, path):
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
    if not isinstance(payload, dict):
        refuse(f"GitHub API {shown} answer is not an object")
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


def release_artifact(token):
    """The one unexpired release-<sha> artifact from a push-to-main run of the deploy workflow."""
    name = "release-" + SHA
    listed = []
    for page in range(1, MAX_ARTIFACT_PAGES + 1):
        query = urllib.parse.urlencode({"name": name, "per_page": 100, "page": page})
        payload = api(token, f"/repos/{REPO}/actions/artifacts?{query}")
        total, artifacts = payload.get("total_count"), payload.get("artifacts")
        # `type(...) is int`, not isinstance: a JSON true/false would otherwise pass as 1/0.
        if type(total) is not int or not isinstance(artifacts, list):
            refuse("invalid artifact list")
        listed += artifacts
        if len(listed) >= total or not artifacts:
            break
    else:
        refuse(f"too many artifacts named {name}")
    matches = []
    for artifact in listed:
        if not isinstance(artifact, dict) or artifact.get("name") != name or artifact.get("expired") is not False:
            continue
        run = artifact.get("workflow_run")
        if not isinstance(run, dict) or run.get("head_sha") != SHA:
            continue
        run_id = run.get("id")
        if type(run_id) is not int or run_id <= 0:
            continue
        details = api(token, f"/repos/{REPO}/actions/runs/{run_id}")
        if (
            details.get("event") == "push"
            and details.get("head_branch") == "main"
            and details.get("head_sha") == SHA
            and details.get("path") == WORKFLOW_PATH
            and same_repository(details.get("repository"))
            and same_repository(details.get("head_repository"))
        ):
            matches.append(artifact)
    if not matches:
        refuse(f"no {name} artifact from a push-to-main run of {WORKFLOW_PATH}")
    if len(matches) > 1:
        refuse(f"{len(matches)} {name} artifacts from push-to-main runs; refusing to choose")
    artifact = matches[0]
    artifact_id, size, digest = artifact.get("id"), artifact.get("size_in_bytes"), artifact.get("digest")
    if type(artifact_id) is not int or artifact_id <= 0:
        refuse("invalid artifact id")
    if type(size) is not int or not 0 < size <= MAX_ARTIFACT_BYTES:
        refuse("artifact size is missing or above 4 GiB")
    if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        refuse("artifact has no sha256 digest")
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
                view = view[os.write(fd, view):]
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
            location = error.headers.get("Location") if error.code in (301, 302, 303, 307, 308) else None
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


token = read_token()
main_still_targets_release(token)
artifact_id, expected_digest = release_artifact(token)
zip_path = os.path.join(STAGE, "release.zip")
download(token, artifact_id, expected_digest, zip_path)
del token
sums = extract_known_files(zip_path)
os.unlink(zip_path)
archive_sum = sums["image.tar.gz"]
print(archive_sum, release_config_digest(archive_sum))
PY
)"
read -r ARCHIVE_SUM CONFIG_ID <<<"$RESULT"
[[ "$ARCHIVE_SUM" =~ ^[0-9a-f]{64}$ && "$CONFIG_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'release identity was not computed'

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
