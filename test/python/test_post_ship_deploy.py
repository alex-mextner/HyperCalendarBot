import importlib.util, json, os, signal, subprocess, sys, tempfile, time, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "post_ship_deploy", ROOT / "scripts/post-ship-deploy.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
SHA = "a" * 40
IMAGE = "sha256:" + "b" * 64


def snapshot(sha=SHA, image=IMAGE, ready="ok"):
    return {
        "receipt": {"revision": sha, "config_digest": image},
        "revision": sha,
        "image": image,
        "running": True,
        "health": "ok",
        "ready": ready,
    }


class FakeCommands:
    def __init__(self, root, mode="none", already=False):
        self.root = root
        self.mode = mode
        self.deployed = already
        self.calls = []
        self.main = SHA

    def __call__(self, args, cwd, **kw):
        self.calls.append((args, kw))
        if args[:2] == ["git", "rev-parse"]:
            return str(self.root / ".git") if "--git-common-dir" in args else self.main
        if args[:2] == ["git", "fetch"]:
            return ""
        if args[:3] == ["gh", "repo", "view"]:
            return "test/repo"
        if args[:3] == ["gh", "pr", "view"]:
            return json.dumps(
                {"state": "MERGED", "baseRefName": "main", "mergeCommit": {"oid": SHA}}
            )
        if args[0] == "ssh":
            return json.dumps(snapshot() if self.deployed else snapshot("c" * 40))
        if args[:3] == ["gh", "run", "list"]:
            if self.mode == "metadata-error":
                raise module.DeploymentError("metadata unavailable")
            return json.dumps(
                []
                if self.mode == "none"
                else [
                    {
                        "databaseId": 1,
                        "headSha": SHA,
                        "status": "in_progress"
                        if self.mode == "active"
                        else "completed",
                        "conclusion": "success"
                        if self.mode == "success"
                        else "failure",
                    }
                ]
            )
        if args[:2] == ["gh", "api"]:
            jobs = (
                [{"name": "test", "runner_id": 0, "steps": []}]
                if self.mode == "unavailable"
                else [
                    {
                        "name": "test",
                        "runner_id": 1,
                        "steps": [{"name": "test", "conclusion": "failure"}],
                    }
                ]
            )
            return json.dumps({"jobs": jobs, "total_count": len(jobs)})
        if args[:2] == ["git", "show"]:
            return "# exact merged fallback source\n"
        if args[0] == "bash":
            assert Path(args[1]).read_text() == "# exact merged fallback source\n"
            assert args[2:] == ["--ref", SHA] and kw.get("live") is True
            self.deployed = True
            return ""
        raise AssertionError(args)


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

    def test_identical_verified_release_is_noop(self):
        fake = FakeCommands(self.root, already=True)
        self.assertEqual(self.invoke(fake)["state"], "already_deployed")
        self.assertFalse(
            any(a[0] == "bash" or a[:3] == ["gh", "run", "list"] for a, k in fake.calls)
        )

    def test_verified_fallback_uses_merged_blob_and_full_local_gate(self):
        for mode in ["none", "unavailable"]:
            fake = FakeCommands(self.root, mode)
            self.assertEqual(self.invoke(fake)["state"], "verified")
            self.assertTrue(any(a[0] == "bash" for a, k in fake.calls))

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
            module.hosted_action(
                {"status": "completed", "conclusion": "failure"}, [{"steps": []}]
            )

    def test_annotation_cannot_authorize_override(self):
        job = {
            "steps": [{"name": "test", "conclusion": "failure"}],
            "runner_id": 123,
            "message": "recent account payments have failed",
        }
        with self.assertRaises(module.DeploymentError):
            module.hosted_action(
                {"status": "completed", "conclusion": "failure"}, [job]
            )

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
                return json.dumps(
                    {"state": "MERGED", "baseRefName": "main", "mergeCommit": None}
                )
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
            json.loads((self.root / ".git/post-ship-release.json").read_text())[
                "state"
            ],
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


class WrapperTests(unittest.TestCase):
    def test_delegation_and_exact_merged_code_survive_worktree_removal(self):
        for mode in ["normal", "dry", "failed", "cross-repo", "cross-repo-equals"]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as tmp:
                d = Path(tmp)
                root = d / "repo"
                work = d / "worktree"
                tools = d / "tools/ci/ship"
                bin = d / "bin"
                for x in [root / ".git", root / "scripts", work, tools, bin]:
                    x.mkdir(parents=True, exist_ok=True)
                wrapper = work / "pr-ship.sh"
                wrapper.write_text((ROOT / ".claude/scripts/pr-ship.sh").read_text())
                (root / "scripts/post-ship-deploy.py").write_text(
                    "raise Exception('dirty checkout executed')"
                )

                def exe(path, text):
                    path.write_text("#!/bin/bash\nset -eu\n" + text)
                    path.chmod(0o755)

                exe(
                    tools / "ship.sh",
                    'printf "%s\\n" "$*" > "$CALLS"; [ "$MODE" != failed ] || exit 7; [ "$MODE" = dry ] || rm -rf "$WORK"',
                )
                exe(
                    bin / "gh",
                    'if [ "$1 $2" = "repo view" ]; then echo test/repo; else printf "%s" "$SHA"; fi',
                )
                exe(
                    bin / "git",
                    'case "$1" in rev-parse) echo "$CANONICAL/.git";; fetch) :;; show) cat "$BLOB";; *) exit 1;; esac',
                )
                blob = d / "blob.py"
                config = d / "config/agent-tools"
                config.mkdir(parents=True)
                (config / "env").write_text(
                    "export HYPERCAL_BUN_BIN=/synthetic/pinned-bun\n"
                )
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
                args = ["bash", str(wrapper), "42"] + (
                    ["--dry-run"] if mode == "dry" else []
                )
                if mode == "cross-repo":
                    args += ["--repo", "other/repo"]
                if mode == "cross-repo-equals":
                    args += ["--repo=other/repo"]
                out = subprocess.run(
                    args, cwd=work, env=env, text=True, capture_output=True, timeout=10
                )
                if mode.startswith("cross-repo"):
                    self.assertEqual(out.returncode, 2, out.stderr)
                    self.assertFalse((d / "calls").exists())
                    continue
                self.assertEqual(
                    out.returncode, 7 if mode == "failed" else 0, out.stderr
                )
                self.assertEqual(
                    (d / "calls").read_text().strip(),
                    "42 --dry-run" if mode == "dry" else "42",
                )
                if mode == "normal":
                    self.assertEqual(json.loads(out.stdout)["cwd"], str(root.resolve()))
                    self.assertFalse(work.exists())
                    self.assertEqual(
                        json.loads(out.stdout)["bun"], "/synthetic/pinned-bun"
                    )
                else:
                    self.assertEqual(out.stdout, "")


if __name__ == "__main__":
    unittest.main()
