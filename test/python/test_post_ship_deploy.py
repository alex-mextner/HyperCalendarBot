import importlib.util
import json
import os
import runpy
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import unittest.mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "post_ship_deploy", ROOT / "scripts/post-ship-deploy.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
SHA = "a" * 40
IMAGE = "sha256:" + "b" * 64
CONFIG = "sha256:" + "d" * 64


def snapshot(sha=SHA, image=IMAGE, ready="ok", config=CONFIG):
    # The odroid's containerd image store reports the manifest digest as the container's .Image,
    # so image_id and config_digest differ there (#784); the classic store makes them equal.
    return {
        "receipt": {"revision": sha, "config_digest": config, "image_id": image},
        "revision": sha,
        "image": image,
        "running": True,
        "health": "ok",
        "ready": ready,
    }


def unavailable_jobs():
    # Reduced actual GitHub run35431103705 metadata; no annotations or secrets.
    return [
        {
            "name": "test",
            "status": "completed",
            "conclusion": "failure",
            "runner_id": 0,
            "steps": [],
        },
        {
            "name": "Notify on failure",
            "status": "completed",
            "conclusion": "failure",
            "runner_id": 0,
            "steps": [],
        },
        {
            "name": "build",
            "status": "completed",
            "conclusion": "skipped",
            "runner_id": None,
            "steps": [],
        },
        {
            "name": "deploy",
            "status": "completed",
            "conclusion": "skipped",
            "runner_id": None,
            "steps": [],
        },
    ]


class FakeCommands:
    # Command prefix -> handler method; each handler gets (args, kw) and answers like the real tool.
    ROUTES = (
        (("git", "rev-parse"), "rev_parse"),
        (("git", "fetch"), "fetch"),
        (("gh", "repo", "view"), "repo_view"),
        (("gh", "pr", "view"), "pr_view"),
        (("ssh",), "probe"),
        (("gh", "run", "list"), "run_list"),
        (("gh", "api"), "run_jobs"),
        (("git", "show"), "show_fallback"),
        (("bash",), "build"),
    )

    def __init__(self, root, mode="none", already=False):
        self.root = root
        self.mode = mode
        self.deployed = already
        self.calls = []
        self.main = SHA

    def __call__(self, args, cwd, **kw):
        self.calls.append((args, kw))
        for prefix, handler in self.ROUTES:
            if tuple(args[: len(prefix)]) == prefix:
                return getattr(self, handler)(args, kw)
        raise AssertionError(args)

    def rev_parse(self, args, kw):
        return str(self.root / ".git") if "--git-common-dir" in args else self.main

    def fetch(self, args, kw):
        return ""

    def repo_view(self, args, kw):
        return "test/repo"

    def pr_view(self, args, kw):
        return json.dumps({"state": "MERGED", "baseRefName": "main", "mergeCommit": {"oid": SHA}})

    def probe(self, args, kw):
        return json.dumps(snapshot() if self.deployed else snapshot("c" * 40))

    def run_list(self, args, kw):
        if self.mode == "metadata-error":
            raise module.DeploymentError("metadata unavailable")
        if self.mode == "none":
            return json.dumps([])
        return json.dumps(
            [
                {
                    "databaseId": 1,
                    "headSha": SHA,
                    "status": "in_progress" if self.mode == "active" else "completed",
                    "conclusion": "success" if self.mode == "success" else "failure",
                }
            ]
        )

    def run_jobs(self, args, kw):
        jobs = {
            "unavailable": [
                {
                    "name": "test",
                    "status": "completed",
                    "conclusion": "failure",
                    "runner_id": 0,
                    "steps": [],
                }
            ],
            "unavailable-with-skipped": unavailable_jobs(),
        }.get(
            self.mode,
            [
                {
                    "name": "test",
                    "runner_id": 1,
                    "steps": [{"name": "test", "conclusion": "failure"}],
                }
            ],
        )
        return json.dumps({"jobs": jobs, "total_count": len(jobs)})

    def show_fallback(self, args, kw):
        return "# exact merged fallback source\n"

    def build(self, args, kw):
        assert Path(args[1]).read_text() == "# exact merged fallback source\n"
        assert args[2:] == ["--ref", SHA] and kw.get("live") is True
        self.deployed = True
        return ""


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


