import json
import os
import runpy
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

from post_ship_deploy_support import (
    ROOT,
    SHA,
    executable,
    module,
)


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
