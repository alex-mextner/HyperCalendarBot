import json
import os
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

from post_ship_deploy_support import (
    IMAGE,
    SHA,
    FakeCommands,
    Scripted,
    in_order,
    module,
    snapshot,
)


class DeployContractTests(unittest.TestCase):
    """deploy(): argument and identity validation, phase order, recorded status, failure handling."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / ".git").mkdir()
        environment = {k: v for k, v in os.environ.items() if not k.startswith("HYPERCAL_DEPLOY_")}
        patcher = unittest.mock.patch.dict(os.environ, environment, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    @property
    def status_path(self):
        return self.root / ".git/post-ship-release.json"

    def status(self):
        return json.loads(self.status_path.read_text())

    def invoke(self, call, pr=42, sha=SHA):
        return module.deploy(self.root, pr, sha, call=call, sleep=lambda _: None)

    def heads(self, fake):
        return [
            tuple(args[:2]) if args[0] in ("git", "gh") else (args[0],) for args, _ in fake.calls
        ]

    def test_rejects_malformed_sha_or_pr_before_running_anything(self):
        for pr, sha in [
            (42, "a" * 39),
            (42, "A" * 40),
            (42, "main"),
            (True, SHA),
            (0, SHA),
            (-3, SHA),
            ("42", SHA),
            (4.0, SHA),
        ]:
            with self.subTest(pr=pr, sha=sha):
                fake = FakeCommands(self.root)
                with self.assertRaisesRegex(
                    module.DeploymentError, "full merged SHA and numeric PR required"
                ):
                    self.invoke(fake, pr=pr, sha=sha)
                self.assertEqual(fake.calls, [])

    def test_rejects_an_invalid_repository_identity(self):
        for name in ["", "norepo", "a/b/c", "bad name/repo", "own;er/repo"]:
            with self.subTest(name=name):
                scripted = Scripted(FakeCommands(self.root)).on(("gh", "repo", "view"), name)
                with self.assertRaisesRegex(module.DeploymentError, "invalid repository identity"):
                    self.invoke(scripted)
                self.assertEqual([c[0][0] for c in scripted.calls], ["git", "gh"])
        self.assertFalse(self.status_path.exists())

    def test_repository_identity_is_stripped_and_pr_is_looked_up_in_it(self):
        scripted = Scripted(FakeCommands(self.root, already=True)).on(
            ("gh", "repo", "view"), "own-er/re.po_1\n"
        )
        self.invoke(scripted)
        view = next(args for args, _ in scripted.calls if args[:3] == ["gh", "pr", "view"])
        self.assertEqual(
            view,
            [
                "gh",
                "pr",
                "view",
                "42",
                "--repo",
                "own-er/re.po_1",
                "--json",
                "state,baseRefName,mergeCommit",
            ],
        )

    def test_rejects_prs_that_are_not_merged_into_main(self):
        merged = {"state": "MERGED", "baseRefName": "main", "mergeCommit": {"oid": SHA}}
        for label, payload in {
            "open": {**merged, "state": "OPEN"},
            "other base": {**merged, "baseRefName": "release"},
            "list payload": [merged],
            "no state": {"baseRefName": "main", "mergeCommit": {"oid": SHA}},
        }.items():
            with self.subTest(label):
                scripted = Scripted(FakeCommands(self.root)).on(
                    ("gh", "pr", "view"), json.dumps(payload)
                )
                with self.assertRaisesRegex(module.DeploymentError, "PR is not merged into main"):
                    self.invoke(scripted)
                self.assertNotIn("ssh", [args[0] for args, _ in scripted.calls])

    def test_rejects_a_merge_commit_that_is_not_the_target(self):
        for commit in [None, "x", {}, {"oid": "c" * 40}, [SHA]]:
            with self.subTest(commit=commit):
                payload = {"state": "MERGED", "baseRefName": "main", "mergeCommit": commit}
                scripted = Scripted(FakeCommands(self.root)).on(
                    ("gh", "pr", "view"), json.dumps(payload)
                )
                with self.assertRaisesRegex(module.DeploymentError, "PR merge identity mismatch"):
                    self.invoke(scripted)

    def test_rejects_unsafe_deploy_host_and_directory_from_the_environment(self):
        for key, value, reason in [
            ("HYPERCAL_DEPLOY_HOST", "odroid", "invalid deployment host"),
            ("HYPERCAL_DEPLOY_HOST", "root@host;reboot", "invalid deployment host"),
            ("HYPERCAL_DEPLOY_HOST", "-oProxy=x", "invalid deployment host"),
            ("HYPERCAL_DEPLOY_PATH", "/", "invalid deployment directory"),
            ("HYPERCAL_DEPLOY_PATH", "relative/dir", "invalid deployment directory"),
            ("HYPERCAL_DEPLOY_PATH", "/opt/a b", "invalid deployment directory"),
            ("HYPERCAL_DEPLOY_PATH", "/opt/../etc", "invalid deployment directory"),
            ("HYPERCAL_DEPLOY_PATH", "/opt/$(id)", "invalid deployment directory"),
        ]:
            with (
                self.subTest(key=key, value=value),
                unittest.mock.patch.dict(os.environ, {key: value}),
            ):
                fake = FakeCommands(self.root)
                with self.assertRaisesRegex(module.DeploymentError, reason):
                    self.invoke(fake)
                self.assertNotIn("ssh", [args[0] for args, _ in fake.calls])
                self.assertFalse(self.status_path.exists())

    def test_validation_runs_in_a_fixed_order_before_the_lock_is_taken(self):
        fake = FakeCommands(self.root, already=True)
        self.invoke(fake)
        self.assertEqual(
            self.heads(fake)[:5],
            [
                ("git", "rev-parse"),
                ("gh", "repo"),
                ("gh", "pr"),
                ("git", "fetch"),
                ("git", "rev-parse"),
            ],
        )
        self.assertEqual(
            fake.calls[0][0], ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]
        )

    def test_probe_targets_the_configured_host_and_directory(self):
        with unittest.mock.patch.dict(
            os.environ,
            {"HYPERCAL_DEPLOY_HOST": "deploy@box-1", "HYPERCAL_DEPLOY_PATH": "/srv/hyper_cal"},
        ):
            fake = FakeCommands(self.root, already=True)
            self.invoke(fake)
        args, kw = next(c for c in fake.calls if c[0][0] == "ssh")
        self.assertEqual(
            args,
            [
                "ssh",
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "deploy@box-1",
                "python3 - /srv/hyper_cal",
            ],
        )
        self.assertEqual(kw, {"input_text": module.REMOTE_PROBE})

    def test_already_deployed_records_the_live_image_and_ai_verification(self):
        for ready, verified in [("ok", True), ("ok (unverified)", False)]:
            with self.subTest(ready=ready):
                scripted = Scripted(FakeCommands(self.root)).on(
                    ("ssh",), json.dumps(snapshot(ready=ready))
                )
                outcome = self.invoke(scripted)
                self.assertEqual(self.status(), outcome)
                self.assertEqual(outcome["state"], "already_deployed")
                self.assertEqual(outcome["target"], SHA)
                self.assertEqual(outcome["pid"], os.getpid())
                self.assertEqual(outcome["image"], IMAGE)
                self.assertEqual(outcome["ready"], ready)
                self.assertIs(outcome["ai_verified"], verified)
                self.assertRegex(outcome["updated_at"], r"^\d{4}-\d\d-\d\dT.*\+00:00$")

    def test_busy_lock_reports_exactly_busy_and_writes_no_status(self):
        with module.release_lock(self.root / ".git"):
            self.assertEqual(self.invoke(FakeCommands(self.root)), {"state": "busy", "target": SHA})
        self.assertFalse(self.status_path.exists())

    def test_main_moving_between_checks_supersedes_the_local_fallback(self):
        fake = FakeCommands(self.root)
        scripted = Scripted(fake).on(
            ("git", "rev-parse", "origin/main^{commit}"), in_order(SHA, "f" * 40)
        )
        outcome = self.invoke(scripted)
        self.assertEqual(outcome["state"], "superseded")
        self.assertEqual(self.status()["state"], "superseded")
        self.assertFalse(fake.deployed)
        self.assertNotIn("bash", [args[0] for args, _ in scripted.calls])

    def test_hosted_success_is_verified_by_a_second_live_probe_without_a_local_build(self):
        fake = FakeCommands(self.root, "success")
        scripted = Scripted(fake).on(
            ("ssh",),
            in_order(json.dumps(snapshot("c" * 40)), json.dumps(snapshot(ready="ok (unverified)"))),
        )
        outcome = self.invoke(scripted)
        self.assertEqual(
            (outcome["state"], outcome["ready"], outcome["ai_verified"]),
            ("verified", "ok (unverified)", False),
        )
        self.assertEqual(outcome["image"], IMAGE)
        self.assertNotIn("bash", [args[0] for args, _ in scripted.calls])

    def test_hosted_success_without_live_evidence_fails_with_a_recorded_reason(self):
        with self.assertRaisesRegex(
            module.DeploymentError, "hosted success lacks matching live deployment evidence"
        ):
            self.invoke(FakeCommands(self.root, "success"))
        self.assertEqual(
            (self.status()["state"], self.status()["reason"]),
            ("failed", "hosted success lacks matching live deployment evidence"),
        )

    def test_hosted_pending_is_recorded_without_probing_again(self):
        fake = FakeCommands(self.root, "active")
        outcome = self.invoke(fake)
        self.assertEqual(outcome["state"], "hosted_pending")
        self.assertEqual(self.status()["state"], "hosted_pending")
        self.assertEqual([a[0] for a, _ in fake.calls].count("ssh"), 1)

    def test_local_fallback_runs_exact_blob_in_order_and_records_progress(self):
        fake = FakeCommands(self.root, "none")
        seen = {}

        def build(args, kw):
            seen["status"] = self.status()["state"]
            seen["script"] = Path(args[1])
            seen["text"] = Path(args[1]).read_text()
            fake.deployed = True
            return ""

        scripted = Scripted(fake).on(("bash",), build)
        outcome = self.invoke(scripted)
        self.assertEqual(seen["status"], "local_verifying_and_deploying")
        self.assertEqual(seen["text"], "# exact merged fallback source\n")
        self.assertEqual(seen["script"].name, "deploy-local-fallback.sh")
        self.assertFalse(seen["script"].exists(), "the scratch copy is removed after the build")
        self.assertEqual(outcome["state"], "verified")
        self.assertEqual(self.status(), outcome)
        self.assertEqual(
            [args[:2] if args[0] in ("git", "gh") else args[:1] for args, _ in scripted.calls],
            [
                ["git", "rev-parse"],
                ["gh", "repo"],
                ["gh", "pr"],
                ["git", "fetch"],
                ["git", "rev-parse"],
                ["ssh"],
                ["gh", "run"],
                ["gh", "run"],
                ["gh", "run"],
                ["git", "fetch"],
                ["git", "rev-parse"],
                ["git", "show"],
                ["bash"],
                ["ssh"],
            ],
        )
        show = next(args for args, _ in scripted.calls if args[:2] == ["git", "show"])
        self.assertEqual(show, ["git", "show", f"{SHA}:scripts/deploy-local-fallback.sh"])

    def test_fallback_without_matching_live_evidence_fails(self):
        scripted = Scripted(FakeCommands(self.root)).on(("bash",), "")
        with self.assertRaisesRegex(
            module.DeploymentError, "fallback did not produce matching live deployment evidence"
        ):
            self.invoke(scripted)
        self.assertEqual(self.status()["state"], "failed")
        self.assertEqual(
            self.status()["reason"], "fallback did not produce matching live deployment evidence"
        )
        self.assertEqual(self.status()["target"], SHA)

    def test_os_and_timeout_errors_are_recorded_then_reraised(self):
        for error in [OSError("disk gone"), subprocess.TimeoutExpired("ssh", 60)]:
            with self.subTest(error=type(error).__name__):
                scripted = Scripted(FakeCommands(self.root)).on(("ssh",), error)
                with self.assertRaises(type(error)):
                    self.invoke(scripted)
                self.assertEqual(self.status()["state"], "failed")
                self.assertEqual(self.status()["reason"], str(error))

    def test_unexpected_exceptions_are_not_recorded_as_failures(self):
        scripted = Scripted(FakeCommands(self.root)).on(("ssh",), RuntimeError("bug"))
        with self.assertRaises(RuntimeError):
            self.invoke(scripted)
        self.assertFalse(self.status_path.exists())

    def test_status_failures_inside_the_run_are_reported_as_failed(self):
        scripted = Scripted(FakeCommands(self.root, already=True))
        with (
            unittest.mock.patch.object(
                module, "save_status", side_effect=[OSError("full"), None]
            ) as save,
            self.assertRaises(OSError),
        ):
            self.invoke(scripted)
        self.assertEqual(save.call_args_list[-1].args[1]["state"], "failed")
        self.assertEqual(save.call_args_list[-1].args[1]["reason"], "full")


class MainExitCodeTests(unittest.TestCase):
    def run_main(self, outcome):
        argv = ["post-ship-deploy", "--repo", "/r", "--pr", "42", "--sha", SHA]
        patches = [unittest.mock.patch.object(sys, "argv", argv)]
        if isinstance(outcome, BaseException):
            patches.append(unittest.mock.patch.object(module, "deploy", side_effect=outcome))
        else:
            patches.append(unittest.mock.patch.object(module, "deploy", return_value=outcome))
        with patches[0], patches[1], unittest.mock.patch("builtins.print") as printed:
            code = module.main()
        return code, printed.call_args

    def test_exit_codes_follow_the_outcome_state(self):
        for state, code in [
            ("verified", 0),
            ("already_deployed", 0),
            ("busy", 75),
            ("superseded", 75),
            ("hosted_pending", 75),
        ]:
            with self.subTest(state=state):
                got, call = self.run_main({"state": state, "target": SHA})
                self.assertEqual(got, code)
                self.assertEqual(json.loads(call.args[0]), {"state": state, "target": SHA})

    def test_deployment_errors_exit_one_with_a_json_reason_on_stderr(self):
        for error in [
            module.DeploymentError("nope"),
            OSError("io"),
            subprocess.TimeoutExpired("x", 1),
        ]:
            with self.subTest(error=type(error).__name__):
                got, call = self.run_main(error)
                self.assertEqual(got, 1)
                self.assertEqual(
                    json.loads(call.args[0]),
                    {"state": "failed", "target": SHA, "reason": str(error)},
                )
                self.assertIs(call.kwargs["file"], sys.stderr)