def executable(path, text):
    path.write_text("#!/bin/bash\nset -eu\n" + text)
    path.chmod(0o755)


class WrapperTests(unittest.TestCase):
    def build_world(self, d, mode):
        """A canonical repo, a worktree holding the wrapper, and fake ship/gh/git tools; returns (root, work, env)."""
        root = d / "repo"
        work = d / "worktree"
        tools = d / "tools/ci/ship"
        bin = d / "bin"
        for x in [root / ".git", root / "scripts", work, tools, bin]:
            x.mkdir(parents=True, exist_ok=True)
        (work / "pr-ship.sh").write_text((ROOT / ".claude/scripts/pr-ship.sh").read_text())
        (root / "scripts/post-ship-deploy.py").write_text(
            "raise Exception('dirty checkout executed')"
        )
        executable(
            tools / "ship.sh",
            'printf "%s\\n" "$*" > "$CALLS"; [ "$MODE" != failed ] || exit 7; [ "$MODE" = dry ] || rm -rf "$WORK"',
        )
        executable(
            bin / "gh",
            'if [ "$1 $2" = "repo view" ]; then echo test/repo; else printf "%s" "$SHA"; fi',
        )
        executable(
            bin / "git",
            'case "$1" in rev-parse) echo "$CANONICAL/.git";; fetch) :;; show) cat "$BLOB";; *) exit 1;; esac',
        )
        blob = d / "blob.py"
        config = d / "config/agent-tools"
        config.mkdir(parents=True)
        (config / "env").write_text("export HYPERCAL_BUN_BIN=/synthetic/pinned-bun\n")
        blob.write_text(
            'import os,sys,json\nprint(json.dumps({"cwd":os.getcwd(),"args":sys.argv[1:],"bun":os.environ.get("HYPERCAL_BUN_BIN")}))\n'
        )
        env = {
            **os.environ,
            "PATH": str(bin) + os.pathsep + os.environ["PATH"],
            "AGENT_TOOLS_ROOT": str(d / "tools"),
            "XDG_CONFIG_HOME": str(d / "config"),
            "CALLS": str(d / "calls"),
            "MODE": mode,
            "WORK": str(work),
            "SHA": SHA,
            "CANONICAL": str(root),
            "BLOB": str(blob),
        }
        return root, work, env

    def run_wrapper(self, work, env, mode):
        args = ["bash", str(work / "pr-ship.sh"), "42"] + (["--dry-run"] if mode == "dry" else [])
        if mode == "cross-repo":
            args += ["--repo", "other/repo"]
        if mode == "cross-repo-equals":
            args += ["--repo=other/repo"]
        return subprocess.run(
            args, cwd=work, env=env, text=True, capture_output=True, timeout=10, check=False
        )

    def check_delegated(self, mode, out, d, root, work):
        self.assertEqual(out.returncode, 7 if mode == "failed" else 0, out.stderr)
        self.assertEqual(
            (d / "calls").read_text().strip(),
            "42 --dry-run" if mode == "dry" else "42",
        )
        if mode != "normal":
            self.assertEqual(out.stdout, "")
            return
        self.assertEqual(json.loads(out.stdout)["cwd"], str(root.resolve()))
        self.assertFalse(work.exists())
        self.assertEqual(json.loads(out.stdout)["bun"], "/synthetic/pinned-bun")

    def test_delegation_and_exact_merged_code_survive_worktree_removal(self):
        for mode in ["normal", "dry", "failed", "cross-repo", "cross-repo-equals"]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as tmp:
                d = Path(tmp)
                root, work, env = self.build_world(d, mode)
                out = self.run_wrapper(work, env, mode)
                if mode.startswith("cross-repo"):
                    self.assertEqual(out.returncode, 2, out.stderr)
                    self.assertFalse((d / "calls").exists())
                else:
                    self.check_delegated(mode, out, d, root, work)


