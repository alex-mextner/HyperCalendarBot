"""Run the real scripts/stage-fetch-artifact.py against a fake GitHub API.

The fake API serves the PR list of a commit, the Stage build workflow runs, a run's artifacts and
a redirect to a separate fake blob host that serves the artifact zip. The image archive comes from
docker_save_fixture.py and is inspected by the real scripts/release-artifact.py.
"""

import ast
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
import urllib.parse
import warnings
import zipfile

from docker_save_fixture import add_members, docker_save_members

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/stage-fetch-artifact.py"
ACTIVATOR = ROOT / "scripts/odroid-activate-release.sh"
SHA = "0123456789abcdef0123456789abcdef01234567"
STAGE_IMAGE = "ghcr.io/alex-mextner/hypercalendarbot-stage"
OTHER_SHA = "f" * 40
FAKE_TOKEN = "FAKE-TOKEN-FOR-STAGE-TESTS-" + "0" * 12
REPO = "alex-mextner/HyperCalendarBot"
BUILD_PATH = ".github/workflows/stage-build.yml"
CASES = b'[{"name": "start"}]\n'
REPLAY = b'[{"name": "replayed"}]\n'
SHARED_HELPERS = ("NoRedirect", "read_token", "authorized", "api", "same_repository", "write_new", "download")


def processes_holding(secret):
    """Command lines of live processes whose argv contains secret."""
    hits = []
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            argv = Path(f"/proc/{pid}/cmdline").read_bytes()
        except OSError:
            continue
        if secret.encode() in argv:
            hits.append(argv.replace(b"\0", b" ").decode(errors="replace"))
    return hits


def image_archive(revision=SHA, tag=None):
    config = json.dumps(
        {"architecture": "arm64", "os": "linux", "config": {"Labels": {"org.opencontainers.image.revision": revision}}}
    ).encode()
    members, _ = docker_save_members(tag or f"{STAGE_IMAGE}:{SHA}", config)
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w:gz") as tar:
        add_members(tar, members)
    return raw.getvalue(), "sha256:" + hashlib.sha256(config).hexdigest()


def make_zip(members):
    """members: list of (name, bytes); duplicates and directory names are kept as given."""
    raw = io.BytesIO()
    # Duplicate names are the point of some fixtures; zipfile's warning about them is expected.
    with warnings.catch_warnings(), zipfile.ZipFile(raw, "w") as archive:
        warnings.simplefilter("ignore")
        for name, data in members:
            archive.writestr(name, data)
    return raw.getvalue()


