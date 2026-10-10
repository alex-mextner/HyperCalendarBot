#!/usr/bin/env bash
# Root side of the hosted deploy on the odroid (#784). The self-hosted runner user
# `hcb-runner` is not in the docker group and has no general sudo; sudoers lets it run
# only this file, installed by hand as root:root 0755 at
# /usr/local/sbin/hypercal-activate-release.
#
# Trust model: root trusts nothing the runner hands it except a commit SHA and a
# short-lived GitHub token, and the token only authenticates API calls. Root itself
# checks that main still points at the SHA and reads the newest `release-artifact`
# commit status on it. Only the GitHub-hosted build job can post that status (the deploy
# job has no `statuses: write`), and it names the artifact id and digest that job
# uploaded. Root requires that artifact to be `release-<sha>` from the push-to-main run
# of .github/workflows/deploy.yml the status links to, downloads it (the token is not sent
# to the blob-storage redirect), checks the digest, extracts only the known release files
# into a fresh root-owned stage, and runs the staged scripts/deploy-prebuilt-image.sh.
# Code running as hcb-runner can therefore at most redeploy the release that main's
# GitHub-hosted build job recorded, even if it uploads more artifacts into the same run.
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
MAX_STATUS_PAGES = 10
STATUS_CONTEXT = "release-artifact"
STATUS_CREATOR = "github-actions[bot]"
STATUS_DESCRIPTION = re.compile(r"artifact ([1-9][0-9]*) (sha256:[0-9a-f]{64})")
RUN_URL = re.compile(r"https://github\.com/" + re.escape(REPO) + r"/actions/runs/([1-9][0-9]*)", re.IGNORECASE)
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


def api(token, path, shape=dict):
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
    if not isinstance(payload, shape):
        refuse(f"GitHub API {shown} answer is not a JSON {shape.__name__}")
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


def pinned_release(token):
    """(artifact id, digest, run id) recorded by the GitHub-hosted build job's commit status.

    The deploy job itself runs on the odroid runner, so anything there can upload more
    release-<sha> artifacts into the same trusted run. Only the build job, on a GitHub-hosted
    runner, holds `statuses: write`; the newest `release-artifact` status it posted names the
    one artifact to deploy.
    """
    for page in range(1, MAX_STATUS_PAGES + 1):
        query = urllib.parse.urlencode({"per_page": 100, "page": page})
        statuses = api(token, f"/repos/{REPO}/commits/{SHA}/statuses?{query}", shape=list)
        # Newest first, so the first release-artifact entry is the current one.
        status = next((s for s in statuses if isinstance(s, dict) and s.get("context") == STATUS_CONTEXT), None)
        if status is not None or not statuses:
            break
    else:
        refuse(f"no {STATUS_CONTEXT} status within the newest {MAX_STATUS_PAGES * 100} statuses on {SHA}")
    if status is None:
        refuse(f"no {STATUS_CONTEXT} commit status on {SHA}; the build job did not record a release")
    if status.get("state") != "success":
        refuse(f"{STATUS_CONTEXT} status is {status.get('state')!r}, not 'success'")
    creator = status.get("creator")
    if not isinstance(creator, dict) or creator.get("login") != STATUS_CREATOR:
        refuse(f"{STATUS_CONTEXT} status was not posted by {STATUS_CREATOR}")
    described = STATUS_DESCRIPTION.fullmatch(str(status.get("description")))
    if described is None:
        refuse(f"{STATUS_CONTEXT} status description is not 'artifact <id> sha256:<hex>'")
    run = RUN_URL.fullmatch(str(status.get("target_url")))
    if run is None:
        refuse(f"{STATUS_CONTEXT} status target is not a workflow run of {REPO}")
    return int(described[1]), described[2], int(run[1])


def release_artifact(token):
    """The pinned release-<sha> artifact, checked against the status and its push-to-main run."""
    artifact_id, digest, run_id = pinned_release(token)
    artifact = api(token, f"/repos/{REPO}/actions/artifacts/{artifact_id}")
    if type(artifact.get("id")) is not int or artifact["id"] != artifact_id or artifact.get("name") != "release-" + SHA:
        refuse(f"artifact {artifact_id} is not release-{SHA}")
    if artifact.get("expired") is not False:
        refuse(f"artifact {artifact_id} has expired")
    if artifact.get("digest") != digest:
        refuse(f"artifact {artifact_id} digest differs from the build job's status")
    size = artifact.get("size_in_bytes")
    # `type(...) is int`, not isinstance: a JSON true/false would otherwise pass as 1/0.
    if type(size) is not int or not 0 < size <= MAX_ARTIFACT_BYTES:
        refuse("artifact size is missing or above 4 GiB")
    workflow_run = artifact.get("workflow_run")
    if not isinstance(workflow_run, dict) or workflow_run.get("id") != run_id:
        refuse(f"artifact {artifact_id} was not uploaded by run {run_id} named in the build job's status")
    details = api(token, f"/repos/{REPO}/actions/runs/{run_id}")
    if not (
        details.get("id") == run_id
        and details.get("event") == "push"
        and details.get("head_branch") == "main"
        and details.get("head_sha") == SHA
        and details.get("path") == WORKFLOW_PATH
        and same_repository(details.get("repository"))
        and same_repository(details.get("head_repository"))
    ):
        refuse(f"run {run_id} is not a push-to-main run of {WORKFLOW_PATH} for {SHA}")
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
