import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import unittest.mock
from pathlib import Path

from post_ship_deploy_support import (
    CONFIG,
    IMAGE,
    ROOT,
    SHA,
    FakeCommands,
    module,
    snapshot,
    unavailable_jobs,
)


class PostShipTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / ".git").mkdir()

    def invoke(self, fake):
        return module.deploy(self.root, 42, SHA, call=fake, sleep=lambda _: None)

    def test_runtime_requires_matching_live_digest_not_receipt_only(self):
        for key, value in [
            ("image", "sha256:" + "e" * 64),
            ("revision", "c" * 40),
            ("health", "<html>ok</html>"),
            ("running", False),
            ("ready", "ai chain down"),
        ]:
            s = snapshot()
            s[key] = value
            self.assertFalse(module.runtime_matches(s, SHA))
        self.assertTrue(module.runtime_matches(snapshot(ready="ok (unverified)"), SHA))

    def test_runtime_recognizes_both_image_stores_by_the_receipt_image_id(self):
        # Containerd store: the live .Image is the manifest digest, not the config digest.
        self.assertTrue(module.runtime_matches(snapshot(image=IMAGE, config=CONFIG), SHA))
        # Classic store: the live .Image is the config digest itself.
        self.assertTrue(module.runtime_matches(snapshot(image=CONFIG, config=CONFIG), SHA))
        for label, change in {
            "receipt for another image": {"image_id": "sha256:" + "e" * 64},
            "receipt without image_id": {"image_id": None},
            # A receipt written before #784 named only the config digest.
            "config digest names the live image only": {"image_id": None, "config_digest": IMAGE},
        }.items():
            with self.subTest(label):
                s = snapshot()
                s["receipt"].update(change)
                self.assertFalse(module.runtime_matches(s, SHA))

    def test_identical_verified_release_is_noop(self):
        fake = FakeCommands(self.root, already=True)
        self.assertEqual(self.invoke(fake)["state"], "already_deployed")
        self.assertFalse(
            any(a[0] == "bash" or a[:3] == ["gh", "run", "list"] for a, k in fake.calls)
        )

    def test_live_probe_defaults_to_the_odroid_production_host(self):
        fake = FakeCommands(self.root, already=True)
        environment = {k: v for k, v in os.environ.items() if k != "HYPERCAL_DEPLOY_HOST"}
        with unittest.mock.patch.dict(os.environ, environment, clear=True):
            self.invoke(fake)
        hosts = [
            args[args.index("ConnectTimeout=10") + 1] for args, _ in fake.calls if args[0] == "ssh"
        ]
        self.assertEqual(hosts, ["root@odroidn2"])

    def test_verified_fallback_uses_merged_blob_and_full_local_gate(self):
        for mode in ["none", "unavailable"]:
            fake = FakeCommands(self.root, mode)
            self.assertEqual(self.invoke(fake)["state"], "verified")
            self.assertTrue(any(a[0] == "bash" for a, k in fake.calls))

    def test_real_unscheduled_run_with_skipped_dependencies_reaches_local_fallback(
        self,
    ):
        fake = FakeCommands(self.root, "unavailable-with-skipped")
        self.assertEqual(self.invoke(fake)["state"], "verified")
        self.assertEqual(sum(args[0] == "bash" for args, _ in fake.calls), 1)

    def test_hosted_active_is_not_raced(self):
        fake = FakeCommands(self.root, "active")
        self.assertEqual(self.invoke(fake)["state"], "hosted_pending")
        self.assertFalse(fake.deployed)

    def test_actual_failure_and_metadata_error_refuse_fallback(self):
        for mode in ["failure", "metadata-error", "success"]:
            fake = FakeCommands(self.root, mode)
            with self.assertRaises(module.DeploymentError):
                self.invoke(fake)
            self.assertFalse(fake.deployed)

    def test_unstarted_job_requires_explicit_no_runner_evidence(self):
        with self.assertRaises(module.DeploymentError):
            module.hosted_action({"status": "completed", "conclusion": "failure"}, [{"steps": []}])

    def test_annotation_cannot_authorize_override(self):
        job = {
            "steps": [{"name": "test", "conclusion": "failure"}],
            "runner_id": 123,
            "message": "recent account payments have failed",
        }
        with self.assertRaises(module.DeploymentError):
            module.hosted_action({"status": "completed", "conclusion": "failure"}, [job])

    def test_nonblocking_lock_reports_busy_without_remote_call(self):
        fake = FakeCommands(self.root)
        with module.release_lock(self.root / ".git") as own:
            self.assertTrue(own)
            self.assertEqual(self.invoke(fake)["state"], "busy")
        self.assertFalse(any(a[0] == "ssh" for a, k in fake.calls))

    def test_new_main_returns_superseded_without_build(self):
        fake = FakeCommands(self.root)
        fake.main = "f" * 40
        self.assertEqual(self.invoke(fake)["state"], "superseded")
        self.assertFalse(fake.deployed)

    def test_null_merge_commit_is_explicit_error(self):
        fake = FakeCommands(self.root)

        def call(args, cwd, **kw):
            if args[:3] == ["gh", "pr", "view"]:
                return json.dumps({"state": "MERGED", "baseRefName": "main", "mergeCommit": None})
            return fake(args, cwd, **kw)

        with self.assertRaises(module.DeploymentError):
            module.deploy(self.root, 42, SHA, call=call)

    def test_failed_build_has_terminal_failure_status(self):
        fake = FakeCommands(self.root)

        def call(args, cwd, **kw):
            if args[0] == "bash":
                raise module.DeploymentError("build failed")
            return fake(args, cwd, **kw)

        with self.assertRaises(module.DeploymentError):
            module.deploy(self.root, 42, SHA, call=call, sleep=lambda _: None)
        self.assertEqual(
            json.loads((self.root / ".git/post-ship-release.json").read_text())["state"],
            "failed",
        )