class FakeGitHub:
    """Fake api.github.com plus a separate blob host the artifact download redirects to."""

    def __init__(self):
        self.api_requests = []
        self.blob_requests = []
        self.argv_with_token = []
        self.zips = {}
        self.pulls = [self.pull()]
        self.runs = []
        self.artifacts = {}
        self.api = self.serve(self.handle_api)
        self.blob = self.serve(self.handle_blob)

    @staticmethod
    def pull(**changes):
        pull = {
            "state": "open",
            "draft": False,
            "head": {"sha": SHA, "repo": {"full_name": REPO}},
            "base": {"repo": {"full_name": REPO}},
        }
        pull.update(changes)
        return pull

    def serve(self, handle):
        fake = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                # The script is mid-request right now: no process may carry the token in argv.
                fake.argv_with_token += processes_holding(FAKE_TOKEN)
                handle(self)

            def log_message(self, *args):
                pass

            def reply(self, status, body=b"", headers=()):
                self.send_response(status)
                for key, value in headers:
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server

    def close(self):
        for server in (self.api, self.blob):
            server.shutdown()
            server.server_close()

    def url(self, server):
        return f"http://127.0.0.1:{server.server_port}"

    def handle_api(self, request):
        url = urllib.parse.urlsplit(request.path)
        query = urllib.parse.parse_qs(url.query)
        self.api_requests.append((url.path, request.headers.get("Authorization"), query))
        base = f"/repos/{REPO}"
        if url.path == f"{base}/commits/{SHA}/pulls":
            return request.reply(200, json.dumps(self.pulls).encode())
        if url.path == f"{base}/actions/workflows/stage-build.yml/runs":
            return request.reply(200, json.dumps({"workflow_runs": self.runs}).encode())
        listing = re.fullmatch(re.escape(base) + r"/actions/runs/(\d+)/artifacts", url.path)
        if listing:
            found = self.artifacts.get(int(listing[1]), [])
            return request.reply(200, json.dumps({"total_count": len(found), "artifacts": found}).encode())
        download = re.fullmatch(re.escape(base) + r"/actions/artifacts/(\d+)/zip", url.path)
        if download and int(download[1]) in self.zips:
            location = f"{self.url(self.blob)}/blob/{download[1]}?sig=synthetic"
            return request.reply(302, headers=[("Location", location)])
        return request.reply(404, b'{"message": "Not Found"}')

    def handle_blob(self, request):
        self.blob_requests.append(dict(request.headers.items()))
        found = re.fullmatch(r"/blob/(\d+)\?sig=synthetic", request.path)
        if not found or int(found[1]) not in self.zips:
            return request.reply(404)
        return request.reply(200, self.zips[int(found[1])])

    def publish(self, zip_bytes, run_id=70, artifact_id=7, digest=None, run=None, artifact=None, extra_artifacts=()):
        """A successful Stage build pull_request run of this repo with its one stage-<sha> artifact."""
        self.runs.append(
            {
                "id": run_id,
                "conclusion": "success",
                "path": BUILD_PATH,
                "head_sha": SHA,
                "event": "pull_request",
                "repository": {"full_name": REPO},
                "head_repository": {"full_name": REPO},
                **(run or {}),
            }
        )
        self.zips[artifact_id] = zip_bytes
        self.artifacts[run_id] = [
            {
                "id": artifact_id,
                "name": "stage-" + SHA,
                "expired": False,
                "size_in_bytes": len(zip_bytes),
                "digest": digest or "sha256:" + hashlib.sha256(zip_bytes).hexdigest(),
                "workflow_run": {"id": run_id, "head_sha": SHA},
                **(artifact or {}),
            },
            *extra_artifacts,
        ]


class StageFetchArtifactTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.out = self.tmp / "out"
        self.github = FakeGitHub()
        self.addCleanup(self.github.close)
        self.image, self.config_id = image_archive()

    def good_members(self, **overrides):
        members = {"image.tar.gz": self.image, "stage-smoke-cases.json": CASES}
        members.update(overrides)
        return list(members.items())

    def run_script(self, command="fetch", sha=SHA, token=FAKE_TOKEN):
        argv = [sys.executable, str(SCRIPT), command, "--api", self.github.url(self.github.api), "--repo", REPO, "--sha", sha]
        if command == "fetch":
            argv += ["--out", str(self.out)]
        return subprocess.run(argv, input="" if token is None else token + "\n", text=True, capture_output=True, timeout=60)

    def assertRefused(self, result, message=None):
        self.assertEqual(result.returncode, 2, result.stderr)
        if message:
            self.assertIn(message, result.stderr)
        self.assertNotIn("STAGE_ARTIFACT", result.stdout)
        self.assertNotIn(FAKE_TOKEN, result.stdout + result.stderr)

    def assertSuperseded(self, result):
        self.assertEqual(result.returncode, 76, result.stderr)
        self.assertIn("superseded", result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertNotIn(FAKE_TOKEN, result.stdout + result.stderr)

    def test_verified_artifact_is_extracted_and_described(self):
        extra = [("evil.sh", b"no\n"), ("scripts/extra.sh", b"no\n"), ("../escape", b"no\n"), ("image.tar.gz.bak", b"no")]
        self.github.publish(make_zip(self.good_members() + extra))
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        archive_sum = hashlib.sha256(self.image).hexdigest()
        self.assertEqual(
            result.stdout.splitlines(),
            [f"STAGE_ARTIFACT archive_sha256={archive_sum} config_digest={self.config_id} image_bytes="
             + str(json.loads((self.out / "artifact.json").read_text())["image_bytes"]) + " replay=0"],
        )
        # Nothing but the fixed members, artifact.json and no leftover zip; extras never reach disk.
        self.assertEqual(sorted(p.name for p in self.out.iterdir()), ["artifact.json", "image.tar.gz", "stage-smoke-cases.json"])
        self.assertFalse((self.tmp / "escape").exists())
        self.assertEqual((self.out / "image.tar.gz").read_bytes(), self.image)
        self.assertEqual((self.out / "stage-smoke-cases.json").read_bytes(), CASES)
        self.assertEqual(oct(os.lstat(self.out).st_mode & 0o777), "0o700")
        for name in os.listdir(self.out):
            self.assertEqual(os.lstat(self.out / name).st_mode & 0o777, 0o600, name)
        artifact = json.loads((self.out / "artifact.json").read_text())
        self.assertEqual(artifact["archive_sha256"], archive_sum)
        self.assertEqual(artifact["config_digest"], self.config_id)
        self.assertEqual(artifact["image_ref"], f"{STAGE_IMAGE}:{SHA}")
        # The token authenticates every API call, never reaches the blob host, argv or any output.
        self.assertTrue(self.github.api_requests)
        self.assertEqual({auth for _, auth, _ in self.github.api_requests}, {"Bearer " + FAKE_TOKEN})
        self.assertEqual(len(self.github.blob_requests), 1)
        self.assertNotIn("authorization", {key.lower() for key in self.github.blob_requests[0]})
        self.assertEqual(self.github.argv_with_token, [])
        self.assertNotIn(FAKE_TOKEN, result.stdout + result.stderr)

    def test_the_run_is_looked_up_with_the_pinned_query_not_a_caller_id(self):
        self.github.publish(make_zip(self.good_members()))
        self.assertEqual(self.run_script().returncode, 0)
        runs = [q for path, _, q in self.github.api_requests if path.endswith("/stage-build.yml/runs")]
        self.assertEqual(len(runs), 1)
        self.assertEqual(
            {k: v[0] for k, v in runs[0].items()},
            {"head_sha": SHA, "event": "pull_request", "status": "completed", "per_page": "20"},
        )
        artifacts = [q for path, _, q in self.github.api_requests if path.endswith("/artifacts")]
        self.assertEqual(artifacts, [{"name": ["stage-" + SHA]}])

    def test_replay_file_is_extracted_when_present(self):
        self.github.publish(make_zip(self.good_members(**{"stage-smoke-cases.replay.json": REPLAY})))
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.rstrip().endswith("replay=1"), result.stdout)
        self.assertEqual((self.out / "stage-smoke-cases.replay.json").read_bytes(), REPLAY)

    def test_a_zip_with_more_members_than_the_cap_is_refused_before_it_is_parsed(self):
        # The zip is PR-controlled: a directory of millions of members would be read into a root process's memory.
        members = self.good_members() + [(f"pad-{n}.txt", b"x") for n in range(70)]
        self.github.publish(make_zip(members))
        self.assertRefused(self.run_script(), "more than 64 members")

    def test_empty_directory_made_by_the_wrapper_is_accepted(self):
        self.out.mkdir(mode=0o700)
        self.github.publish(make_zip(self.good_members()))
        self.assertEqual(self.run_script().returncode, 0)

    def test_existing_unsafe_or_nonempty_output_directory_is_refused(self):
        self.github.publish(make_zip(self.good_members()))
        self.out.mkdir(mode=0o755)
        self.assertRefused(self.run_script(), "0700 directory")
        self.out.chmod(0o700)
        (self.out / "stale").write_text("x")
        self.assertRefused(self.run_script(), "not empty")

    def test_current_head_of_open_pr_is_accepted(self):
        result = self.run_script("current")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_superseded_head_exits_76_before_any_download(self):
        cases = {
            "draft": lambda g: g.pulls[0].update(draft=True),
            "closed": lambda g: g.pulls[0].update(state="closed"),
            "head moved": lambda g: g.pulls[0]["head"].update(sha=OTHER_SHA),
            "head repo differs": lambda g: g.pulls[0]["head"].update(repo={"full_name": "fork/HyperCalendarBot"}),
            "head repo deleted": lambda g: g.pulls[0]["head"].update(repo=None),
            "base repo differs": lambda g: g.pulls[0]["base"].update(repo={"full_name": "other/Repo"}),
            "no pull request": lambda g: g.pulls.clear(),
        }
        for label, change in cases.items():
            for command in ("current", "fetch"):
                with self.subTest(label, command=command):
                    self.github = FakeGitHub()
                    self.addCleanup(self.github.close)
                    self.github.publish(make_zip(self.good_members()))
                    change(self.github)
                    self.assertSuperseded(self.run_script(command))
                    self.assertFalse(self.out.exists())
                    self.assertEqual(self.github.blob_requests, [])

    def test_unusable_build_runs_are_refused(self):
        cases = {
            "fork run": {"head_repository": {"full_name": "fork/HyperCalendarBot"}},
            "fork base repo": {"repository": {"full_name": "fork/HyperCalendarBot"}},
            "wrong path": {"path": ".github/workflows/other.yml"},
            "wrong event": {"event": "push"},
            "not success": {"conclusion": "failure"},
            "wrong head sha": {"head_sha": OTHER_SHA},
        }
        for label, run in cases.items():
            with self.subTest(label):
                self.github = FakeGitHub()
                self.addCleanup(self.github.close)
                self.github.publish(make_zip(self.good_members()), run=run)
                self.assertRefused(self.run_script())
                self.assertEqual(self.github.blob_requests, [])
                self.assertFalse(self.out.exists())

    def test_newest_run_that_is_a_fork_is_not_replaced_by_an_older_run(self):
        self.github.publish(make_zip(self.good_members()), run_id=70, artifact_id=7)
        self.github.publish(
            make_zip(self.good_members()), run_id=71, artifact_id=8, run={"head_repository": {"full_name": "fork/X"}}
        )
        self.assertRefused(self.run_script(), "fork")

    def test_no_run_at_all_is_refused(self):
        self.assertRefused(self.run_script(), "no successful Stage build")

    def test_unusable_artifacts_are_refused(self):
        zip_bytes = make_zip(self.good_members())
        cases = {
            "expired": {"artifact": {"expired": True}},
            "digest not sha256": {"artifact": {"digest": "md5:abc"}},
            "digest missing": {"artifact": {"digest": None}},
            "oversize": {"artifact": {"size_in_bytes": 2 * 1024**3 + 1}},
            "zero size": {"artifact": {"size_in_bytes": 0}},
            "bool size": {"artifact": {"size_in_bytes": True}},
            "other run": {"artifact": {"workflow_run": {"id": 99, "head_sha": SHA}}},
            "other head": {"artifact": {"workflow_run": {"id": 70, "head_sha": OTHER_SHA}}},
            "wrong name": {"artifact": {"name": "stage-" + OTHER_SHA}},
            "digest mismatch": {"digest": "sha256:" + "0" * 64},
            "duplicate": {"extra_artifacts": [{"id": 8, "name": "stage-" + SHA}]},
        }
        for label, changes in cases.items():
            with self.subTest(label):
                self.github = FakeGitHub()
                self.addCleanup(self.github.close)
                self.github.publish(zip_bytes, **changes)
                result = self.run_script()
                self.assertRefused(result)
                if label == "digest mismatch":
                    self.assertIn("digest mismatch", result.stderr)

    def test_no_artifact_for_the_run_is_refused(self):
        self.github.publish(make_zip(self.good_members()))
        self.github.artifacts[70] = []
        self.assertRefused(self.run_script(), "expected exactly one")

    def test_bad_zip_members_are_refused(self):
        cases = {
            "duplicate image": self.good_members() + [("image.tar.gz", self.image)],
            "duplicate cases": self.good_members() + [("stage-smoke-cases.json", CASES)],
            "directory member": [("image.tar.gz/", b""), ("stage-smoke-cases.json", CASES)],
            "optional is a directory": self.good_members() + [("stage-smoke-cases.replay.json/", b"")],
            "missing image": [("stage-smoke-cases.json", CASES)],
            "missing cases": [("image.tar.gz", self.image)],
            "not a zip": None,
        }
        for label, members in cases.items():
            with self.subTest(label):
                self.github = FakeGitHub()
                self.addCleanup(self.github.close)
                self.github.publish(make_zip(members) if members is not None else b"this is not a zip file")
                if self.out.exists():
                    shutil.rmtree(self.out)
                self.assertRefused(self.run_script())

    def test_image_that_does_not_match_the_sha_is_refused(self):
        wrong = {
            "label": image_archive(revision=OTHER_SHA)[0],
            "tag": image_archive(tag=f"{STAGE_IMAGE}:{OTHER_SHA}")[0],
            "prod tag": image_archive(tag=f"ghcr.io/alex-mextner/hypercalendarbot:{SHA}")[0],
            "bare docker.io name": image_archive(tag=f"hypercalendarbot-stage:{SHA}")[0],
            "not an image": b"garbage",
        }
        for label, image in wrong.items():
            with self.subTest(label):
                self.github = FakeGitHub()
                self.addCleanup(self.github.close)
                self.github.publish(make_zip(self.good_members(**{"image.tar.gz": image})))
                if self.out.exists():
                    shutil.rmtree(self.out)
                self.assertRefused(self.run_script(), "stage image rejected")

    def test_bad_sha_and_missing_token_are_refused(self):
        self.github.publish(make_zip(self.good_members()))
        for sha in ("abc", SHA.upper(), SHA + "0", "../" + SHA[3:]):
            with self.subTest(sha=sha):
                self.assertRefused(self.run_script(sha=sha), "40-character")
        for token in (None, "", "short"):
            with self.subTest(token=token):
                self.assertRefused(self.run_script(token=token), "token is required")
        self.assertEqual(self.github.api_requests, [])

    def test_shared_helpers_are_textually_identical_to_the_activator(self):
        heredoc = re.search(r"<<'PY'\n(.*?)\nPY\n", ACTIVATOR.read_text(), re.S)[1]
        theirs, ours = heredoc, SCRIPT.read_text()

        def sources(text):
            found = {}
            for node in ast.parse(text).body:
                if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
                    found[node.name] = ast.get_source_segment(text, node)
            return found

        theirs_src, ours_src = sources(theirs), sources(ours)
        for name in SHARED_HELPERS:
            self.assertIn(name, theirs_src, name)
            self.assertEqual(ours_src.get(name), theirs_src[name], name)
        # refuse differs only by its message prefix.
        self.assertEqual(
            ours_src["refuse"].replace("hypercal-stage-fetch-artifact: ", "PREFIX"),
            theirs_src["refuse"].replace("hypercal-activate-release: ", "PREFIX"),
        )
        for constant in ("MAX_ARTIFACT_BYTES", "MAX_JSON_BYTES", "MAX_REDIRECTS"):
            line = re.search(rf"^{constant} = .*$", theirs, re.M)[0]
            self.assertIn(line, ours)
        self.assertIn("OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)", ours)

    def test_token_is_never_read_from_argv_or_environment(self):
        self.github.publish(make_zip(self.good_members()))
        argv = [sys.executable, str(SCRIPT), "current", "--api", self.github.url(self.github.api), "--repo", REPO, "--sha", SHA]
        env = {**os.environ, "GITHUB_TOKEN": FAKE_TOKEN, "GH_TOKEN": FAKE_TOKEN}
        result = subprocess.run(argv, input="", text=True, capture_output=True, env=env, timeout=60)
        self.assertRefused(result, "token is required")


if __name__ == "__main__":
    unittest.main()