class RemoteProbeHostTests(unittest.TestCase):
    """The probe runs on the odroid and must follow PUBLIC_DOMAIN, not a host baked into the script (#828)."""

    def probe_urls(self, env_text):
        with tempfile.TemporaryDirectory() as tmp:
            deploy = Path(tmp)
            if env_text is not None:
                (deploy / ".env").write_text(env_text)
            seen = []

            class Reply:
                def __enter__(self):
                    return self

                def __exit__(self, *args):
                    return False

                def read(self, size):
                    return b"ok"

            def fake_urlopen(url, timeout):
                seen.append(url)
                return Reply()

            inspect = "sha256:" + "b" * 64 + "|true|" + SHA
            with (
                unittest.mock.patch.object(sys, "argv", ["probe", str(deploy)]),
                unittest.mock.patch("subprocess.check_output", return_value=inspect),
                unittest.mock.patch("urllib.request.urlopen", fake_urlopen),
                unittest.mock.patch("builtins.print"),
            ):
                probe = Path(tmp) / "probe.py"
                probe.write_text(module.REMOTE_PROBE)
                runpy.run_path(str(probe))
            return seen

    def test_probe_uses_the_public_domain_from_the_deploy_env_file(self):
        urls = self.probe_urls("BOT_TOKEN=x\nPUBLIC_DOMAIN=hypercal.mextner.com\n")
        self.assertEqual(
            urls,
            ["https://hypercal.mextner.com/health", "https://hypercal.mextner.com/ready"],
        )

    def test_probe_takes_the_last_assignment_and_drops_an_inline_comment(self):
        urls = self.probe_urls(
            'PUBLIC_DOMAIN=hypercal.invntrm.ru\nPUBLIC_DOMAIN="hypercal.mextner.com" # prod\n'
        )
        self.assertEqual(
            urls,
            ["https://hypercal.mextner.com/health", "https://hypercal.mextner.com/ready"],
        )

    def test_probe_strips_single_quotes_around_the_host(self):
        urls = self.probe_urls("PUBLIC_DOMAIN='hypercal.mextner.com'\n")
        self.assertEqual(
            urls,
            ["https://hypercal.mextner.com/health", "https://hypercal.mextner.com/ready"],
        )

    def test_probe_falls_back_to_the_local_port_without_a_public_domain(self):
        for env_text in (None, "BOT_TOKEN=x\n", "PUBLIC_DOMAIN=\n"):
            with self.subTest(env=env_text):
                self.assertEqual(
                    self.probe_urls(env_text),
                    ["http://127.0.0.1:3001/health", "http://127.0.0.1:3001/ready"],
                )

    def test_no_retired_host_is_baked_into_the_script(self):
        self.assertNotIn("invntrm", module.REMOTE_PROBE)
        self.assertNotIn("invntrm", (ROOT / "scripts/post-ship-deploy.py").read_text())


class Scripted:
    """Answers commands that start with a registered prefix; anything else goes to `fallback`.

    A reply is a str, an exception to raise, or a callable (args, kw) -> str.
    """

    def __init__(self, fallback=None):
        self.fallback = fallback
        self.rules = []
        self.calls = []

    def on(self, prefix, reply):
        self.rules.append((tuple(prefix), reply))
        return self

    def __call__(self, args, cwd, **kw):
        for prefix, reply in self.rules:
            if tuple(args[: len(prefix)]) == prefix:
                self.calls.append((args, kw))
                return self.answer(reply, args, kw)
        if self.fallback is None:
            raise AssertionError(args)
        self.calls.append((args, kw))
        return self.fallback(args, cwd, **kw)

    @staticmethod
    def answer(reply, args, kw):
        if isinstance(reply, BaseException):
            raise reply
        return reply(args, kw) if callable(reply) else reply


def in_order(*replies):
    """A reply that answers its successive calls with `replies` in turn."""
    queue = list(replies)
    return lambda args, kw: Scripted.answer(queue.pop(0), args, kw)


def completed(conclusion="failure", **fields):
    return {
        "databaseId": 7,
        "headSha": SHA,
        "status": "completed",
        "conclusion": conclusion,
        **fields,
    }


