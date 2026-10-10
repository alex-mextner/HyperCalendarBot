"""Run the real scripts/deploy-local-fallback.sh against a fake remote host.

`ssh`/`scp` run the remote commands locally, Docker is a fake that builds nothing
but saves a valid arm64 docker-save archive, and the remote activator is the real
scripts/deploy-prebuilt-image.sh from the exact git archive, stopped right after its
staging guard by a held release lock. The odroid's /tmp is a small RAM tmpfs, so the
stage must live on the deploy path in the activator's release namespace.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
IMAGE = "ghcr.io/alex-mextner/hypercalendarbot"


def exe(path, body):
    path.write_text(body)
    path.chmod(0o755)


class LocalFallbackStagingTests(unittest.TestCase):
    def setUp(self):
        # Paths must match the fallback's DEPLOY_PATH rule ^/[a-zA-Z0-9_/-]+$.
        self.tmp = Path(tempfile.mkdtemp(prefix="hcbfallback")).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.deploy = self.tmp / "deploy"
        self.deploy.mkdir()
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.record = self.tmp / "record"
        self.record.mkdir()
        self.local_tmp = self.tmp / "localtmp"
        self.local_tmp.mkdir()
        self.git_env = dict(
            os.environ,
            GIT_AUTHOR_NAME="Fixture",
            GIT_AUTHOR_EMAIL="fixture@example.invalid",
            GIT_COMMITTER_NAME="Fixture",
            GIT_COMMITTER_EMAIL="fixture@example.invalid",
        )
        origin = self.tmp / "origin.git"
        self.checkout = self.tmp / "checkout"
        self.git("init", "-q", "--bare", "-b", "main", str(origin), cwd=self.tmp)
        self.git("clone", "-q", str(origin), str(self.checkout), cwd=self.tmp)
        (self.checkout / "scripts").mkdir()
        for name in ("deploy-local-fallback.sh", "deploy-prebuilt-image.sh", "release-artifact.py", "migration-gate.py"):
            shutil.copy(ROOT / "scripts" / name, self.checkout / "scripts" / name)
        self.git("add", "-A", cwd=self.checkout)
        self.git("commit", "-q", "-m", "fixture", cwd=self.checkout)
        self.git("push", "-q", "origin", "HEAD:main", cwd=self.checkout)
        self.sha = self.git("rev-parse", "HEAD", cwd=self.checkout).strip()
        self.write_fakes()

    def git(self, *args, cwd):
        # The developer's global hooks (review gate, pre-push) do not apply to a fixture repo.
        return subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", *args],
            cwd=cwd, env=self.git_env, check=True, capture_output=True, text=True,
        ).stdout

    def write_fakes(self):
        record = self.record
        exe(
            self.bin / "ssh",
            "#!/bin/bash\n"
            "# ssh [-o opt]... host command...: run the command here, as ssh would there.\n"
            "while [[ $1 == -* ]]; do shift 2; done\n"
            "shift\n"
            f"printf '%s\\n' \"$*\" >> {record}/ssh.log\n"
            "if [[ $1 == bash ]]; then\n"
            "  stage=\"$4\"\n"
            "  python3 -c 'import json,os,stat,sys; s=sys.argv[1]; "
            "print(json.dumps({\"mode\": stat.S_IMODE(os.lstat(s).st_mode), "
            "\"entries\": sorted(os.listdir(s))}))' \"$stage\" "
            f"> {record}/stage.json\n"
            "fi\n"
            "exec bash -c \"$*\"\n",
        )
        exe(
            self.bin / "scp",
            "#!/bin/bash\n"
            "while [[ $1 == -* ]]; do [[ $1 == -q ]] && shift || shift 2; done\n"
            "cp \"$1\" \"${2#*:}\"\n",
        )
        # A held release lock stops the real activator right after its staging guard.
        exe(self.bin / "flock", "#!/bin/sh\nexit 1\n")
        exe(
            self.bin / "docker",
            "#!/usr/bin/env python3\n"
            "import json, sys, tarfile\n"
            "sys.dont_write_bytecode = True\n"
            f"sys.path.insert(0, {str(Path(__file__).resolve().parent)!r})\n"
            "from docker_save_fixture import add_members, docker_save_members\n"
            "args = sys.argv[1:]\n"
            "if args[:2] == ['context', 'inspect']:\n"
            "    print('unix:///var/run/docker.sock'); sys.exit(0)\n"
            "if args[:1] == ['--context']:\n"
            "    args = args[2:]\n"
            f"state = '{record}/build.json'\n"
            "if args[:1] == ['version']:\n"
            "    sys.exit(0)\n"
            "if args[:1] == ['build']:\n"
            "    platform = args[args.index('--platform') + 1]\n"
            "    label = args[args.index('--label') + 1]\n"
            "    tag = args[args.index('-t') + 1]\n"
            "    json.dump({'platform': platform, 'label': label, 'tag': tag}, open(state, 'w')); sys.exit(0)\n"
            "if args[:1] == ['save']:\n"
            "    built = json.load(open(state))\n"
            "    os_name, arch = built['platform'].split('/')\n"
            "    key, value = built['label'].split('=', 1)\n"
            "    config = json.dumps({'architecture': arch, 'os': os_name, 'config': {'Labels': {key: value}}}).encode()\n"
            "    members, _ = docker_save_members(args[1], config)\n"
            "    with tarfile.open(fileobj=sys.stdout.buffer, mode='w|') as out:\n"
            "        add_members(out, members)\n"
            "    sys.exit(0)\n"
            "sys.exit(f'unexpected docker call: {args}')\n",
        )

    def run_fallback(self):
        return subprocess.run(
            ["bash", str(self.checkout / "scripts/deploy-local-fallback.sh"), "--ref", "origin/main", "--skip-tests"],
            cwd=self.checkout,
            env=dict(
                self.git_env,
                PATH=f"{self.bin}:{os.environ['PATH']}",
                TMPDIR=str(self.local_tmp),
                HYPERCAL_DEPLOY_HOST="root@fixture",
                HYPERCAL_DEPLOY_PATH=str(self.deploy),
                HYPERCAL_BUILD_BACKEND="docker",
                HYPERCAL_DOCKER_BIN=str(self.bin / "docker"),
            ),
            text=True,
            capture_output=True,
            timeout=60,
        )

    def test_stage_is_a_private_release_directory_on_the_deploy_path(self):
        result = self.run_fallback()
        # The held lock ends the run after the guard; a rejected stage would say "no cleanup armed".
        self.assertIn("Another release owns this service", result.stderr)
        self.assertNotIn("no cleanup armed", result.stderr)
        self.assertNotEqual(result.returncode, 0)
        built = json.loads((self.record / "build.json").read_text())
        self.assertEqual(built["platform"], "linux/arm64")
        activations = [line for line in (self.record / "ssh.log").read_text().splitlines() if line.startswith("bash ")]
        self.assertEqual(len(activations), 1)
        _, script, deploy_path, stage, image, sha, archive_sum, config = activations[0].split(" ")
        self.assertEqual((deploy_path, image, sha), (str(self.deploy), IMAGE, self.sha))
        self.assertEqual(Path(stage).parent, self.deploy)
        self.assertRegex(Path(stage).name, r"^\.incoming-" + self.sha + r"-\d+-\d+$")
        self.assertEqual(script, stage + "/scripts/deploy-prebuilt-image.sh")
        self.assertRegex(archive_sum, r"^[0-9a-f]{64}$")
        self.assertRegex(config, r"^sha256:[0-9a-f]{64}$")
        staged = json.loads((self.record / "stage.json").read_text())
        self.assertEqual(staged["mode"], 0o700)
        self.assertIn("image.tar.gz", staged["entries"])
        self.assertIn("scripts", staged["entries"])
        # Nothing is left behind on the host: not on the deploy path, not in /tmp.
        self.assertEqual(sorted(p.name for p in self.deploy.iterdir() if p.name.startswith(".incoming-")), [])
        self.assertFalse(any(Path("/tmp").glob("hypercal-source-" + self.sha[:12] + "-*")))


if __name__ == "__main__":
    unittest.main()
