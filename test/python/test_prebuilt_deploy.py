"""Execute the real remote shell with fake Docker/HTTP; preserve real SQLite writes."""

import hashlib
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


MIGRATIONS = "export const migrations = [\n  {\n    name: '001_x',\n    up(db){},\n  },\n];\n"
NEW_MIGRATION_ADDED = MIGRATIONS.removesuffix("];\n") + "  {\n    name: '002_new_thing',\n    up(db){},\n  },\n];\n"
EXISTING_MIGRATION_EDITED = "export const migrations = [\n  {\n    name: '001_x',\n    up(db){ doSomethingElse(); },\n  },\n];\n"


def migration_doc(name, rollback="yes", deletion="no", body="Creates a table.\n"):
    front = f"---\nmigration: {name}\nrollback-compatible: {rollback}\ndata-deletion: {deletion}\n---\n"
    return f"{front}\n# Migration {name}\n\n{body}"


SAFE_DOC = migration_doc("002_new_thing")
RISKY_DOC = migration_doc("002_new_thing", rollback="no", body="Drops a column.\n\n## Rollback\n\nRestore the backup.\n")
DELETING_DOC = migration_doc("002_new_thing", deletion="yes", body="Deletes rows.\n")


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def docs(**contents):
    return json.dumps({name + ".md": text for name, text in contents.items()})


REVIEWED_PAIR = sha(MIGRATIONS) + ":" + sha(NEW_MIGRATION_ADDED)


