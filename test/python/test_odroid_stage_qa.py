"""Run outcomes, bot env/database and not-provisioned behavior of the stage QA root scripts.

Shared fixtures live in odroid_stage_qa_support.py."""

import gzip
import json
import re
import stat
import time
import unittest
from pathlib import Path

from odroid_stage_qa_support import (
    ALLOWED_KEYS,
    FAKE_TOKEN,
    GUARD_JSON,
    PROD_BOT_TOKEN,
    SHA,
    STAGE_BOT_TOKEN,
    STAGE_IMAGE,
    StageWorld,
    close_stdin,
    lock_is_free,
)


class RunOutcomes(StageWorld):
    def test_pass_runs_everything_in_order_and_leaves_evidence(self):
        result = self.run_entry()
        self.assertOutcome(result, 0, "passed")
        order = [
            "fetch-fetch",
            "fetch-current",
            "docker-load",
            "prepare-dirs",
            "compose-up",
            "health",
            "guard",
            "evidence release-logs",
            "compose-down",
            "docker-rmi",
        ]
        indexes = [self.index_of(prefix) for prefix in order]
        self.assertEqual(indexes, sorted(indexes), self.events())
        self.assertFalse(self.has_event("evidence failed"))
        self.assertFalse((self.stage / "receipts").exists())
        self.assertTrue(
            (self.stage / "evidence" / f"release-stage-{SHA[:12]}" / "container.log").is_file()
        )
        self.assertTornDown()
        self.assertNoSecrets(result)

    def test_stdout_is_the_ready_line_then_the_result_line(self):
        result = self.run_entry()
        lines = result.stdout.strip().splitlines()
        self.assertEqual(len(lines), 2, result.stdout)
        self.assertTrue(lines[0].startswith("STAGE_READY {"))
        self.assertTrue(lines[1].startswith("STAGE_QA_RESULT "))

    def test_ready_line_carries_the_guard_data_and_comes_before_any_teardown(self):
        process = self.popen(done=False)
        ready = self.ready(process)
        self.assertEqual(
            ready,
            {
                "sha": SHA,
                "username": "hypercal_stage_bot",
                "peer": "7654321",
                "cases": GUARD_JSON["cases"],
                "base_cases": 5,
            },
        )
        self.assertFalse(self.has_event("compose-down"))
        self.assertFalse(self.has_event(f"docker-rmi {STAGE_IMAGE}:" + SHA))
        self.assertFalse(self.has_event("evidence"))
        self.assertFalse(lock_is_free(self.stage_lock))
        self.assertFalse(lock_is_free(self.host_lock))
        process.stdin.write("DONE\n")
        close_stdin(process)
        result = self.finish(process)
        self.assertOutcome(result, 0, "passed")
        self.assertTornDown()

    def test_ready_line_is_one_line_and_keeps_non_ascii_case_data(self):
        self.ctl(
            guard_json={
                **GUARD_JSON,
                "base_cases": 1,
                "cases": [{"name": "ping", "send": "/ping", "expect": ["pong|понг"]}],
            }
        )
        result = self.run_entry()
        lines = [l for l in result.stdout.splitlines() if l.startswith("STAGE_READY ")]
        self.assertEqual(len(lines), 1)
        self.assertEqual(
            json.loads(lines[0][len("STAGE_READY ") :])["cases"][0]["expect"], ["pong|понг"]
        )

    def test_guard_and_health_get_the_contract_arguments(self):
        self.ctl(replay=True)
        self.assertOutcome(self.run_entry(), 0, "passed")
        guard = json.loads((self.rec / "guard.json").read_text())["argv"]
        work = Path(guard[guard.index("--cases") + 1]).parent
        self.assertEqual(work.parent, self.deploy)
        self.assertEqual(
            guard,
            [
                "guard",
                "--cases",
                str(work / "stage-smoke-cases.json"),
                "--extra-cases",
                str(work / "stage-smoke-cases.replay.json"),
                "--min-cases",
                "5",
                "--require-case",
                "start",
                "--require-case",
                "ping",
                "--require-case",
                "today-read-only-calendar",
                "--require-case",
                "simple-intent-phrase",
                "--require-case",
                "validation-search-without-query",
                "--stage-env",
                str(self.stage / "stage.env"),
                "--prod-env",
                str(self.deploy / ".env"),
                "--deny",
                "HyperCalendarBot",
            ],
        )
        health = json.loads((self.rec / "health.json").read_text())["argv"]
        self.assertEqual(
            health[:7],
            [
                "wait",
                "--container",
                "hypercal-bot-stage",
                "--url",
                "http://127.0.0.1:3002",
                "--mode",
                "health",
            ],
        )

    def test_extra_cases_flag_only_when_a_replay_file_was_shipped(self):
        self.assertOutcome(self.run_entry(), 0, "passed")
        self.assertNotIn("--extra-cases", json.loads((self.rec / "guard.json").read_text())["argv"])

    def test_compose_command_pins_project_files_and_image_override(self):
        self.run_entry()
        compose = [
            line
            for line in (self.rec / "docker.log").read_text().splitlines()
            if line.startswith("docker compose")
        ]
        up = next(line for line in compose if " up " in line)
        self.assertIn("-p hypercalstage --project-directory " + str(self.deploy), up)
        self.assertIn(f"-f {self.lib}/docker-compose.stage.yml", up)
        self.assertIn("up -d --no-build --pull never --force-recreate", up)
        self.assertTrue(any(" down --timeout 10" in line for line in compose), compose)

    def test_refused_guard_64_is_exit_2_with_failure_evidence_and_teardown(self):
        self.ctl(guard_rc=64)
        result = self.run_entry()
        self.assertOutcome(result, 2, "refused")
        self.assertNotIn("STAGE_READY", result.stdout)
        self.assertTrue(self.has_event("evidence failed"))
        self.assertLess(self.index_of("evidence failed"), self.index_of("compose-down"))
        self.assertTornDown()

    def test_guard_without_a_guard_line_is_refused(self):
        self.ctl(guard_garbage=True)
        result = self.run_entry()
        self.assertOutcome(result, 2, "refused")
        self.assertNotIn("STAGE_READY", result.stdout)
        self.assertTornDown()

    def test_guard_line_without_the_required_fields_is_refused(self):
        self.ctl(guard_json={"username": "hypercal_stage_bot"})
        result = self.run_entry()
        self.assertOutcome(result, 2, "refused")
        self.assertNotIn("STAGE_READY", result.stdout)

    def test_done_and_eof_both_end_the_run_as_passed(self):
        for label, kwargs in (("DONE", {}), ("EOF", {"done": False})):
            with self.subTest(label):
                self.build()
                process = self.popen(**kwargs)
                self.ready(process)
                if kwargs:
                    close_stdin(process)
                self.assertOutcome(self.finish(process), 0, "passed")
                self.assertTornDown()

    def test_unrelated_stdin_lines_do_not_end_the_wait(self):
        process = self.popen(done=False)
        self.ready(process)
        process.stdin.write("hello\n")
        process.stdin.flush()
        time.sleep(1)
        self.assertIsNone(process.poll())
        self.assertFalse(self.has_event("compose-down"))
        process.stdin.write("DONE\n")
        close_stdin(process)
        self.assertOutcome(self.finish(process), 0, "passed")

    def test_unhealthy_stage_is_a_failure_with_evidence_and_teardown(self):
        self.ctl(health_rc=1)
        result = self.run_entry()
        self.assertOutcome(result, 1, "failed")
        self.assertFalse(self.has_event("guard"))
        self.assertTrue(self.has_event("evidence failed"))
        self.assertTornDown()

    def test_image_identity_mismatch_is_refused_before_anything_starts(self):
        (self.rec / "image.tar.gz").write_bytes(gzip.compress(b"X"))
        self.ctl(image_id="sha256:" + "ee" * 32)
        # The stub docker reports ctl image_id for both artifact.json and inspect; split them.
        text = (
            (self.bin / "docker")
            .read_text()
            .replace(
                'print(json.load(open(sys.argv[1]))["image_id"])', 'print("sha256:" + "11" * 32)'
            )
        )
        (self.bin / "docker").write_text(text)
        result = self.run_entry()
        self.assertOutcome(result, 2, "refused")
        self.assertFalse(self.has_event("compose-up"))

    def test_no_secret_reaches_argv_or_the_environment_of_any_child(self):
        result = self.run_entry()
        self.assertOutcome(result, 0, "passed")
        self.assertNoSecrets(result)
        for name in ("fetch-fetch", "fetch-current"):
            record = json.loads(next(self.rec.glob(f"{name}.*.json")).read_text())
            self.assertTrue(record["stdin_is_token"], name)
            self.assertFalse(record["fd3_open"], name)
            self.assertNotIn(FAKE_TOKEN, json.dumps(record))
        guard = json.loads((self.rec / "guard.json").read_text())
        self.assertFalse(guard["fd3_open"])
        self.assertEqual(
            json.loads(next(self.rec.glob("fetch-fetch.*.json")).read_text())["argv"][:7],
            [
                "fetch",
                "--api",
                "http://127.0.0.1:9",
                "--repo",
                "alex-mextner/HyperCalendarBot",
                "--sha",
                SHA,
            ],
        )

    def test_work_dir_is_a_private_namespaced_dir_and_is_removed(self):
        self.run_entry()
        info = json.loads((self.rec / "fetch-out.json").read_text())
        out = Path(info["out"])
        self.assertEqual(out.parent, self.deploy)
        self.assertRegex(out.name, r"^\.stage-incoming-" + SHA + r"-\d+-\d+$")
        self.assertEqual(info["mode"], 0o700)
        self.assertEqual(info["entries"], [])
        self.assertFalse(out.exists())