class HostedActionDecisionTests(unittest.TestCase):
    """Every branch of the hosted-run classification, each refusing for its own stated reason."""

    def action(self, workflow, jobs=None):
        return module.hosted_action(workflow, jobs)

    def refuses(self, reason, workflow, jobs=None):
        with self.assertRaisesRegex(module.DeploymentError, reason):
            self.action(workflow, jobs)

    def failed_run(self, jobs):
        return self.action({"status": "completed", "conclusion": "failure"}, jobs)

    def job(self, **fields):
        return {
            "status": "completed",
            "conclusion": "failure",
            "runner_id": 0,
            "steps": [],
            **fields,
        }

    def test_no_workflow_means_local(self):
        self.assertEqual(self.action(None), "local")

    def test_non_object_workflow_is_invalid_metadata(self):
        for workflow in ["x", [], 5, False]:
            with self.subTest(workflow=workflow):
                self.refuses("invalid workflow metadata", workflow)

    def test_unfinished_runs_are_pending_whatever_the_jobs_say(self):
        for status in ["queued", "in_progress", "waiting", "requested", "pending"]:
            with self.subTest(status=status):
                self.assertEqual(
                    self.action({"status": status, "conclusion": "failure"}, "ignored"),
                    "hosted_pending",
                )

    def test_unknown_status_is_refused(self):
        for workflow in [{}, {"status": None}, {"status": "stale"}, {"status": "COMPLETED"}]:
            with self.subTest(workflow=workflow):
                self.refuses("unknown workflow state", workflow)

    def test_completed_success_is_hosted_success(self):
        self.assertEqual(
            self.action({"status": "completed", "conclusion": "success"}), "hosted_success"
        )

    def test_other_conclusions_and_unusable_job_lists_do_not_establish_unavailability(self):
        good = [self.job()]
        for conclusion in [None, "cancelled", "timed_out", "neutral"]:
            with self.subTest(conclusion=conclusion):
                self.refuses(
                    "workflow did not establish runner unavailability",
                    {"status": "completed", "conclusion": conclusion},
                    good,
                )
        for jobs in [None, [], "jobs", {"jobs": good}, 0]:
            with self.subTest(jobs=jobs):
                self.refuses(
                    "workflow did not establish runner unavailability",
                    {"status": "completed", "conclusion": "failure"},
                    jobs,
                )

    def test_malformed_jobs_are_invalid_metadata(self):
        malformed = {
            "not an object": "x",
            "steps not a list": self.job(steps=None),
            "not completed": self.job(status="in_progress"),
            "no status": {"conclusion": "failure", "runner_id": 0, "steps": []},
            "no runner_id key": {"status": "completed", "conclusion": "failure", "steps": []},
        }
        for label, job in malformed.items():
            with self.subTest(label):
                self.refuses(
                    "invalid job metadata", {"status": "completed", "conclusion": "failure"}, [job]
                )

    def test_jobs_that_ran_steps_or_hold_a_runner_name_forbid_the_override(self):
        for label, job in {
            "steps ran": self.job(steps=[{"name": "x"}]),
            "named runner": self.job(runner_name="odroid"),
            "steps on a skipped job": self.job(
                conclusion="skipped", runner_id=None, steps=[{"name": "x"}]
            ),
        }.items():
            with self.subTest(label):
                self.refuses(
                    "hosted executable steps ran",
                    {"status": "completed", "conclusion": "failure"},
                    [job],
                )

    def test_empty_or_missing_runner_name_does_not_count_as_a_runner(self):
        for name in [None, ""]:
            self.assertEqual(self.failed_run([self.job(runner_name=name)]), "local")

    def test_only_known_runner_less_shapes_pass(self):
        refused = {
            "skipped on a real runner": self.job(conclusion="skipped", runner_id=5),
            "skipped with false runner": self.job(conclusion="skipped", runner_id=False),
            "failure without runner key value": self.job(runner_id=None),
            "failure on a real runner": self.job(runner_id=3),
            "success": self.job(conclusion="success"),
            "cancelled": self.job(conclusion="cancelled", runner_id=None),
            "failure with string zero": self.job(runner_id="0"),
        }
        for label, job in refused.items():
            with self.subTest(label):
                self.refuses(
                    "job did not establish runner unavailability",
                    {"status": "completed", "conclusion": "failure"},
                    [job],
                )

    def test_skipped_jobs_alone_never_establish_unavailability(self):
        skipped = self.job(conclusion="skipped", runner_id=None)
        for jobs in [[skipped], [skipped, dict(skipped, runner_id=0)]]:
            with self.subTest(jobs=len(jobs)):
                self.refuses(
                    "skipped jobs alone", {"status": "completed", "conclusion": "failure"}, jobs
                )

    def test_a_failed_runner_less_job_among_skipped_ones_means_local(self):
        skipped = self.job(conclusion="skipped", runner_id=None)
        self.assertEqual(self.failed_run([skipped, self.job(), skipped]), "local")

    def test_every_job_is_checked_even_after_the_proof_was_found(self):
        self.refuses(
            "invalid job metadata",
            {"status": "completed", "conclusion": "failure"},
            [self.job(), {"runner_id": 0}],
        )
        self.refuses(
            "hosted executable steps ran",
            {"status": "completed", "conclusion": "failure"},
            [self.job(), self.job(steps=[{"name": "x"}])],
        )


