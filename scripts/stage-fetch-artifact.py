#!/usr/bin/env python3
"""Verify and download the stage-build artifact of one PR head for the odroid stage QA (#840).

Runs as root from the hand-installed lib dir of /usr/local/sbin/hypercal-stage-qa. The PR is
untrusted data: this script trusts only the commit SHA the wrapper passes and a short-lived
GitHub token read from the first line of stdin (never argv or the environment). It finds the
`Stage build` run itself, requires that run to be a successful pull_request run of this
repository for exactly that SHA, downloads the one `stage-<sha>` artifact it uploaded (the token
is not sent to the blob-storage redirect), checks the digest, and extracts only the three fixed
member names. Member names never build paths.

  stage-fetch-artifact.py fetch   --api URL --repo R --sha S --out DIR
  stage-fetch-artifact.py current --api URL --repo R --sha S

Exit codes: 0 ok, 2 refused (one-line reason on stderr), 76 superseded (S is no longer the head
of an open, non-draft PR of R). `fetch` prints exactly one stdout line:
  STAGE_ARTIFACT archive_sha256=<hex> config_digest=<sha256:hex> image_bytes=<n> replay=<0|1>
"""

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import zlib

API = REPO = SHA = None
BUILD_WORKFLOW_PATH = ".github/workflows/stage-build.yml"
# The image is written to disk by write_new, which keeps the activator's 4 GiB cap; the
# artifact the build may declare is held to the tighter 2 GiB the odroid has room for.
MAX_ARTIFACT_BYTES = 4 * 1024**3
MAX_DECLARED_ARTIFACT_BYTES = 2 * 1024**3
MAX_CASES_BYTES = 8 * 1024 * 1024
MAX_JSON_BYTES = 8 * 1024 * 1024
MAX_REDIRECTS = 3
EXIT_SUPERSEDED = 76
REQUIRED = ("image.tar.gz", "stage-smoke-cases.json")
OPTIONAL = ("stage-smoke-cases.replay.json",)
USER_AGENT = "hypercal-stage-qa"


def refuse(message):
    print("hypercal-stage-fetch-artifact: " + message, file=sys.stderr)
    sys.exit(2)


def superseded(message):
    print("hypercal-stage-fetch-artifact: superseded: " + message, file=sys.stderr)
    sys.exit(EXIT_SUPERSEDED)


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
    return urllib.request.Request(
        url,
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": USER_AGENT,
        },
    )


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
                view = view[os.write(fd, view) :]
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
            location = (
                error.headers.get("Location") if error.code in (301, 302, 303, 307, 308) else None
            )
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


def require_current_head(token):
    """Refuse (76) unless SHA is the head of an open, non-draft PR whose head and base are both REPO."""
    pulls = api(token, f"/repos/{REPO}/commits/{SHA}/pulls?per_page=100", shape=list)
    for pull in pulls:
        if not isinstance(pull, dict):
            continue
        head, base = pull.get("head"), pull.get("base")
        if not (isinstance(head, dict) and isinstance(base, dict)):
            continue
        if (
            pull.get("state") == "open"
            and pull.get("draft") is False
            and head.get("sha") == SHA
            and same_repository(head.get("repo"))
            and same_repository(base.get("repo"))
        ):
            return
    superseded(f"{SHA} is not the head of an open, non-draft pull request of {REPO}")