class BotEnvAndDatabase(StageWorld):
    def bot_env(self):
        pairs = {}
        for line in (self.stage / "bot.env").read_text().splitlines():
            key, _, value = line.partition("=")
            pairs[key] = value
        return pairs

    def test_bot_env_is_the_allow_list_plus_the_stage_identity_only(self):
        result = self.run_entry()
        self.assertOutcome(result, 0, "passed")
        env = self.bot_env()
        self.assertEqual(set(env), ALLOWED_KEYS)
        self.assertEqual(env["BOT_TOKEN"], STAGE_BOT_TOKEN)
        self.assertEqual(env["BOT_USERNAME"], "hypercal_stage_bot")
        self.assertEqual(env["ZAI_API_KEY"], "zai-secret")
        self.assertEqual(env["LOG_LEVEL"], "debug")
        text = (self.stage / "bot.env").read_text()
        for leaked in (
            PROD_BOT_TOKEN,
            "hypercal_prod_bot",
            "google-secret",
            "mtproto-secret",
            "smtp-secret",
            "inline-secret",
            "bot.example.org",
            "tg-hash",
            "hook-secret",
            "leak-1",
            "svc-secret",
        ):
            self.assertNotIn(leaked, text)
        self.assertEqual(stat.S_IMODE((self.stage / "bot.env").stat().st_mode), 0o600)
        self.assertNoSecrets(result)

    def test_stage_database_is_wiped_every_run_but_logs_are_kept(self):
        for name in ("calendar.db", "calendar.db-wal", "calendar.db-shm"):
            (self.stage / "data" / name).write_text("old stage rows")
        (self.stage / "logs" / "old.log").write_text("keep me")
        (self.stage / "evidence").mkdir()
        (self.stage / "evidence" / "release-old").mkdir()
        self.assertOutcome(self.run_entry(), 0, "passed")
        self.assertIn("compose-up db_present=0", self.events())
        self.assertEqual([p.name for p in (self.stage / "data").glob("calendar.db*")], [])
        self.assertEqual((self.stage / "logs" / "old.log").read_text(), "keep me")
        self.assertTrue((self.stage / "evidence" / "release-old").is_dir())

    def test_bot_env_is_built_even_when_prod_env_is_missing_the_allow_listed_keys(self):
        (self.deploy / ".env").write_text(f"BOT_TOKEN={PROD_BOT_TOKEN}\n")
        self.assertOutcome(self.run_entry(), 0, "passed")
        self.assertEqual(set(self.bot_env()), {"BOT_TOKEN", "BOT_USERNAME"})


