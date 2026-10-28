"""Static script checks and the stage QA installer.

Shared fixtures live in odroid_stage_qa_support.py."""

import os
import shutil
import stat
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from odroid_stage_qa_support import (
    ENTRY,
    INSTALLER,
    LIB_FILES,
    RUN,
    HeldLock,
    rewrite,
)


class StaticChecks(unittest.TestCase):
    def test_scripts_are_strict_bash(self):
        for script in (ENTRY, RUN, INSTALLER):
            with self.subTest(script=script.name):
                lines = script.read_text().splitlines()
                self.assertEqual(lines[0], "#!/usr/bin/env bash")
                self.assertIn("set -euo pipefail", lines)
                self.assertIn("umask 077", lines)
                subprocess.run(["bash", "-n", str(script)], check=True)

    def test_scripts_ignore_sigpipe(self):
        for script in (ENTRY, RUN):
            self.assertIn("trap '' PIPE", script.read_text(), script.name)

    def test_entry_has_no_environment_override_hooks(self):
        for script in (ENTRY, RUN, INSTALLER):
            text = script.read_text()
            self.assertNotRegex(text, r"\$\{(HYPERCAL|STAGE|ODROID)_[A-Z_]*:-", script.name)
            self.assertNotIn("export TOKEN", text)


class Installer(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.src = self.tmp / "checkout"
        (self.src / "scripts").mkdir(parents=True)
        self.lib = self.tmp / "usr/lib/hypercal-stage"
        self.entry_path = self.tmp / "usr/sbin/hypercal-stage-qa"
        self.entry_path.parent.mkdir(parents=True)
        self.lib.parent.mkdir(parents=True)
        self.lock = self.tmp / "stage.lock"
        self.write_checkout("one")
        self.git("init", "-q", "-b", "main")
        self.commit("initial")
        self.publish()
        self.script = self.make_script()

    def make_script(self, euid=None):
        uid, gid = os.getuid(), os.getgid()
        text = rewrite(
            INSTALLER.read_text(),
            [
                (
                    "readonly LIB_DIR=/usr/local/lib/hypercal-stage\n",
                    f"readonly LIB_DIR={self.lib}\n",
                ),
                (
                    "readonly ENTRY_PATH=/usr/local/sbin/hypercal-stage-qa\n",
                    f"readonly ENTRY_PATH={self.entry_path}\n",
                ),
                (
                    "readonly REQUIRED_EUID=0\n",
                    f"readonly REQUIRED_EUID={uid if euid is None else euid}\n",
                ),
                ("readonly INSTALL_OWNER=root:root\n", f"readonly INSTALL_OWNER={uid}:{gid}\n"),
                (
                    "readonly STAGE_LOCK_FILE=/run/lock/hypercal-stage.lock\n",
                    f"readonly STAGE_LOCK_FILE={self.lock}\n",
                ),
                ("readonly STAGE_LOCK_WAIT=60\n", "readonly STAGE_LOCK_WAIT=1\n"),
            ],
        )
        script = self.tmp / "install-stage-qa.sh"
        script.write_text(text)
        script.chmod(0o755)
        return script

    def source_path(self, name):
        if name == "docker-compose.stage.yml":
            return self.src / name
        if name == "odroid-stage-qa.sh":
            return self.src / "scripts" / name
        return self.src / "scripts" / name

    def write_checkout(self, version):
        for name in [*LIB_FILES, "odroid-stage-qa.sh"]:
            path = self.source_path(name)
            path.write_text(f"# {name} {version}\n")
            path.chmod(0o755 if name.endswith((".sh", ".py")) else 0o644)

    def git(self, *args):
        subprocess.run(
            ["git", "-C", str(self.src), "-c", "user.name=t", "-c", "user.email=t@t", *args],
            check=True,
            capture_output=True,
        )

    def publish(self):
        """Point origin/main at HEAD, as a fetch of the reviewed main would."""
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")

    def commit(self, message):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)

    def install(self, *args):
        return subprocess.run(
            [str(self.script), *(args or (str(self.src),))],
            capture_output=True,
            text=True,
            env={"PATH": "/usr/bin:/bin"},
            timeout=60,
            check=False,
        )

    def test_fresh_install_copies_exactly_the_lib_files_and_the_entry(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(p.name for p in self.lib.iterdir()), sorted(LIB_FILES))
        for name in LIB_FILES:
            self.assertEqual((self.lib / name).read_text(), f"# {name} one\n")
        self.assertEqual((self.entry_path).read_text(), "# odroid-stage-qa.sh one\n")
        self.assertEqual(stat.S_IMODE(self.entry_path.stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE(self.lib.stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE((self.lib / "stage-qa-run.sh").stat().st_mode), 0o755)
        self.assertEqual(
            stat.S_IMODE((self.lib / "docker-compose.stage.yml").stat().st_mode), 0o644
        )
        self.assertEqual(
            [p.name for p in self.lib.parent.iterdir() if ".new" in p.name or ".bak" in p.name], []
        )

    def test_cwd_is_the_default_checkout(self):
        result = subprocess.run(
            [str(self.script)],
            cwd=self.src,
            capture_output=True,
            text=True,
            env={"PATH": "/usr/bin:/bin"},
            timeout=60,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.lib / "stage-qa-run.sh").is_file())

    def test_reinstall_backs_up_and_prints_a_rollback_that_restores(self):
        self.assertEqual(self.install().returncode, 0)
        self.write_checkout("two")
        self.commit("second")
        self.publish()
        time.sleep(1.1)
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.lib / "stage-qa-run.sh").read_text(), "# stage-qa-run.sh two\n")
        self.assertEqual(self.entry_path.read_text(), "# odroid-stage-qa.sh two\n")
        lib_backups = sorted(
            p for p in self.lib.parent.iterdir() if p.name.startswith(self.lib.name + ".bak-")
        )
        entry_backups = sorted(
            p
            for p in self.entry_path.parent.iterdir()
            if p.name.startswith(self.entry_path.name + ".bak-")
        )
        self.assertEqual((len(lib_backups), len(entry_backups)), (1, 1))
        self.assertRegex(lib_backups[0].name, r"\.bak-\d{8}T\d{6}Z$")
        self.assertEqual(
            (lib_backups[0] / "stage-qa-run.sh").read_text(), "# stage-qa-run.sh one\n"
        )
        self.assertEqual(entry_backups[0].read_text(), "# odroid-stage-qa.sh one\n")
        rollback = next(
            line for line in result.stdout.splitlines() if line.startswith("rollback: ")
        )
        self.assertIn(lib_backups[0].name, rollback)
        subprocess.run(
            ["bash", "-c", rollback[len("rollback: ") :]], check=True, capture_output=True
        )
        self.assertEqual((self.lib / "stage-qa-run.sh").read_text(), "# stage-qa-run.sh one\n")
        self.assertEqual(self.entry_path.read_text(), "# odroid-stage-qa.sh one\n")

    def test_missing_listed_file_is_refused_and_nothing_is_installed(self):
        (self.src / "scripts" / "deploy-evidence.py").unlink()
        self.commit("remove")
        self.publish()
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("deploy-evidence.py", result.stderr)
        self.assertFalse(self.lib.exists())
        self.assertFalse(self.entry_path.exists())

    def test_dirty_checkout_is_refused_and_the_old_install_stays(self):
        self.assertEqual(self.install().returncode, 0)
        (self.src / "scripts" / "stage-qa-run.sh").write_text("# locally edited\n")
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("uncommitted", result.stderr)
        self.assertEqual((self.lib / "stage-qa-run.sh").read_text(), "# stage-qa-run.sh one\n")

    def test_untracked_listed_file_counts_as_dirty(self):
        path = self.src / "scripts" / "log-retention.py"
        self.git("rm", "-q", "--cached", "scripts/log-retention.py")
        self.assertTrue(path.exists())
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("uncommitted", result.stderr)

    def test_checkout_without_origin_main_is_refused(self):
        self.git("update-ref", "-d", "refs/remotes/origin/main")
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("checkout of main", result.stderr)
        self.assertFalse(self.lib.exists())
        self.assertFalse(self.entry_path.exists())

    def test_head_that_is_not_on_origin_main_is_refused_with_no_override(self):
        self.write_checkout("unreviewed")
        self.commit("local only, never merged")
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not on origin/main", result.stderr)
        self.assertFalse(self.lib.exists())
        self.assertNotIn("override", (result.stdout + result.stderr).lower())

    def test_head_behind_origin_main_is_accepted(self):
        old = subprocess.run(
            ["git", "-C", str(self.src), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=False,
        ).stdout.strip()
        self.write_checkout("two")
        self.commit("second")
        self.publish()
        self.git("checkout", "-q", old)
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.lib / "stage-qa-run.sh").read_text(), "# stage-qa-run.sh one\n")

    def test_non_git_directory_is_refused(self):
        shutil.rmtree(self.src / ".git")
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("git checkout", result.stderr)
        self.assertFalse(self.lib.exists())

    def test_non_root_caller_is_refused(self):
        if os.getuid() == 0:
            self.skipTest("running as root")
        script = self.make_script(euid=0)
        result = subprocess.run(
            [str(script), str(self.src)],
            capture_output=True,
            text=True,
            env={"PATH": "/usr/bin:/bin"},
            timeout=60,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("root", result.stderr)
        self.assertFalse(self.lib.exists())

    def test_an_active_stage_run_blocks_the_install(self):
        self.assertEqual(self.install().returncode, 0)
        held = HeldLock(self.lock)
        self.addCleanup(held.release)
        self.write_checkout("two")
        self.commit("second")
        self.publish()
        result = self.install()
        self.assertEqual(result.returncode, 75, result.stderr)
        self.assertEqual((self.lib / "stage-qa-run.sh").read_text(), "# stage-qa-run.sh one\n")
        self.assertEqual(
            [p.name for p in self.lib.parent.iterdir() if ".bak" in p.name or ".new" in p.name], []
        )

    def test_lib_file_list_matches_the_contract(self):
        text = INSTALLER.read_text()
        for name in LIB_FILES:
            self.assertIn(name, text)


if __name__ == "__main__":
    unittest.main()