def build_run(token):
    """Id of the newest successful Stage build pull_request run for SHA; the caller names none."""
    query = urllib.parse.urlencode(
        {"head_sha": SHA, "event": "pull_request", "status": "completed", "per_page": 20}
    )
    runs = api(token, f"/repos/{REPO}/actions/workflows/stage-build.yml/runs?{query}").get(
        "workflow_runs"
    )
    if not isinstance(runs, list):
        refuse("workflow runs answer has no workflow_runs list")
    candidates = [
        run
        for run in runs
        if isinstance(run, dict)
        # `type(...) is int`, not isinstance: a JSON true would otherwise pass as 1.
        and type(run.get("id")) is int
        and run.get("conclusion") == "success"
        and run.get("path") == BUILD_WORKFLOW_PATH
        and run.get("head_sha") == SHA
        and run.get("event") == "pull_request"
    ]
    if not candidates:
        refuse(f"no successful Stage build pull_request run of {BUILD_WORKFLOW_PATH} for {SHA}")
    # Newest wins; if it came from a fork the PR head is not code of this repository, so refuse
    # rather than fall back to an older run.
    run = max(candidates, key=lambda candidate: candidate["id"])
    if not (same_repository(run.get("repository")) and same_repository(run.get("head_repository"))):
        refuse(f"Stage build run {run['id']} is not a run of {REPO} itself (fork)")
    return run["id"]


def build_artifact(token, run_id):
    """The single stage-<sha> artifact uploaded by run_id: (id, digest)."""
    name = "stage-" + SHA
    listing = api(
        token,
        f"/repos/{REPO}/actions/runs/{run_id}/artifacts?" + urllib.parse.urlencode({"name": name}),
    )
    artifacts = listing.get("artifacts")
    if not isinstance(artifacts, list):
        refuse("artifact list answer has no artifacts list")
    named = [a for a in artifacts if isinstance(a, dict) and a.get("name") == name]
    if len(named) != 1:
        refuse(f"run {run_id} has {len(named)} artifacts named {name}, expected exactly one")
    artifact = named[0]
    artifact_id = artifact.get("id")
    if type(artifact_id) is not int:
        refuse(f"artifact {name} has no integer id")
    if artifact.get("expired") is not False:
        refuse(f"artifact {artifact_id} has expired")
    digest = artifact.get("digest")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", str(digest)):
        refuse(f"artifact {artifact_id} has no sha256 digest")
    size = artifact.get("size_in_bytes")
    if type(size) is not int or not 0 < size <= MAX_DECLARED_ARTIFACT_BYTES:
        refuse("artifact size is missing or above 2 GiB")
    workflow_run = artifact.get("workflow_run")
    if (
        not isinstance(workflow_run, dict)
        or workflow_run.get("id") != run_id
        or workflow_run.get("head_sha") != SHA
    ):
        refuse(f"artifact {artifact_id} was not uploaded by run {run_id} for {SHA}")
    return artifact_id, digest


def prepare_out(out):
    """OUT must be a fresh directory we own: created here, or an empty 0700 one the wrapper made."""
    if not os.path.lexists(out):
        os.mkdir(out, 0o700)
        return
    info = os.lstat(out)
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.geteuid()
        or stat.S_IMODE(info.st_mode) != 0o700
    ):
        refuse("output path is not a 0700 directory owned by the caller")
    if os.listdir(out):
        refuse("output directory is not empty")


MAX_ZIP_ENTRIES = 64


def refuse_oversized_directory(zip_path):
    """The zip is PR-controlled: count its entries from the end-of-central-directory record BEFORE zipfile
    reads the whole directory into memory, or a zip of millions of empty members could exhaust a root process."""
    with open(zip_path, "rb") as handle:
        handle.seek(0, os.SEEK_END)
        handle.seek(max(0, handle.tell() - 65557))
        tail = handle.read()
    end = tail.rfind(b"PK\x05\x06")
    if end < 0 or len(tail) - end < 22:
        refuse("artifact zip has no end-of-central-directory record")
    total = int.from_bytes(tail[end + 10 : end + 12], "little")
    if total == 0xFFFF or total > MAX_ZIP_ENTRIES:
        refuse(f"artifact zip has more than {MAX_ZIP_ENTRIES} members")