class NotProvisioned(StageWorld):
    def check(self, mutate, label):
        self.build()
        mutate()
        result = self.run_entry()
        self.assertOutcome(result, 3, "not-provisioned")
        self.assertIn("STAGE_QA_NOT_PROVISIONED", result.stderr, label)
        self.assertFalse(self.has_event("docker-load"), label)
        self.assertFalse(self.has_event("compose-up"), label)
        self.assertEqual(self.leftover_work_dirs(), [], label)

    def test_every_missing_piece_exits_3_before_any_docker_work(self):
        def drop_key(name, key):
            def mutate():
                path = self.stage / name
                path.write_text(
                    "".join(l for l in path.read_text().splitlines(True) if not l.startswith(key))
                )

            return mutate

        def blank_key(name, key):
            def mutate():
                path = self.stage / name
                path.write_text(
                    re.sub(f"^{key}=.*$", f"{key}=", path.read_text(), flags=re.MULTILINE)
                )

            return mutate

        cases = {
            "stage.env missing": lambda: (self.stage / "stage.env").unlink(),
            "stage.env without BOT_TOKEN": drop_key("stage.env", "BOT_TOKEN"),
            "stage.env without BOT_USERNAME": drop_key("stage.env", "BOT_USERNAME"),
            "stage.env without STAGE_REDIS_PASSWORD": drop_key("stage.env", "STAGE_REDIS_PASSWORD"),
            "stage.env empty BOT_TOKEN": blank_key("stage.env", "BOT_TOKEN"),
            "smoke script missing": lambda: (self.lib / "stage-smoke.py").unlink(),
            "compose file missing": lambda: (self.lib / "docker-compose.stage.yml").unlink(),
            "empty case list": lambda: self.ctl(cases_text=""),
        }
        for label, mutate in cases.items():
            with self.subTest(label):
                self.check(mutate, label)

    def test_missing_lib_helper_is_not_provisioned(self):
        (self.lib / "stage-fetch-artifact.py").unlink()
        self.assertOutcome(self.run_entry(), 3, "not-provisioned")


if __name__ == "__main__":
    unittest.main()
