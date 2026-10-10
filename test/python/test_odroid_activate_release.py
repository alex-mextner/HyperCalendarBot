"""Run the real odroid root activation wrapper against a fake GitHub API.

The wrapper's fixed constants (API base URL, deploy path, PATH) are rewritten in a copy
to point at local fixtures; everything else, including its Python core, runs as
installed. A fake API serves the main ref, the artifact list, workflow runs and a
redirect to a separate fake blob host that serves the release zip. The zip's
scripts/deploy-prebuilt-image.sh is a recorder, except in the guard test, which ships
the real activator and stops it at its release lock.
"""

import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import threading
import unittest
import urllib.parse
import zipfile

ROOT = Path(__file__).resolve().parents[2]
WRAPPER = ROOT / "scripts/odroid-activate-release.sh"
SHA = "0123456789abcdef0123456789abcdef01234567"
OTHER_SHA = "f" * 40
FAKE_TOKEN = "FAKE-TOKEN-FOR-WRAPPER-TESTS-" + "0" * 12
REPO = "alex-mextner/HyperCalendarBot"
WORKFLOW_PATH = ".github/workflows/deploy.yml"
IMAGE = "ghcr.io/alex-mextner/hypercalendarbot"
SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


def workflow_release_files():
    """Release-relative paths the hosted build copies into its uploaded release directory."""
    text = (ROOT / ".github/workflows/deploy.yml").read_text()
    copied = set()
    for sources, subdir in re.findall(r"^\s*cp (.+) release(/scripts)?/\s*$", text, re.M):
        for source in sources.split():
            copied.add(("scripts/" if subdir else "") + Path(source).name)
    if not copied:
        raise AssertionError("deploy.yml stages no release files")
    return copied


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


def image_archive(revision=SHA, extra_label=None):
    labels = {"org.opencontainers.image.revision": revision}
    if extra_label:
        labels["fixture.variant"] = extra_label
    config = json.dumps({"architecture": "arm64", "os": "linux", "config": {"Labels": labels}}).encode()
    config_path = "blobs/sha256/" + hashlib.sha256(config).hexdigest()
    manifest = json.dumps([{"Config": config_path, "RepoTags": [f"{IMAGE}:{SHA}"], "Layers": []}]).encode()
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w:gz") as tar:
        for name, data in (("manifest.json", manifest), (config_path, config)):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return raw.getvalue(), "sha256:" + hashlib.sha256(config).hexdigest()