def find_member(infos, name, required):
    """The one zip entry for a fixed member name (None when an optional member is absent); refuse anything odd."""
    # A trailing slash is a directory entry for the same name: counted so it is refused.
    matches = [info for info in infos if info.filename.rstrip("/") == name]
    if not matches:
        if required:
            refuse(f"required member missing from artifact: {name}")
        return None
    if len(matches) > 1:
        refuse(f"member appears twice in artifact: {name}")
    info = matches[0]
    if info.is_dir():
        refuse(f"member is not a regular file: {name}")
    if name.endswith(".json") and info.file_size > MAX_CASES_BYTES:
        refuse(f"member is larger than {MAX_CASES_BYTES} bytes: {name}")
    return info


def extract_known_files(zip_path, out):
    """Copy only the fixed member names; member names never build a path. Return each file's sha256."""
    wanted = [(name, True) for name in REQUIRED] + [(name, False) for name in OPTIONAL]
    sums = {}
    refuse_oversized_directory(zip_path)
    try:
        with zipfile.ZipFile(zip_path) as archive:
            infos = archive.infolist()
            for name, required in wanted:
                info = find_member(infos, name, required)
                if info is None:
                    continue
                with archive.open(info) as source:
                    sums[name] = write_new(os.path.join(out, name), source, f"member {name}")
    except (zipfile.BadZipFile, EOFError, zlib.error) as error:
        refuse(f"artifact zip is unreadable ({type(error).__name__})")
    return sums


def inspect_image(out, archive_sum):
    """Run release-artifact.py (tag + revision label checks) on the image; return its JSON object."""
    lib = os.path.dirname(os.path.abspath(__file__))
    inspected = subprocess.run(
        [
            sys.executable,
            os.path.join(lib, "release-artifact.py"),
            os.path.join(out, "image.tar.gz"),
            SHA,
            f"ghcr.io/alex-mextner/hypercalendarbot-stage:{SHA}",
        ],
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")},
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        check=False,
    )
    if inspected.returncode != 0:
        lines = inspected.stderr.strip().splitlines()
        refuse("stage image rejected: " + (lines[-1] if lines else f"exit {inspected.returncode}"))
    try:
        artifact = json.loads(inspected.stdout)
    except ValueError:
        refuse("release-artifact.py printed no JSON")
    if not isinstance(artifact, dict):
        refuse("release-artifact.py printed no JSON object")
    config = artifact.get("config_digest")
    image_bytes = artifact.get("image_bytes")
    if (
        artifact.get("archive_sha256") != archive_sum
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", str(config))
        or type(image_bytes) is not int
    ):
        refuse("stage image identity is inconsistent")
    return artifact


def fetch(token, out):
    require_current_head(token)
    run_id = build_run(token)
    artifact_id, digest = build_artifact(token, run_id)
    prepare_out(out)
    zip_path = os.path.join(out, "artifact.zip")
    download(token, artifact_id, digest, zip_path)
    del token
    sums = extract_known_files(zip_path, out)
    os.unlink(zip_path)
    artifact = inspect_image(out, sums["image.tar.gz"])
    fd = os.open(
        os.path.join(out, "artifact.json"),
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
    )
    with os.fdopen(fd, "w") as handle:
        json.dump(artifact, handle, sort_keys=True)
        handle.write("\n")
    print(
        f"STAGE_ARTIFACT archive_sha256={artifact['archive_sha256']} config_digest={artifact['config_digest']}"
        f" image_bytes={artifact['image_bytes']} replay={int(OPTIONAL[0] in sums)}"
    )


def main():
    global API, REPO, SHA
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("fetch", "current"):
        command = commands.add_parser(name)
        command.add_argument("--api", required=True)
        command.add_argument("--repo", required=True)
        command.add_argument("--sha", required=True)
        if name == "fetch":
            command.add_argument("--out", required=True)
    args = parser.parse_args()
    API, REPO, SHA = args.api, args.repo, args.sha
    if not re.fullmatch(r"[0-9a-f]{40}", SHA):
        refuse("revision must be a full 40-character lowercase commit SHA")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", REPO):
        refuse("repository must be owner/name")
    token = read_token()
    if args.command == "current":
        require_current_head(token)
    else:
        fetch(token, args.out)


if __name__ == "__main__":
    main()
