"""Execute the real remote shell with fake Docker/HTTP; preserve real SQLite writes."""

import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SHA = "a" * 40
TAG = "repo/image:" + SHA


class DeployTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        self.dep = self.path / "deploy"
        self.src = self.path / "incoming"
        self.bin = self.path / "bin"
        for d in [
            self.dep / "scripts",
            self.dep / "data",
            self.src / "scripts",
            self.bin,
        ]:
            d.mkdir(parents=True)
        for d in [self.dep, self.src]:
            (d / "docker-compose.yml").write_text(
                "name: fixture\nservices:\n  bot:\n    image: old:latest\n"
            )
            (d / "Caddyfile").write_text("fixture config")
        self.db = self.dep / "data/calendar.db"
        c = sqlite3.connect(self.db)
        c.execute("CREATE TABLE evidence(value TEXT)")
        c.execute("INSERT INTO evidence VALUES ('before')")
        c.commit()
        c.close()
        self.exe(
            self.dep / "scripts/backup-db.sh",
            "#!/bin/sh\ncp data/calendar.db data/before.db\n",
        )
        for name in ["backup-db.sh", "healthcheck-alert.sh", "prepare-runtime-dirs.sh"]:
            self.exe(self.src / "scripts" / name, "#!/bin/sh\nexit 0\n")
        shutil.copy(
            ROOT / "scripts/release-artifact.py",
            self.src / "scripts/release-artifact.py",
        )
        config = json.dumps(
            {
                "architecture": "amd64",
                "os": "linux",
                "config": {"Labels": {"org.opencontainers.image.revision": SHA}},
            }
        ).encode()
        self.config_id = "sha256:" + hashlib.sha256(config).hexdigest()
        cfg = "blobs/sha256/" + self.config_id[7:]
        manifest = [{"Config": cfg, "RepoTags": [TAG], "Layers": []}]
        with tarfile.open(self.src / "image.tar.gz", "w:gz") as tar:
            for name, data in [
                ("manifest.json", json.dumps(manifest).encode()),
                (cfg, config),
            ]:
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
        self.digest = hashlib.sha256(
            (self.src / "image.tar.gz").read_bytes()
        ).hexdigest()
        (self.dep / "current").write_text("sha256:old")
        self.log = self.path / "calls.jsonl"
        self.exe(self.bin / "flock", "#!/bin/sh\nexit ${LOCK_FAILURE:-0}\n")
        self.exe(self.bin / "caddy", "#!/bin/sh\nexit 0\n")
        self.exe(self.bin / "uname", "#!/bin/sh\nprintf 'x86_64\\n'\n")
        self.exe(self.bin / "seq", "#!/bin/sh\nprintf '1\\n'\n")
        self.exe(self.bin / "sleep", "#!/bin/sh\nexit 0\n")
        self.exe(
            self.bin / "sha256sum",
            "#!/usr/bin/env python3\nimport hashlib,sys\nprint(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest()+'  '+sys.argv[1])\n",
        )
        self.exe(
            self.bin / "docker",
            r"""#!/usr/bin/env python3
import os,json,sys,sqlite3
from pathlib import Path
args=sys.argv[1:];root=Path(os.environ['FIXTURE_DEP']);current=root/'current'
with open(os.environ['FIXTURE_LOG'],'a') as f:f.write(json.dumps(args)+'\n')
if args and args[0]=='load' and os.environ.get('LOAD_FAILURE')=='1':sys.exit(42)
if args and args[0]=='tag' and args[-1].endswith(':latest') and os.environ.get('TAG_FAILURE')=='1':sys.exit(43)
if args[:2]==['image','inspect']:
    fmt=args[-1]
    print(os.environ['FIXTURE_ID'] if '.Id' in fmt else os.environ['FIXTURE_SHA'])
elif args[:2]==['inspect','hypercal-bot']:print(current.read_text())
elif args and args[0]=='exec':print('same-schema  /app/src/database/migrations.ts')
elif args and args[0]=='run':print(os.environ.get('NEW_SCHEMA','same-schema')+'  /app/src/database/migrations.ts')
elif args and args[0]=='compose' and 'up' in args:
    override=Path(args[args.index('-f',args.index('-f')+1)+1]).read_text() if args.count('-f') >= 2 else 'candidate'
    old='sha256:old' in override
    current.write_text('sha256:old' if old else os.environ['FIXTURE_ID'])
    if not old:
        c=sqlite3.connect(root/'data/calendar.db');c.execute("INSERT INTO evidence VALUES ('after-start')");c.commit();c.close()
""",
        )
        self.exe(
            self.bin / "curl",
            r"""#!/usr/bin/env python3
import os,sys
if 'ready' in sys.argv[-1]:
    body=os.environ.get('READY_BODY','ok');print(body,end='');sys.exit(22 if body=='ai chain down' else 0)
print(os.environ.get('HEALTH_BODY','ok'),end='')
""",
        )
        self.remote = ROOT / "scripts/deploy-prebuilt-image.sh"
        baseline = os.environ.get("HCB_TEST_DEPLOY_SCRIPT")
        if baseline:
            text = Path(baseline).read_text()
            self.remote = self.path / "baseline-remote.sh"
            self.remote.write_text(
                text.split("<<'REMOTE'\n", 1)[1].split("\nREMOTE\n", 1)[0]
            )

    def exe(self, path, body):
        path.write_text(body)
        path.chmod(0o755)

    def run_deploy(self, **changes):
        env = dict(
            os.environ,
            PATH=str(self.bin) + ":" + os.environ["PATH"],
            FIXTURE_DEP=str(self.dep),
            FIXTURE_LOG=str(self.log),
            FIXTURE_ID=self.config_id,
            FIXTURE_SHA=SHA,
        )
        env.update(changes)
        return subprocess.run(
            [
                "bash",
                str(self.remote),
                str(self.dep),
                str(self.src),
                "repo/image",
                SHA,
                self.digest,
                self.config_id,
            ],
            cwd=self.dep,
            env=env,
            text=True,
            capture_output=True,
            timeout=15,
        )

    def rows(self):
        c = sqlite3.connect(self.db)
        try:
            return [r[0] for r in c.execute("SELECT value FROM evidence")]
        finally:
            c.close()

    def test_success_pins_verified_config_and_writes_receipt(self):
        result = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads((self.dep / "releases/current.json").read_text())
        self.assertEqual(receipt["config_digest"], self.config_id)
        self.assertEqual(receipt["revision"], SHA)
        self.assertEqual(self.rows(), ["before", "after-start"])
        calls = self.log.read_text()
        self.assertNotIn('"build"', calls)
        self.assertIn("--no-build", calls)

    def test_ai_outage_rolls_back_image_without_losing_later_user_writes(self):
        result = self.run_deploy(READY_BODY="ai chain down")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.dep / "current").read_text(), "sha256:old")
        self.assertEqual(self.rows(), ["before", "after-start"])
        self.assertIn("ROLLBACK", result.stderr)
        self.assertFalse((self.dep / "releases/current.json").exists())

    def test_proxy_html_is_not_a_healthy_bot(self):
        result = self.run_deploy(HEALTH_BODY="<html>ok</html>")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.dep / "current").read_text(), "sha256:old")

    def test_schema_change_is_rejected_before_any_restart(self):
        result = self.run_deploy(NEW_SCHEMA="different")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.rows(), ["before"])
        self.assertNotIn('"compose"', self.log.read_text())

    def test_corrupt_transfer_is_rejected_before_load(self):
        with (self.src / "image.tar.gz").open("ab") as f:
            f.write(b"corrupt")
        result = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.log.exists())

    def test_another_deploy_lock_prevents_changes(self):
        result = self.run_deploy(LOCK_FAILURE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.rows(), ["before"])
        self.assertFalse(self.log.exists())

    def test_failed_alias_update_does_not_undo_a_verified_release(self):
        result = self.run_deploy(TAG_FAILURE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.dep / "current").read_text(), self.config_id)
        self.assertTrue((self.dep / "releases/current.json").exists())
        self.assertNotIn("ROLLBACK", result.stderr)

    def test_receipt_failure_does_not_restore_old_image_after_verification(self):
        (self.dep / "releases/current.json.tmp").mkdir(parents=True)
        result = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.dep / "current").read_text(), self.config_id)
        self.assertEqual(self.rows(), ["before", "after-start"])
        self.assertNotIn("ROLLBACK", result.stderr)

    def test_image_load_failure_never_restarts_the_service(self):
        result = self.run_deploy(LOAD_FAILURE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.dep / "current").read_text(), "sha256:old")
        self.assertNotIn('"compose"', self.log.read_text())


if __name__ == "__main__":
    unittest.main()