class InspectHostedTests(unittest.TestCase):
    """Fetching the hosted run: retries, identity checks, and the jobs lookup for failed runs."""

    NAME = "test/repo"
    RUNS = ("gh", "run", "list")
    JOBS = ("gh", "api")

    def inspect(self, call, sleeps=None):
        pause = (lambda seconds: sleeps.append(seconds)) if sleeps is not None else (lambda _: None)
        return module.inspect_hosted(Path("/repo"), self.NAME, SHA, call, pause)

    def runs(self, *replies):
        return Scripted().on(self.RUNS, in_order(*replies))

    def jobs_payload(self, jobs, total=None):
        return json.dumps({"jobs": jobs, "total_count": len(jobs) if total is None else total})

    def test_lists_the_latest_ci_run_for_the_commit(self):
        call = self.runs(json.dumps([completed("success")]))
        self.assertEqual(self.inspect(call), "hosted_success")
        args, _kw = call.calls[0]
        self.assertEqual(
            args,
            [
                "gh",
                "run",
                "list",
                "--repo",
                self.NAME,
                "--workflow",
                "CI/CD",
                "--commit",
                SHA,
                "--limit",
                "1",
                "--json",
                "databaseId,headSha,status,conclusion",
            ],
        )
        self.assertEqual(len(call.calls), 1)

    def test_a_run_that_has_not_appeared_is_retried_twice_then_means_local(self):
        sleeps = []
        call = self.runs("[]", "[]", "[]")
        self.assertEqual(self.inspect(call, sleeps), "local")
        self.assertEqual(len(call.calls), 3)
        self.assertEqual(sleeps, [5, 5])

    def test_a_run_appearing_on_a_retry_is_used(self):
        sleeps = []
        call = self.runs("[]", json.dumps([completed("success")]))
        self.assertEqual(self.inspect(call, sleeps), "hosted_success")
        self.assertEqual(len(call.calls), 2)
        self.assertEqual(sleeps, [5])

    def test_a_non_list_collection_is_refused_without_retrying(self):
        sleeps = []
        for payload in ["{}", '"x"', "null", "5"]:
            with (
                self.subTest(payload=payload),
                self.assertRaisesRegex(module.DeploymentError, "invalid workflow collection"),
            ):
                self.inspect(self.runs(payload), sleeps)
        self.assertEqual(sleeps, [])

    def test_undecodable_and_oversized_metadata_are_refused(self):
        with self.assertRaisesRegex(module.DeploymentError, "invalid deployment metadata"):
            self.inspect(self.runs("not json"))
        with self.assertRaisesRegex(module.DeploymentError, "oversized deployment metadata"):
            self.inspect(self.runs("[" + " " * 2_000_001 + "]"))

    def test_a_run_for_another_commit_is_refused(self):
        for workflow in [
            "x",
            {"headSha": "c" * 40, "status": "completed", "conclusion": "success"},
            {"status": "completed"},
        ]:
            with (
                self.subTest(workflow=workflow),
                self.assertRaisesRegex(module.DeploymentError, "workflow SHA mismatch"),
            ):
                self.inspect(self.runs(json.dumps([workflow])))

    def test_only_completed_failures_fetch_jobs(self):
        for workflow, expected in [
            (completed("success"), "hosted_success"),
            ({**completed(None), "status": "in_progress"}, "hosted_pending"),
            ({**completed("failure"), "status": "in_progress"}, "hosted_pending"),
        ]:
            with self.subTest(workflow=workflow):
                call = self.runs(json.dumps([workflow]))
                self.assertEqual(self.inspect(call), expected)
                self.assertEqual(len(call.calls), 1)
        with self.assertRaisesRegex(
            module.DeploymentError, "did not establish runner unavailability"
        ):
            self.inspect(self.runs(json.dumps([completed("cancelled")])))

    def test_failed_run_jobs_are_fetched_by_run_id_and_decide_the_action(self):
        job = {"status": "completed", "conclusion": "failure", "runner_id": 0, "steps": []}
        call = self.runs(json.dumps([completed("failure", databaseId=99)])).on(
            self.JOBS, self.jobs_payload([job])
        )
        self.assertEqual(self.inspect(call), "local")
        self.assertEqual(
            call.calls[1][0], ["gh", "api", "repos/test/repo/actions/runs/99/jobs?per_page=100"]
        )
        ran = dict(job, steps=[{"name": "x"}], runner_id=4)
        call = self.runs(json.dumps([completed("failure")])).on(self.JOBS, self.jobs_payload([ran]))
        with self.assertRaisesRegex(module.DeploymentError, "hosted executable steps ran"):
            self.inspect(call)

    def test_failed_run_needs_a_positive_integer_run_id(self):
        for run_id in [None, 0, -1, True, "7", 1.0]:
            with self.subTest(run_id=run_id):
                call = self.runs(json.dumps([completed("failure", databaseId=run_id)]))
                with self.assertRaisesRegex(
                    module.DeploymentError, "invalid workflow run identifier"
                ):
                    self.inspect(call)
                self.assertEqual(len(call.calls), 1)

    def test_incomplete_job_listings_are_refused(self):
        job = {"status": "completed", "conclusion": "failure", "runner_id": 0, "steps": []}
        cases = {
            "payload is a list": ("[]", "incomplete job metadata"),
            "no total_count": (json.dumps({"jobs": [job]}), "incomplete job metadata"),
            "boolean total_count": (
                json.dumps({"jobs": [job], "total_count": True}),
                "incomplete job metadata",
            ),
            "more than one page": (self.jobs_payload([job], total=101), "incomplete job metadata"),
            "jobs not a list": (
                json.dumps({"jobs": {}, "total_count": 0}),
                "incomplete job collection",
            ),
            "jobs missing": (json.dumps({"total_count": 0}), "incomplete job collection"),
            "jobs shorter than total": (
                self.jobs_payload([job], total=2),
                "incomplete job collection",
            ),
        }
        for label, (payload, reason) in cases.items():
            with self.subTest(label):
                call = self.runs(json.dumps([completed("failure")])).on(self.JOBS, payload)
                with self.assertRaisesRegex(module.DeploymentError, reason):
                    self.inspect(call)

    def test_a_listing_of_exactly_one_hundred_jobs_is_accepted(self):
        job = {"status": "completed", "conclusion": "skipped", "runner_id": None, "steps": []}
        failed = dict(job, conclusion="failure", runner_id=0)
        jobs = [failed] + [job] * 99
        call = self.runs(json.dumps([completed("failure")])).on(self.JOBS, self.jobs_payload(jobs))
        self.assertEqual(self.inspect(call), "local")

    def test_command_failures_propagate(self):
        with self.assertRaisesRegex(module.DeploymentError, "gh command failed"):
            self.inspect(self.runs(module.DeploymentError("gh command failed (1)")))


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


if __name__ == "__main__":
    unittest.main()