class DeployTests(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        self.dep = self.path / "deploy"
        self.src = self.dep / (".incoming-" + SHA + "-123-1")
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
        c.execute("CREATE TABLE migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)")
        c.execute("INSERT INTO migrations(name) VALUES ('001_x')")
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
import io,os,json,re,sys,sqlite3,tarfile
from pathlib import Path
DEFAULT_MIGRATION_CONTENT="export const migrations = [\n  {\n    name: '001_x',\n    up(db){},\n  },\n];\n"
args=sys.argv[1:];root=Path(os.environ['FIXTURE_DEP']);current=root/'current'
with open(os.environ['FIXTURE_LOG'],'a') as f:f.write(json.dumps(args)+'\n')
old_content=os.environ.get('OLD_MIGRATION_CONTENT',DEFAULT_MIGRATION_CONTENT)
new_content=os.environ.get('NEW_MIGRATION_CONTENT',DEFAULT_MIGRATION_CONTENT)
def names(text):return re.findall(r"name: '(\w+)'",text)
def recorded(failure):
    # The database's applied migrations, as the real read-only bun query prints them.
    if os.environ.get(failure)=='1':sys.exit(1)
    c=sqlite3.connect(root/'data/calendar.db');rows=[r[0] for r in c.execute('SELECT name FROM migrations ORDER BY id')];c.close()
    print(''.join(n+'\n' for n in rows),end='')
if args and args[0]=='load' and os.environ.get('LOAD_FAILURE')=='1':sys.exit(42)
if args and args[0]=='tag' and args[-1].endswith(':latest') and os.environ.get('TAG_FAILURE')=='1':sys.exit(43)
if args[:2]==['image','inspect']:
    fmt=args[-1]
    print(os.environ['FIXTURE_ID'] if '.Id' in fmt else os.environ['FIXTURE_SHA'])
elif args[:2]==['inspect','hypercal-bot']:print(current.read_text())
elif args[:3]==['exec','hypercal-bot','cat']:print(old_content,end='')
elif args[:3]==['exec','hypercal-bot','bun']:recorded('APPLIED_FAILURE')
elif args[:2] in (['stop','hypercal-bot'],['start','hypercal-bot']):pass
elif args and args[0]=='run':
    entrypoint=args[args.index('--entrypoint')+1] if '--entrypoint' in args else ''
    if entrypoint=='cat':print(new_content,end='')
    elif entrypoint=='bun' and '-v' in args:recorded('RECORDED_READ_FAILURE')
    elif entrypoint=='bun':
        # The migration names the release image's module actually exports.
        if os.environ.get('RELEASE_NAMES_FAILURE')=='1':sys.exit(1)
        print(os.environ.get('RELEASE_MIGRATION_NAMES',''.join(n+'\n' for n in names(new_content))),end='')
    elif entrypoint=='tar':
        buf=io.BytesIO()
        with tarfile.open(fileobj=buf,mode='w') as tar:
            folder=tarfile.TarInfo('migrations');folder.type=tarfile.DIRTYPE;tar.addfile(folder)
            for name,text in json.loads(os.environ.get('NEW_MIGRATION_DOCS','{}')).items():
                data=text.encode();info=tarfile.TarInfo('migrations/'+name);info.size=len(data);tar.addfile(info,io.BytesIO(data))
        sys.stdout.buffer.write(buf.getvalue())
    else:sys.exit(125)
elif args and args[0]=='compose' and 'up' in args:
    override=Path(args[args.index('-f',args.index('-f')+1)+1]).read_text() if args.count('-f') >= 2 else 'candidate'
    old='sha256:old' in override
    current.write_text('sha256:old' if old else os.environ['FIXTURE_ID'])
    if not old:
        # The release's migration runner records every new migration unless one of them fails.
        c=sqlite3.connect(root/'data/calendar.db');c.execute("INSERT INTO evidence VALUES ('after-start')")
        if os.environ.get('RELEASE_MIGRATION_FAILS')!='1':
            c.executemany("INSERT OR IGNORE INTO migrations(name) VALUES (?)",[(n,) for n in names(new_content)])
        c.commit();c.close()
""",
        )
        self.exe(
            self.bin / "curl",
            r"""#!/usr/bin/env python3
import os,sys
from pathlib import Path
restored=(Path(os.environ['FIXTURE_DEP'])/'current').read_text()=='sha256:old'
if 'ready' in sys.argv[-1]:
    body=os.environ.get('READY_BODY','ok');print(body,end='');sys.exit(22 if body=='ai chain down' else 0)
body=os.environ.get('RESTORED_HEALTH_BODY','ok') if restored else os.environ.get('HEALTH_BODY','ok')
if body=='unreachable':sys.exit(7)
print(body,end='')
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

    def run_deploy(self, staging_path=None, **changes):
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
                str(self.src if staging_path is None else staging_path),
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

    def record(self, *names):
        c = sqlite3.connect(self.db)
        c.executemany("INSERT INTO migrations(name) VALUES (?)", [(n,) for n in names])
        c.commit()
        c.close()

    def recorded(self):
        c = sqlite3.connect(self.db)
        try:
            return [r[0] for r in c.execute("SELECT name FROM migrations ORDER BY id")]
        finally:
            c.close()

    def rows(self):
        c = sqlite3.connect(self.db)
        try:
            return [r[0] for r in c.execute("SELECT value FROM evidence")]
        finally:
            c.close()

    def test_staging_root_cannot_be_deleted_on_validation_failure(self):
        result = self.run_deploy(staging_path=self.dep)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.dep.exists(), "Cleanup deleted the deployment root")
        self.assertTrue(self.db.exists())
        self.assertEqual(self.rows(), ["before"])
        self.assertFalse(self.log.exists())

    def test_staging_ancestor_cannot_be_deleted(self):
        result = self.run_deploy(staging_path=self.path)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.db.exists(), "Cleanup deleted an ancestor of the deployment root")
        self.assertFalse(self.log.exists())

    def test_staging_live_data_directory_is_not_owned_release_work(self):
        result = self.run_deploy(staging_path=self.dep / "data")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.db.exists(), "Cleanup deleted the live data directory")
        self.assertEqual(self.rows(), ["before"])
        self.assertFalse(self.log.exists())

    def test_staging_symlink_is_rejected_without_removing_it(self):
        alias = self.dep / (".incoming-" + SHA + "-124-1")
        alias.symlink_to(self.dep, target_is_directory=True)
        result = self.run_deploy(staging_path=alias)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(alias.is_symlink())
        self.assertTrue(self.db.exists())
        self.assertFalse(self.log.exists())

    def test_local_fallback_staging_namespace_remains_supported(self):
        stage = Path("/tmp") / ("hypercal-source-" + SHA[:12] + "-" + str(os.getpid()))
        stage.mkdir(exist_ok=False)
        self.addCleanup(shutil.rmtree, stage, True)
        shutil.copytree(self.src, stage, dirs_exist_ok=True)
        result = self.run_deploy(staging_path=stage)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.rows(), ["before", "after-start"])
        self.assertFalse(stage.exists())

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

    def assert_refused_before_backup_or_restart(self, result):
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Schema-changing release requires reviewed migration procedure", result.stderr)
        self.assertNotIn("SCHEMA_GATE decision=", result.stdout)
        self.assertFalse((self.dep / "data/before.db").exists(), "backup-db.sh ran before the gate refused")
        self.assertEqual(self.rows(), ["before"])
        self.assertNotIn('"compose"', self.log.read_text())

    def test_unchanged_migrations_log_the_gate_decision(self):
        result = self.run_deploy(HYPERCAL_REVIEWED_SCHEMA_TRANSITION="junk")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("SCHEMA_GATE decision=unchanged migrations_sha256=" + sha(MIGRATIONS), result.stdout)

    def test_new_migration_without_a_doc_is_refused_before_any_backup_or_restart(self):
        result = self.run_deploy(NEW_MIGRATION_CONTENT=NEW_MIGRATION_ADDED)
        self.assert_refused_before_backup_or_restart(result)
        self.assertIn("docs/reference/migrations/002_new_thing.md", result.stderr)

    def test_change_outside_the_migration_entries_is_refused(self):
        # A comment or statement above the array changes no entry. Nothing names it, so no doc
        # can vouch for it, alone or riding along with a documented new migration.
        for content, doc in [
            ("// updated comment\n" + MIGRATIONS, {}),
            ("globalThis.probe = 1;\n" + NEW_MIGRATION_ADDED, {"002_new_thing": SAFE_DOC}),
        ]:
            with self.subTest(content=content):
                self.setUp()
                result = self.run_deploy(NEW_MIGRATION_CONTENT=content, NEW_MIGRATION_DOCS=docs(**doc))
                self.assert_refused_before_backup_or_restart(result)
                self.assertIn("outside the migration entries", result.stderr)

    def test_documented_safe_new_migration_is_accepted_with_an_audit_line(self):
        result = self.run_deploy(
            NEW_MIGRATION_CONTENT=NEW_MIGRATION_ADDED,
            NEW_MIGRATION_DOCS=docs(**{"002_new_thing": SAFE_DOC}),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.rows(), ["before", "after-start"])
        self.assertIn(
            f"SCHEMA_GATE decision=automatic from={sha(MIGRATIONS)} to={sha(NEW_MIGRATION_ADDED)}"
            f" migration=002_new_thing doc=docs/reference/migrations/002_new_thing.md"
            f" doc_sha256={sha(SAFE_DOC)} rollback-compatible=yes data-deletion=no\n",
            result.stdout,
        )
        self.assertLess(result.stdout.index("SCHEMA_GATE"), result.stdout.index("DEPLOYED"))

    def test_empty_or_undeclared_doc_is_refused(self):
        for doc in ["", "# Migration 002\n\nAdds a table.\n", "rollback-compatible: yes\n"]:
            with self.subTest(doc=doc):
                self.setUp()
                result = self.run_deploy(
                    NEW_MIGRATION_CONTENT=NEW_MIGRATION_ADDED,
                    NEW_MIGRATION_DOCS=docs(**{"002_new_thing": doc}),
                )
                self.assert_refused_before_backup_or_restart(result)
                self.assertIn("002_new_thing", result.stderr)

    def test_risky_declaration_is_refused_without_the_reviewed_transition(self):
        # The full matrix of wrong pairs is covered in test_migration_gate.py; here the variable
        # travels through the real shell, unset and reversed.
        reversed_pair = sha(NEW_MIGRATION_ADDED) + ":" + sha(MIGRATIONS)
        for doc, reviewed in [(RISKY_DOC, None), (DELETING_DOC, reversed_pair)]:
            with self.subTest(doc=doc, reviewed=reviewed):
                self.setUp()
                changes = {} if reviewed is None else {"HYPERCAL_REVIEWED_SCHEMA_TRANSITION": reviewed}
                result = self.run_deploy(
                    NEW_MIGRATION_CONTENT=NEW_MIGRATION_ADDED,
                    NEW_MIGRATION_DOCS=docs(**{"002_new_thing": doc}),
                    **changes,
                )
                self.assert_refused_before_backup_or_restart(result)
                self.assertIn("002_new_thing", result.stderr)

    def test_exact_reviewed_transition_activates_a_risky_migration_and_says_so(self):
        result = self.run_deploy(
            NEW_MIGRATION_CONTENT=NEW_MIGRATION_ADDED,
            NEW_MIGRATION_DOCS=docs(**{"002_new_thing": DELETING_DOC}),
            HYPERCAL_REVIEWED_SCHEMA_TRANSITION=REVIEWED_PAIR,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(
            f"SCHEMA_GATE decision=reviewed-override from={sha(MIGRATIONS)} to={sha(NEW_MIGRATION_ADDED)}"
            f" migration=002_new_thing doc=docs/reference/migrations/002_new_thing.md"
            f" doc_sha256={sha(DELETING_DOC)} rollback-compatible=yes data-deletion=yes\n",
            result.stdout,
        )
        self.assertTrue((self.dep / "data/before.db").exists(), "backup-db.sh did not run")
        self.assertEqual(self.rows(), ["before", "after-start"])
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        rollback_tag = next(i for i, c in enumerate(calls) if c[0] == "tag" and "rollback-" in c[-1])
        switch = next(i for i, c in enumerate(calls) if c[0] == "compose" and "up" in c)
        self.assertLess(rollback_tag, switch)

    def test_new_migration_is_judged_by_the_database_not_the_running_image(self):
        # After an image-only rollback the database already records 002_new_thing while the
        # running image lacks it. The runner never re-runs a recorded migration, so the release's
        # (possibly edited) 002_new_thing and its doc describe code that will not run.
        self.record("002_new_thing")
        result = self.run_deploy(
            NEW_MIGRATION_CONTENT=NEW_MIGRATION_ADDED,
            NEW_MIGRATION_DOCS=docs(**{"002_new_thing": SAFE_DOC}),
        )
        self.assert_refused_before_backup_or_restart(result)
        self.assertRegex(result.stderr, "002_new_thing.*applied")

    def test_database_records_unknown_to_both_images_do_not_block_a_documented_migration(self):
        # Production records two names from a renumbering long ago that no image carries.
        self.record("000_renumbered_long_ago")
        result = self.run_deploy(
            NEW_MIGRATION_CONTENT=NEW_MIGRATION_ADDED,
            NEW_MIGRATION_DOCS=docs(**{"002_new_thing": SAFE_DOC}),
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_unreadable_applied_migrations_are_refused(self):
        result = self.run_deploy(
            NEW_MIGRATION_CONTENT=NEW_MIGRATION_ADDED,
            NEW_MIGRATION_DOCS=docs(**{"002_new_thing": SAFE_DOC}),
            APPLIED_FAILURE="1",
        )
        self.assert_refused_before_backup_or_restart(result)

    def test_concatenated_migration_name_is_refused_even_with_a_doc_for_its_prefix(self):
        content = MIGRATIONS.removesuffix("];\n") + "  {\n    name: '002' + '_drop_data',\n    up(db){},\n  },\n];\n"
        result = self.run_deploy(
            NEW_MIGRATION_CONTENT=content,
            NEW_MIGRATION_DOCS=docs(**{"002": migration_doc("002")}),
            RELEASE_MIGRATION_NAMES="001_x\n002_drop_data\n",
        )
        self.assert_refused_before_backup_or_restart(result)
        self.assertIn("002", result.stderr)

    def test_release_exporting_migrations_the_parser_did_not_see_is_refused(self):
        result = self.run_deploy(
            NEW_MIGRATION_CONTENT=NEW_MIGRATION_ADDED,
            NEW_MIGRATION_DOCS=docs(**{"002_new_thing": SAFE_DOC}),
            RELEASE_MIGRATION_NAMES="001_x\n002_new_thing\n003_hidden\n",
        )
        self.assert_refused_before_backup_or_restart(result)
        self.assertIn("003_hidden", result.stderr)

    def test_edit_to_an_already_shipped_migration_is_rejected(self):
        result = self.run_deploy(NEW_MIGRATION_CONTENT=EXISTING_MIGRATION_EDITED)
        self.assert_refused_before_backup_or_restart(result)
        self.assertIn("001_x", result.stderr)

    def test_documented_new_migration_does_not_vouch_for_a_silent_edit_riding_along(self):
        content = EXISTING_MIGRATION_EDITED.removesuffix("];\n") + (
            "  {\n    name: '002_new_thing',\n    up(db){},\n  },\n];\n"
        )
        result = self.run_deploy(
            NEW_MIGRATION_CONTENT=content,
            NEW_MIGRATION_DOCS=docs(**{"002_new_thing": SAFE_DOC}),
        )
        self.assert_refused_before_backup_or_restart(result)
        self.assertIn("001_x", result.stderr)

    def test_renaming_an_already_shipped_migration_is_rejected_even_with_a_doc(self):
        # A rename makes the old name vanish and a "new" name appear with the identical body.
        # Matching by name alone would treat this as a brand-new, documented migration and let
        # it through -- which would make the app's migration runner re-apply it under the new
        # name on every already-migrated database. It must be rejected regardless of a doc.
        renamed = "export const migrations = [\n  {\n    name: '001_x_renamed',\n    up(db){},\n  },\n];\n"
        result = self.run_deploy(
            NEW_MIGRATION_CONTENT=renamed,
            NEW_MIGRATION_DOCS=docs(**{"001_x_renamed": migration_doc("001_x_renamed")}),
        )
        self.assert_refused_before_backup_or_restart(result)
        self.assertIn("001_x", result.stderr)

    def test_deleting_an_already_shipped_migration_outright_is_rejected(self):
        self.record("002_new_thing")
        result = self.run_deploy(OLD_MIGRATION_CONTENT=NEW_MIGRATION_ADDED, NEW_MIGRATION_CONTENT=MIGRATIONS)
        self.assert_refused_before_backup_or_restart(result)
        self.assertIn("002_new_thing", result.stderr)

    def test_rollback_reports_the_restored_bot_healthy(self):
        result = self.run_deploy(READY_BODY="ai chain down")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ROLLBACK image=sha256:old health=ok", result.stderr)
        self.assertNotIn("ROLLBACK FAILED", result.stderr)

    def test_rollback_to_an_unhealthy_old_image_fails_loudly(self):
        for body in ["unreachable", "<html>ok</html>"]:
            with self.subTest(body=body):
                self.setUp()
                result = self.run_deploy(READY_BODY="ai chain down", RESTORED_HEALTH_BODY=body)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual((self.dep / "current").read_text(), "sha256:old")
                self.assertIn("ROLLBACK FAILED", result.stderr)
                self.assertEqual(self.rows(), ["before", "after-start"])

    def run_failing_release(self, doc, **changes):
        # The release verifies unhealthy (every AI provider down) after the gate accepted doc.
        return self.run_deploy(
            NEW_MIGRATION_CONTENT=NEW_MIGRATION_ADDED,
            NEW_MIGRATION_DOCS=docs(**{"002_new_thing": doc}),
            HYPERCAL_REVIEWED_SCHEMA_TRANSITION=REVIEWED_PAIR,
            READY_BODY="ai chain down",
            **changes,
        )

    def test_failed_release_with_a_compatible_migration_restores_the_old_image(self):
        result = self.run_failing_release(DELETING_DOC)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("002_new_thing", self.recorded())
        self.assertIn("ROLLBACK image=sha256:old health=ok", result.stderr)
        self.assertEqual((self.dep / "current").read_text(), "sha256:old")

    def test_failed_release_whose_incompatible_migration_ran_stays_in_place(self):
        result = self.run_failing_release(RISKY_DOC)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ROLLBACK_SKIPPED", result.stderr)
        self.assertIn("002_new_thing", result.stderr)
        self.assertNotIn("ROLLBACK image=", result.stderr)
        self.assertEqual((self.dep / "current").read_text(), self.config_id)
        self.assertEqual(self.rows(), ["before", "after-start"])
        self.assertFalse((self.dep / "releases/current.json").exists())
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertEqual([c[0] for c in calls if c[0] in ("stop", "start")], ["stop", "start"])

    def test_failed_release_whose_incompatible_migration_did_not_commit_restores_the_old_image(self):
        result = self.run_failing_release(RISKY_DOC, RELEASE_MIGRATION_FAILS="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("002_new_thing", self.recorded())
        self.assertIn("ROLLBACK image=sha256:old health=ok", result.stderr)
        self.assertEqual((self.dep / "current").read_text(), "sha256:old")

    def test_failed_release_is_left_in_place_when_the_database_cannot_be_read(self):
        result = self.run_failing_release(RISKY_DOC, RELEASE_MIGRATION_FAILS="1", RECORDED_READ_FAILURE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ROLLBACK_SKIPPED", result.stderr)
        self.assertEqual((self.dep / "current").read_text(), self.config_id)

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