class RecoverySafetyTests(unittest.TestCase):
    setUp = PostShipTests.setUp

    def test_boolean_runner_id_is_not_no_runner_proof(self):
        with self.assertRaises(module.DeploymentError):
            module.hosted_action(
                {"status": "completed", "conclusion": "failure"},
                [{"runner_id": False, "steps": []}],
            )

    def test_child_inherits_release_ownership_until_build_finishes(self):
        fake = FakeCommands(self.root, "unavailable")

        def call(args, cwd, **kw):
            if args[0] == "bash":
                fds = kw.get("keep_fds", ())
                self.assertEqual(len(fds), 1)
                os.fstat(fds[0])
            return fake(args, cwd, **kw)

        self.assertEqual(
            module.deploy(self.root, 42, SHA, call=call, sleep=lambda _: None)["state"],
            "verified",
        )

    def test_running_child_retains_lock_after_controller_is_killed(self):
        ready = self.root / "child-ready"
        child_code = "import os,pathlib,sys,time;pathlib.Path(sys.argv[1]).write_text(str(os.getpid()));time.sleep(30)"
        parent_code = "import importlib.util,sys,pathlib; s=importlib.util.spec_from_file_location('runner',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);cm=m.release_lock(pathlib.Path(sys.argv[2]));fd=cm.__enter__();m.run([sys.executable,'-c',sys.argv[4],sys.argv[3]],pathlib.Path(sys.argv[2]),live=True,keep_fds=(fd,))"
        parent = subprocess.Popen(
            [
                sys.executable,
                "-B",
                "-c",
                parent_code,
                str(ROOT / "scripts/post-ship-deploy.py"),
                str(self.root / ".git"),
                str(ready),
                child_code,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        child_pid = None
        try:
            for _ in range(100):
                if ready.exists():
                    break
                time.sleep(0.02)
            self.assertTrue(ready.exists(), "test child did not start")
            child_pid = int(ready.read_text())
            parent.kill()
            parent.wait(timeout=3)
            with module.release_lock(self.root / ".git") as acquired:
                self.assertIsNone(acquired)
        finally:
            if parent.poll() is None:
                parent.kill()
                parent.wait(timeout=3)
            if child_pid:
                try:
                    os.kill(child_pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass


class SkippedJobMetadataTests(unittest.TestCase):
    def check(self, jobs):
        return module.hosted_action({"status": "completed", "conclusion": "failure"}, jobs)

    def test_explicit_skipped_dependencies_allow_only_no_runner_identifiers(self):
        for runner in [None, 0]:
            jobs = unavailable_jobs()
            jobs[-1]["runner_id"] = runner
            self.assertEqual(self.check(jobs), "local")

    def test_skipped_only_run_is_not_evidence_of_runner_outage(self):
        for runner in [None, 0]:
            jobs = unavailable_jobs()[2:]
            for job in jobs:
                job["runner_id"] = runner
            with self.assertRaises(module.DeploymentError):
                self.check(jobs)

    def test_conflicting_or_missing_metadata_and_real_execution_still_refuse(self):
        invalid = [
            {"runner_id": True},
            {"runner_id": "0"},
            {"runner_id": 8},
            {"runner_name": "active-runner"},
            {"steps": [{"name": "test", "conclusion": "failure"}]},
            {"status": "in_progress"},
            {"status": None},
            {"conclusion": None},
            {"conclusion": "success"},
            {"conclusion": "cancelled"},
        ]
        for patch in invalid:
            with self.subTest(patch=patch), self.assertRaises(module.DeploymentError):
                jobs = unavailable_jobs()
                jobs[-1].update(patch)
                self.check(jobs)
        for key in ["runner_id", "status", "conclusion", "steps"]:
            with self.subTest(missing=key), self.assertRaises(module.DeploymentError):
                jobs = unavailable_jobs()
                del jobs[-1][key]
                self.check(jobs)