class FakeGitHub:
    """Fake api.github.com plus a separate blob host the artifact download redirects to."""

    def __init__(self):
        self.main = SHA
        self.artifacts = {}
        self.statuses = []
        self.runs = {}
        self.zips = {}
        self.page_size = 100
        self.storage_hops = 0
        self.api_requests = []
        self.blob_requests = []
        self.argv_with_token = []
        self.api = self.serve(self.handle_api)
        self.blob = self.serve(self.handle_blob)

    def serve(self, handle):
        fake = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                # The wrapper is mid-request right now: no process may carry the token in argv.
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
        self.api_requests.append((url.path, request.headers.get("Authorization")))
        base = f"/repos/{REPO}"
        if url.path == base + "/git/ref/heads/main":
            return request.reply(200, json.dumps({"object": {"sha": self.main}}).encode())
        if url.path == f"{base}/commits/{SHA}/statuses":
            query = urllib.parse.parse_qs(url.query)
            size = min(int(query["per_page"][0]), self.page_size)
            start = (int(query["page"][0]) - 1) * size
            # GitHub lists statuses newest first.
            newest_first = self.statuses[::-1]
            return request.reply(200, json.dumps(newest_first[start : start + size]).encode())
        artifact = re.fullmatch(re.escape(base) + r"/actions/artifacts/(\d+)", url.path)
        if artifact and int(artifact[1]) in self.artifacts:
            return request.reply(200, json.dumps(self.artifacts[int(artifact[1])]).encode())
        run = re.fullmatch(re.escape(base) + r"/actions/runs/(\d+)", url.path)
        if run and int(run[1]) in self.runs:
            return request.reply(200, json.dumps(self.runs[int(run[1])]).encode())
        download = re.fullmatch(re.escape(base) + r"/actions/artifacts/(\d+)/zip", url.path)
        if download and int(download[1]) in self.zips:
            location = f"{self.url(self.blob)}/hop/{self.storage_hops}/{download[1]}?sig=synthetic"
            return request.reply(302, headers=[("Location", location)])
        return request.reply(404, b'{"message": "Not Found"}')

    def handle_blob(self, request):
        """Storage that redirects storage_hops more times before serving the zip."""
        self.blob_requests.append(dict(request.headers.items()))
        found = re.fullmatch(r"/hop/(\d+)/(\d+)\?sig=synthetic", request.path)
        if not found or int(found[2]) not in self.zips:
            return request.reply(404)
        hops, artifact_id = int(found[1]), int(found[2])
        if hops:
            return request.reply(302, headers=[("Location", f"/hop/{hops - 1}/{artifact_id}?sig=synthetic")])
        return request.reply(200, self.zips[artifact_id])

    def upload(self, artifact_id, zip_bytes, run_id=70, digest=None, name="release-" + SHA, expired=False, **run_changes):
        """An artifact uploaded into workflow run run_id, which is a push-to-main run unless changed."""
        self.runs[run_id] = {
            "id": run_id,
            "event": "push",
            "head_branch": "main",
            "head_sha": SHA,
            "path": WORKFLOW_PATH,
            "repository": {"full_name": REPO},
            "head_repository": {"full_name": REPO},
            **run_changes,
        }
        self.zips[artifact_id] = zip_bytes
        self.artifacts[artifact_id] = {
            "id": artifact_id,
            "name": name,
            "expired": expired,
            "size_in_bytes": len(zip_bytes),
            "digest": digest or "sha256:" + hashlib.sha256(zip_bytes).hexdigest(),
            "workflow_run": {"id": run_id, "head_sha": SHA, "head_branch": "main"},
        }
        return "sha256:" + hashlib.sha256(zip_bytes).hexdigest()

    def post_status(self, artifact_id, digest, run_id=70, **changes):
        """A commit status as the build job's step posts it; later calls are newer."""
        self.statuses.append(
            {
                "context": "release-artifact",
                "state": "success",
                "description": f"artifact {artifact_id} {digest}",
                "target_url": f"https://github.com/{REPO}/actions/runs/{run_id}",
                "creator": {"login": "github-actions[bot]"},
                **changes,
            }
        )

    def publish(self, artifact_id, zip_bytes, run_id=70, **run_changes):
        """The build job's release: the artifact plus the status that pins it."""
        digest = self.upload(artifact_id, zip_bytes, run_id=run_id, **run_changes)
        self.post_status(artifact_id, digest, run_id=run_id)


class ActivateReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.deploy = self.tmp / "deploy"
        self.record = self.tmp / "record"
        self.bin = self.tmp / "bin"
        for directory in (self.deploy, self.record, self.bin):
            directory.mkdir()
        self.github = FakeGitHub()
        self.addCleanup(self.github.close)
        self.image, self.config_id = image_archive()
        self.expected = workflow_release_files() | {"image.tar.gz", "artifact.json"}
        self.wrapper = self.tmp / "hypercal-activate-release"
        text = WRAPPER.read_text()
        for old, new in (
            ("readonly API=https://api.github.com\n", f"readonly API={self.github.url(self.github.api)}\n"),
            ("readonly DEPLOY_PATH=/opt/hypercal\n", f"readonly DEPLOY_PATH={self.deploy}\n"),
            (f"readonly SAFE_PATH={SAFE_PATH}\n", f"readonly SAFE_PATH={self.bin}:{SAFE_PATH}\n"),
        ):
            self.assertEqual(text.count(old), 1, old)
            text = text.replace(old, new)
        self.wrapper.write_text(text)
        self.wrapper.chmod(0o755)

    def recorder(self, exit_code=0):
        return (
            "#!/bin/bash\n"
            f"python3 - \"$@\" > {self.record}/run.json <<'PY'\n"
            "import json, os, stat, sys\n"
            "stage = sys.argv[2]\n"
            "files = {}\n"
            "for top, dirs, names in os.walk(stage):\n"
            "    for name in dirs + names:\n"
            "        path = os.path.join(top, name)\n"
            "        files[os.path.relpath(path, stage)] = stat.S_IMODE(os.lstat(path).st_mode)\n"
            "print(json.dumps({'args': sys.argv[1:], 'stage_mode': stat.S_IMODE(os.lstat(stage).st_mode),\n"
            "                  'files': files, 'env': sorted(os.environ)}))\n"
            "PY\n"
            f"exit {exit_code}\n"
        )

    def release_zip(self, activator=None, image=None, drop=(), extra=()):
        members = {name: f"release file {name}\n".encode() for name in self.expected}
        members["image.tar.gz"] = image or self.image
        members["scripts/release-artifact.py"] = (ROOT / "scripts/release-artifact.py").read_bytes()
        members["scripts/deploy-prebuilt-image.sh"] = (activator or self.recorder()).encode()
        for name in drop:
            del members[name]
        raw = io.BytesIO()
        with zipfile.ZipFile(raw, "w") as archive:
            for name, data in [*members.items(), *extra]:
                archive.writestr(name, data)
        return raw.getvalue()

    def run_wrapper(self, *args, token=FAKE_TOKEN):
        return subprocess.run(
            [str(self.wrapper), *(args or (SHA,))],
            input="" if token is None else token + "\n",
            text=True,
            capture_output=True,
            timeout=60,
        )

    def recorded(self):
        path = self.record / "run.json"
        return json.loads(path.read_text()) if path.exists() else None

    def leftover_stages(self):
        return sorted(p.name for p in self.deploy.iterdir() if p.name.startswith(".incoming-"))

    def assertRefused(self, result, message):
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn(message, result.stderr)
        self.assertIsNone(self.recorded())
        self.assertEqual(self.leftover_stages(), [])
        self.assertNotIn(FAKE_TOKEN, result.stdout + result.stderr)

    def test_verified_release_reaches_the_activator_with_sums_computed_by_root(self):
        extra = [("evil.sh", b"not part of the release\n"), ("scripts/extra.sh", b"no\n"), ("../escape", b"no\n")]
        self.github.publish(7, self.release_zip(extra=extra))
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stderr)
        run = self.recorded()
        deploy_path, stage, image, sha, archive_sum, config = run["args"]
        self.assertEqual((deploy_path, image, sha), (str(self.deploy), IMAGE, SHA))
        self.assertEqual(archive_sum, hashlib.sha256(self.image).hexdigest())
        self.assertEqual(config, self.config_id)
        self.assertEqual(Path(stage).parent, self.deploy)
        self.assertRegex(Path(stage).name, r"^\.incoming-" + SHA + r"-\d+-\d+$")
        self.assertEqual(run["stage_mode"], 0o700)
        # Only the known release files: no extras, no escaped path, no leftover zip.
        self.assertEqual(set(run["files"]), self.expected | {"scripts"})
        self.assertEqual(run["files"]["scripts"], 0o700)
        for name in self.expected:
            self.assertEqual(run["files"][name], 0o600, name)
        self.assertFalse((self.tmp / "escape").exists())
        # Only what env -i passes; bash itself adds PWD, SHLVL and _.
        self.assertEqual(set(run["env"]) - {"PWD", "SHLVL", "_"}, {"HOME", "LANG", "PATH"})
        self.assertEqual(self.leftover_stages(), [])
        # The token authenticates every API call, never reaches the blob host or any argv.
        self.assertTrue(self.github.api_requests)
        self.assertEqual({auth for _, auth in self.github.api_requests}, {"Bearer " + FAKE_TOKEN})
        self.assertEqual(len(self.github.blob_requests), 1)
        self.assertNotIn("authorization", {key.lower() for key in self.github.blob_requests[0]})
        self.assertEqual(self.github.argv_with_token, [])
        self.assertNotIn(FAKE_TOKEN, result.stdout + result.stderr)

    def test_storage_redirect_chain_is_followed_without_the_token(self):
        self.github.storage_hops = 2
        self.github.publish(7, self.release_zip())
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.github.blob_requests), 3)
        for headers in self.github.blob_requests:
            self.assertNotIn("authorization", {key.lower() for key in headers})

    def test_endless_storage_redirects_are_refused(self):
        self.github.storage_hops = 10
        self.github.publish(7, self.release_zip())
        self.assertRefused(self.run_wrapper(), "artifact download redirected more than 3 times")

    def test_missing_artifact_json_is_allowed_because_the_activator_rewrites_it(self):
        self.github.publish(7, self.release_zip(drop=["artifact.json"]))
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("artifact.json", self.recorded()["files"])

    def test_moved_main_is_refused_before_any_artifact_is_read(self):
        self.github.main = OTHER_SHA
        self.github.publish(7, self.release_zip())
        result = self.run_wrapper()
        self.assertRefused(result, f"superseded: main is {OTHER_SHA}")
        self.assertEqual([path for path, _ in self.github.api_requests], [f"/repos/{REPO}/git/ref/heads/main"])
        self.assertEqual(self.github.blob_requests, [])

    def test_artifact_the_status_does_not_name_is_never_deployed(self):
        # Code on the odroid runner uploads a newer release-<sha> into the same trusted run.
        # Its zip is a valid release with a different image; the status still names artifact 7.
        planted_image, _ = image_archive(extra_label="planted")
        self.github.publish(7, self.release_zip())
        self.github.upload(8, self.release_zip(image=planted_image))
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.recorded()["args"][4], hashlib.sha256(self.image).hexdigest())
        requested = [path for path, _ in self.github.api_requests]
        self.assertIn(f"/repos/{REPO}/actions/artifacts/7/zip", requested)
        self.assertFalse(any("/actions/artifacts/8" in path for path in requested))

    def test_rerun_status_naming_a_newer_artifact_wins(self):
        # "Re-run all jobs" uploads again and posts a newer status. The older artifact here would
        # fail its digest check, so success proves the newest status chose the newer artifact.
        old_digest = self.github.upload(7, self.release_zip())
        self.github.zips[7] = b"corrupted after upload"
        self.github.post_status(7, old_digest)
        self.github.publish(8, self.release_zip())
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.recorded()["args"][4], hashlib.sha256(self.image).hexdigest())

    def test_status_on_a_later_page_is_found_and_other_contexts_are_ignored(self):
        self.github.page_size = 1
        self.github.publish(7, self.release_zip())
        # Newer statuses from other contexts, one of them pointing at a planted artifact.
        planted = self.github.upload(9, self.release_zip())
        self.github.post_status(9, planted, context="ci/other")
        self.github.post_status(9, planted, context="release-artifact-extra")
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stderr)
        requested = [path for path, _ in self.github.api_requests]
        self.assertIn(f"/repos/{REPO}/actions/artifacts/7/zip", requested)
        self.assertFalse(any("/actions/artifacts/9" in path for path in requested))

    def test_missing_or_untrusted_status_is_refused(self):
        cases = {
            "no status": None,
            "pending": {"state": "pending"},
            "failure": {"state": "failure"},
            "posted by a user": {"creator": {"login": "alex-mextner"}},
            "posted by another app": {"creator": {"login": "some-app[bot]"}},
            "no creator": {"creator": None},
            "description without digest": {"description": "artifact 7"},
            "description with bare hex": {"description": "artifact 7 " + "a" * 64},
            "description with trailing text": {"description": "artifact 7 sha256:" + "a" * 64 + " extra"},
            "target outside the repository": {"target_url": "https://github.com/someone/HyperCalendarBot/actions/runs/70"},
            "target not a run": {"target_url": f"https://github.com/{REPO}/pull/70"},
            "target on another host": {"target_url": f"https://example.com/{REPO}/actions/runs/70"},
        }
        messages = {
            "no status": "no release-artifact commit status",
            "pending": "status is 'pending'",
            "failure": "status is 'failure'",
            "posted by a user": "not posted by github-actions[bot]",
            "posted by another app": "not posted by github-actions[bot]",
            "no creator": "not posted by github-actions[bot]",
            "target outside the repository": "target is not a workflow run",
            "target not a run": "target is not a workflow run",
            "target on another host": "target is not a workflow run",
        }
        for label, changes in cases.items():
            with self.subTest(label):
                self.github.statuses.clear()
                digest = self.github.upload(7, self.release_zip())
                if changes is not None:
                    self.github.post_status(7, digest, **changes)
                self.assertRefused(self.run_wrapper(), messages.get(label, "status description is not"))
                self.assertEqual(self.github.blob_requests, [])

    def test_artifact_that_disagrees_with_the_status_is_refused(self):
        cases = {
            "status digest differs from the artifact": ({}, {"description": "artifact 7 sha256:" + "0" * 64}),
            "artifact from another run": ({"run_id": 71}, {}),
            "artifact named differently": ({"name": "release-" + OTHER_SHA}, {}),
            "expired artifact": ({"expired": True}, {}),
        }
        messages = {
            "status digest differs from the artifact": "digest differs from the build job's status",
            "artifact from another run": "was not uploaded by run 70",
            "artifact named differently": f"artifact 7 is not release-{SHA}",
            "expired artifact": "artifact 7 has expired",
        }
        for label, (upload_changes, status_changes) in cases.items():
            with self.subTest(label):
                self.github.statuses.clear()
                digest = self.github.upload(7, self.release_zip(), **upload_changes)
                self.github.post_status(7, digest, **status_changes)
                self.assertRefused(self.run_wrapper(), messages[label])
                self.assertEqual(self.github.blob_requests, [])

    def test_status_pointing_at_any_other_run_is_refused(self):
        cases = {
            "pull_request_target on main": {"event": "pull_request_target"},
            "workflow_dispatch": {"event": "workflow_dispatch"},
            "other branch": {"head_branch": "feature"},
            "other workflow": {"path": ".github/workflows/ci-image.yml"},
            "fork head": {"head_repository": {"full_name": "someone/HyperCalendarBot"}},
            "other repository": {"repository": {"full_name": "someone/HyperCalendarBot"}},
            "other commit": {"head_sha": OTHER_SHA},
        }
        for label, changes in cases.items():
            with self.subTest(label):
                self.github.statuses.clear()
                self.github.publish(7, self.release_zip(), **changes)
                self.assertRefused(self.run_wrapper(), f"run 70 is not a push-to-main run of {WORKFLOW_PATH}")
                self.assertEqual(self.github.blob_requests, [])

    def test_downloaded_zip_that_differs_from_the_recorded_digest_is_refused(self):
        self.github.publish(7, self.release_zip())
        self.github.zips[7] = self.release_zip(drop=["artifact.json"])
        self.assertRefused(self.run_wrapper(), "artifact digest mismatch")

    def test_missing_release_file_is_refused(self):
        self.github.publish(7, self.release_zip(drop=["Caddyfile"]))
        self.assertRefused(self.run_wrapper(), "release file missing from artifact: Caddyfile")

    def test_image_built_from_another_revision_is_refused(self):
        image, _ = image_archive(revision=OTHER_SHA)
        self.github.publish(7, self.release_zip(image=image))
        self.assertRefused(self.run_wrapper(), "release image rejected: ValueError: Artifact revision mismatch")

    def test_activator_failure_code_propagates_and_stage_is_removed(self):
        self.github.publish(7, self.release_zip(activator=self.recorder(exit_code=17)))
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 17)
        self.assertIsNotNone(self.recorded())
        self.assertEqual(self.leftover_stages(), [])

    def test_bad_invocation_is_refused_before_any_api_call(self):
        self.github.publish(7, self.release_zip())
        for label, args in {
            "no argument": (),
            "short sha": (SHA[:12],),
            "uppercase sha": (SHA.upper(),),
            "extra argument": (SHA, "/tmp/release"),
        }.items():
            with self.subTest(label):
                result = subprocess.run(
                    [str(self.wrapper), *args], input=FAKE_TOKEN + "\n", text=True, capture_output=True, timeout=30
                )
                self.assertRefused(result, "hypercal-activate-release:")
        for label, token in {"no token": None, "short token": "short"}.items():
            with self.subTest(label):
                self.assertRefused(self.run_wrapper(token=token), "a GitHub token is required on stdin")
        self.assertEqual(self.github.api_requests, [])

    def test_stage_name_passes_the_real_activator_ownership_guard(self):
        self.github.publish(7, self.release_zip(activator=(ROOT / "scripts/deploy-prebuilt-image.sh").read_text()))
        # A held release lock stops the real activator right after its staging guard.
        flock = self.bin / "flock"
        flock.write_text("#!/bin/sh\nexit 1\n")
        flock.chmod(0o755)
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("Another release owns this service", result.stderr)
        self.assertNotIn("no cleanup armed", result.stderr)
        self.assertEqual(self.leftover_stages(), [])


if __name__ == "__main__":
    unittest.main()
