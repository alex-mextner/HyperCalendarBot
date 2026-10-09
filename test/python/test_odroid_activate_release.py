"""Run the real odroid root activation wrapper against a fake runner workspace.

The wrapper's fixed paths (runner work root, deploy path, PATH) are rewritten to
temporary directories in a copy; everything else runs as installed. The release's
own scripts/deploy-prebuilt-image.sh is replaced by a recorder, except in the
namespace test, which runs the real activator up to its release lock.
"""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
WRAPPER = ROOT / "scripts/odroid-activate-release.sh"
SHA = "a" * 40
SUM = "b" * 64
CONFIG = "sha256:" + "c" * 64
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


class ActivateReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.work = self.tmp / "work"
        self.deploy = self.tmp / "deploy"
        self.record = self.tmp / "record"
        self.bin = self.tmp / "bin"
        for directory in (self.deploy, self.record, self.bin):
            directory.mkdir()
        self.release = self.work / "HyperCalendarBot/HyperCalendarBot/release"
        (self.release / "scripts").mkdir(parents=True)
        self.expected = workflow_release_files() | {"image.tar.gz", "artifact.json"}
        for name in self.expected:
            (self.release / name).write_text("release file " + name + "\n")
        self.activator_exit = 0
        self.write_recorder()
        self.wrapper = self.tmp / "hypercal-activate-release"
        text = WRAPPER.read_text()
        for old, new in (
            ("readonly WORK_ROOT=/var/lib/hcb-runner/actions-runner/_work\n", f"readonly WORK_ROOT={self.work}\n"),
            ("readonly DEPLOY_PATH=/opt/hypercal\n", f"readonly DEPLOY_PATH={self.deploy}\n"),
            (f"readonly SAFE_PATH={SAFE_PATH}\n", f"readonly SAFE_PATH={self.bin}:{SAFE_PATH}\n"),
        ):
            self.assertEqual(text.count(old), 1, old)
            text = text.replace(old, new)
        self.wrapper.write_text(text)
        self.wrapper.chmod(0o755)

    def write_recorder(self, exit_code=0):
        recorder = self.release / "scripts/deploy-prebuilt-image.sh"
        recorder.write_text(
            "#!/bin/bash\n"
            f"python3 - \"$@\" > {self.record}/run.json <<'PY'\n"
            "import json, os, stat, sys\n"
            "stage = sys.argv[2]\n"
            "files = {}\n"
            "for top, dirs, names in os.walk(stage):\n"
            "    for name in dirs + names:\n"
            "        path = os.path.join(top, name)\n"
            "        info = os.lstat(path)\n"
            "        files[os.path.relpath(path, stage)] = {\n"
            "            'mode': stat.S_IMODE(info.st_mode),\n"
            "            'regular': stat.S_ISREG(info.st_mode),\n"
            "            'text': open(path).read() if stat.S_ISREG(info.st_mode) else None,\n"
            "        }\n"
            "print(json.dumps({'args': sys.argv[1:], 'stage_mode': stat.S_IMODE(os.lstat(stage).st_mode),\n"
            "                  'files': files, 'env': dict(os.environ)}))\n"
            "PY\n"
            f"exit {exit_code}\n"
        )
        self.expected_recorder_text = recorder.read_text()

    def run_wrapper(self, *args, env=None):
        arguments = list(args) if args else [str(self.release), SHA, SUM, CONFIG]
        return subprocess.run(
            [str(self.wrapper), *arguments],
            env=dict(os.environ, **(env or {})),
            text=True,
            capture_output=True,
            timeout=30,
        )

    def recorded(self):
        path = self.record / "run.json"
        return json.loads(path.read_text()) if path.exists() else None

    def leftover_stages(self):
        return sorted(p.name for p in self.deploy.iterdir() if p.name.startswith(".incoming-"))

    def test_stages_exactly_the_uploaded_release_root_only_and_cleans_up(self):
        (self.release / "unexpected.sh").write_text("not part of the release\n")
        (self.release / "scripts/unexpected.sh").write_text("not part of the release\n")
        result = self.run_wrapper(env={"HYPERCAL_REVIEWED_SCHEMA_TRANSITION": "x:y"})
        self.assertEqual(result.returncode, 0, result.stderr)
        run = self.recorded()
        deploy_path, stage, image, sha, archive_sum, config = run["args"]
        self.assertEqual((deploy_path, image, sha, archive_sum, config), (str(self.deploy), IMAGE, SHA, SUM, CONFIG))
        self.assertEqual(Path(stage).parent, self.deploy)
        self.assertRegex(Path(stage).name, r"^\.incoming-" + SHA + r"-\d+-\d+$")
        self.assertEqual(run["stage_mode"], 0o700)
        files = run["files"]
        self.assertEqual({name for name, f in files.items() if f["regular"]}, self.expected)
        self.assertEqual(set(files) - self.expected, {"scripts"})
        self.assertEqual(files["scripts"]["mode"], 0o700)
        for name in self.expected:
            self.assertEqual(files[name]["mode"], 0o600, name)
            if name != "scripts/deploy-prebuilt-image.sh":
                self.assertEqual(files[name]["text"], "release file " + name + "\n")
        self.assertEqual(files["scripts/deploy-prebuilt-image.sh"]["text"], self.expected_recorder_text)
        # The activator never inherits the caller's environment, so no schema override reaches it.
        self.assertNotIn("HYPERCAL_REVIEWED_SCHEMA_TRANSITION", run["env"])
        self.assertEqual(self.leftover_stages(), [])

    def test_missing_artifact_json_is_allowed_because_the_activator_rewrites_it(self):
        (self.release / "artifact.json").unlink()
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("artifact.json", self.recorded()["files"])

    def test_activator_failure_code_propagates_and_stage_is_removed(self):
        self.write_recorder(exit_code=17)
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 17)
        self.assertIsNotNone(self.recorded())
        self.assertEqual(self.leftover_stages(), [])

    def test_rejects_unsafe_arguments_before_staging(self):
        outside = self.tmp / "outside/release"
        shutil.copytree(self.release, outside)
        linked = self.work / "linked-release"
        linked.symlink_to(self.release, target_is_directory=True)
        (self.work / "linked-parent").symlink_to(self.release.parent, target_is_directory=True)
        cases = {
            "relative": ["work/HyperCalendarBot/HyperCalendarBot/release", SHA, SUM, CONFIG],
            "dot-dot": [str(self.work / "HyperCalendarBot/../HyperCalendarBot/HyperCalendarBot/release"), SHA, SUM, CONFIG],
            "outside work root": [str(outside), SHA, SUM, CONFIG],
            "symlinked release": [str(linked), SHA, SUM, CONFIG],
            "symlinked parent": [str(self.work / "linked-parent/release"), SHA, SUM, CONFIG],
            "not a directory": [str(self.release / "Caddyfile"), SHA, SUM, CONFIG],
            "short sha": [str(self.release), SHA[:12], SUM, CONFIG],
            "uppercase sum": [str(self.release), SHA, SUM.upper(), CONFIG],
            "bare config digest": [str(self.release), SHA, SUM, CONFIG.removeprefix("sha256:")],
            "extra argument": [str(self.release), SHA, SUM, CONFIG, "--force"],
        }
        for label, arguments in cases.items():
            with self.subTest(label):
                result = self.run_wrapper(*arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(self.recorded())
                self.assertEqual(self.leftover_stages(), [])

    def test_rejects_symlinked_special_or_missing_release_files(self):
        secret = self.tmp / "secret"
        secret.write_text("root-only data\n")

        def symlink_image():
            (self.release / "image.tar.gz").unlink()
            (self.release / "image.tar.gz").symlink_to(secret)

        def symlink_script():
            (self.release / "scripts/backup-db.sh").unlink()
            (self.release / "scripts/backup-db.sh").symlink_to(secret)

        def symlink_scripts_dir():
            shutil.move(self.release / "scripts", self.tmp / "scripts")
            (self.release / "scripts").symlink_to(self.tmp / "scripts", target_is_directory=True)

        def fifo_compose():
            (self.release / "docker-compose.yml").unlink()
            os.mkfifo(self.release / "docker-compose.yml")

        def missing_caddyfile():
            (self.release / "Caddyfile").unlink()

        for change in (symlink_image, symlink_script, symlink_scripts_dir, fifo_compose, missing_caddyfile):
            with self.subTest(change.__name__):
                shutil.rmtree(self.release)
                (self.release / "scripts").mkdir(parents=True)
                for name in self.expected:
                    (self.release / name).write_text("release file " + name + "\n")
                self.write_recorder()
                shutil.rmtree(self.tmp / "scripts", ignore_errors=True)
                change()
                result = self.run_wrapper()
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(self.recorded())
                self.assertEqual(self.leftover_stages(), [])

    def test_stage_name_passes_the_real_activator_ownership_guard(self):
        shutil.copy(ROOT / "scripts/deploy-prebuilt-image.sh", self.release / "scripts/deploy-prebuilt-image.sh")
        # A held release lock stops the real activator right after its staging guard.
        flock = self.bin / "flock"
        flock.write_text("#!/bin/sh\nexit 1\n")
        flock.chmod(0o755)
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 1)
        self.assertIn("Another release owns this service", result.stderr)
        self.assertNotIn("no cleanup armed", result.stderr)
        self.assertEqual(self.leftover_stages(), [])


if __name__ == "__main__":
    unittest.main()
