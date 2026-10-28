"""Contract tests for the per-PR stage QA check (#840, owner order 2026-10-25).

They fail when the pipeline stops running the stage bot and the QA smoke, when the smoke could
target the production bot, when the case list is empty or loses a scenario, when `gh ship` stops
requiring the check, or when the production deploy starts depending on the stage again.
Behaviour of each piece is covered where it lives: test_stage_smoke.py (guards),
test_stage_fetch_artifact.py (artifact verification), test_odroid_stage_qa.py (the root wrapper),
test_stage_qa_gate.py (the ship gate), test/regressions/stage-qa-workflows.test.ts (the workflows).
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def text(relative):
    return (ROOT / relative).read_text()


CASES = json.loads(text("scripts/stage-smoke-cases.json"))
RUN = text("scripts/stage-qa-run.sh")
SMOKE = text("scripts/stage-smoke.py")
GATE = text("scripts/stage-qa-gate.py")
SHIP = text(".claude/scripts/pr-ship.sh")
QA_WORKFLOW = text(".github/workflows/stage-qa.yml")
BUILD_WORKFLOW = text(".github/workflows/stage-build.yml")
STAGE_COMPOSE = text("docker-compose.stage.yml")
PROD_COMPOSE = text("docker-compose.yml")


class SmokeHasSomethingToCheck(unittest.TestCase):
    def test_case_list_is_not_empty_and_meets_the_floor_the_runner_enforces(self):
        floor = int(re.search(r"--min-cases (\d+)", RUN).group(1))
        self.assertGreaterEqual(floor, 5)
        self.assertGreaterEqual(len(CASES), floor)

    def test_every_case_sends_text_asserts_something_and_bounds_its_latency(self):
        names = [case["name"] for case in CASES]
        self.assertEqual(len(names), len(set(names)), "duplicate case names")
        for case in CASES:
            self.assertTrue(case["send"].strip(), case["name"])
            self.assertTrue(
                case.get("expect") or case.get("forbid"),
                f"{case['name']} asserts nothing",
            )
            self.assertIn("max_first_reply_s", case, case["name"])
            self.assertGreaterEqual(case.get("min_replies", 1), 1, case["name"])
            for pattern in [*case.get("expect", []), *case.get("forbid", [])]:
                re.compile(pattern)

    def test_the_runner_requires_the_scenarios_the_owner_asked_for_and_the_repository_list_has_them(
        self,
    ):
        required = re.findall(r"--require-case ([a-z0-9-]+)", RUN)
        self.assertGreaterEqual(len(required), 5)
        names = {case["name"]: case for case in CASES}
        for name in required:
            self.assertIn(name, names, f"the runner requires case {name}, the list lacks it")
        # start, a read-only calendar question, a plain intent phrase, a validation failure
        self.assertEqual(names["start"]["send"], "/start")
        self.assertEqual(names["today-read-only-calendar"]["send"], "/today")
        self.assertFalse(
            names["simple-intent-phrase"]["send"].startswith("/"),
            "the intent phrase must be free text",
        )
        self.assertEqual(names["validation-search-without-query"]["send"], "/search")
        self.assertTrue(
            names["validation-search-without-query"]["expect"],
            "a validation failure must assert its message",
        )

    def test_no_case_changes_the_calendar(self):
        # A stage database is thrown away every run, but the cases stay read-only so a failure
        # never depends on what an earlier case wrote.
        for case in CASES:
            self.assertNotRegex(
                case["send"],
                r"^/(add|edit|delete|import|invite|share|connect|disconnect)",
                case["name"],
            )


class SmokeTargetsOnlyTheStageBot(unittest.TestCase):
    def test_the_runner_points_the_smoke_at_the_stage_env_and_uses_the_prod_env_only_as_a_denylist(
        self,
    ):
        self.assertRegex(RUN, r'--stage-env "\$STAGE_DIR/stage\.env"')
        self.assertRegex(RUN, r'--prod-env "\$DEPLOY_PATH/\.env"')
        self.assertNotRegex(RUN, r'--stage-env "\$DEPLOY_PATH/\.env"')
        self.assertIn("--deny HyperCalendarBot", RUN)

    def test_the_smoke_refuses_production_usernames_and_tokens(self):
        for needle in (
            "is a production bot",
            "the stage token is the production token",
            "does not look like a stage bot",
            "belongs to @",
        ):
            self.assertIn(needle, SMOKE)

    def test_the_smoke_runs_from_the_trusted_install_and_never_from_the_pr_artifact(
        self,
    ):
        self.assertRegex(RUN, r"stage-smoke\.py")
        self.assertNotIn("stage-smoke.py", BUILD_WORKFLOW + QA_WORKFLOW)

    def test_stage_compose_shares_nothing_with_production(self):
        self.assertNotIn("env_file: .env", STAGE_COMPOSE)
        self.assertRegex(STAGE_COMPOSE, r"env_file: stage/bot\.env")
        self.assertNotIn("./data:/app/data", STAGE_COMPOSE)
        self.assertIn("./stage/data:/app/data", STAGE_COMPOSE)
        self.assertNotRegex(STAGE_COMPOSE, r'"3001:')
        self.assertNotIn("hypercal-redis", STAGE_COMPOSE)
        self.assertNotIn("container_name: hypercal-bot\n", STAGE_COMPOSE)
        self.assertRegex(STAGE_COMPOSE, r"(?m)^name: hypercalstage$")
        self.assertRegex(STAGE_COMPOSE, r"127\.0\.0\.1:3002:3311")
        self.assertNotIn("ghcr.io", STAGE_COMPOSE)

    def test_the_stage_image_name_is_spelled_the_same_in_every_place_that_uses_it(self):
        # One load-bearing name: the build tags it, the odroid fetcher checks the archive for it, the run script loads and removes it.
        name = "ghcr.io/alex-mextner/hypercalendarbot-stage"
        self.assertEqual(BUILD_WORKFLOW.count(f"{name}:"), 3)
        self.assertIn(f'f"{name}:{{SHA}}"', text("scripts/stage-fetch-artifact.py"))
        self.assertIn(f"readonly IMAGE_REPO={name}\n", RUN)

    def test_stage_environment_is_an_allow_list_without_telegram_google_or_mtproto(
        self,
    ):
        allowed = re.search(r"ALLOWED_ENV='([^']*)'", RUN).group(1)
        for forbidden in (
            "GOOGLE",
            "MTPROTO",
            "TELEGRAM",
            "PUBLIC_DOMAIN",
            "INLINE",
            "BOT_TOKEN",
            "SMTP",
            "ENCRYPTION",
            "BOT_ADMIN",
        ):
            self.assertNotIn(forbidden, allowed)
        self.assertNotIn("PUBLIC_DOMAIN", STAGE_COMPOSE.replace("no PUBLIC_DOMAIN", ""))

    def test_prod_compose_is_not_the_stage_compose(self):
        self.assertNotEqual(PROD_COMPOSE, STAGE_COMPOSE)
        self.assertIn("container_name: hypercal-bot\n", PROD_COMPOSE)


IN_CI = bool(os.environ.get("CI") or os.environ.get("GITHUB_ACTIONS"))


def compose_version():
    """`docker compose version` output, or None when the plugin is absent or does not answer."""
    if shutil.which("docker") is None:
        return None
    try:
        probe = subprocess.run(
            ["docker", "compose", "version"],
            capture_output=True,
            text=True,
            check=False,
            timeout=8,
        )
    except subprocess.TimeoutExpired:
        return None
    return probe.stdout.strip() if probe.returncode == 0 else None


class TheStageComposeIsAValidProjectForTheRealCompose(unittest.TestCase):
    """Text checks do not see what Compose itself refuses (#885: Compose v5 on the odroid rejected
    `pids_limit` next to `deploy.resources.limits` without a matching `limits.pids`, after the whole
    artifact was already loaded). `config` only parses and renders: no daemon, no image pull, no container.
    Skipped outside CI when there is no compose plugin; in CI a missing plugin fails.
    """

    def setUp(self):
        self.compose_version = compose_version()
        if self.compose_version is None:
            if IN_CI:
                self.fail(
                    "CI must have the docker compose plugin: this test is the real-engine check"
                )
            self.skipTest("no docker compose plugin on this host (CI runs it)")

    def render_bot_stage(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "stage").mkdir()
            (Path(tmp) / "stage" / "bot.env").write_text("")
            done = subprocess.run(
                [
                    "docker",
                    "compose",
                    "-p",
                    "hypercalstage",
                    "--project-directory",
                    tmp,
                    "-f",
                    str(ROOT / "docker-compose.stage.yml"),
                    "config",
                    "--format",
                    "json",
                ],
                capture_output=True,
                text=True,
                check=False,
                timeout=8,
                env={**os.environ, "STAGE_REDIS_PASSWORD": "dummy"},
            )
        self.assertEqual(done.returncode, 0, f"{self.compose_version}: {done.stderr}")
        return json.loads(done.stdout)["services"]["bot-stage"]

    def test_the_engine_accepts_the_stage_file_and_the_bot_keeps_its_caps(self):
        bot = self.render_bot_stage()
        limits = bot["deploy"]["resources"]["limits"]
        self.assertEqual(bot["pids_limit"], 512, self.compose_version)
        self.assertEqual(limits["pids"], 512, self.compose_version)
        # Compose spells these differently across versions (bytes or "768m"; 1 or "1.0"); the value is what counts.
        self.assertIn(str(limits["memory"]), ("768m", str(768 * 1024 * 1024)))
        self.assertEqual(float(limits["cpus"]), 1.0)
        self.assertEqual(bot["security_opt"], ["no-new-privileges:true"])
        (port,) = bot["ports"]
        self.assertEqual(
            (port["host_ip"], str(port["published"]), port["target"]), ("127.0.0.1", "3002", 3311)
        )


class TheQaRunsThroughQaCliOnThePc(unittest.TestCase):
    """Owner decision (tg#25056): the smoke uses the PC's qa-cli Telegram Web session; no Telethon, no 2FA."""

    DRIVER = text("scripts/stage-qa-pc.py")
    PC_INSTALLER = text("scripts/install-stage-qa-pc.sh")
    WRAPPER = text("scripts/odroid-stage-qa.sh")

    def test_no_default_path_file_mentions_telethon_or_a_qa_session(self):
        for name, body in (
            ("stage-smoke.py", SMOKE),
            ("stage-qa-pc.py", self.DRIVER),
            ("stage-qa-run.sh", RUN),
            ("odroid-stage-qa.sh", self.WRAPPER),
            ("stage-qa.yml", QA_WORKFLOW),
            ("stage-build.yml", BUILD_WORKFLOW),
            ("install-stage-qa-pc.sh", self.PC_INSTALLER),
        ):
            for word in (
                "telethon",
                "qa_session",
                "qa-smoke.env",
                "provision_smoke_session",
            ):
                self.assertNotIn(word, body.lower(), f"{name} still mentions {word}")

    def test_the_smoke_talks_to_telegram_only_through_qa_telegram_chat(self):
        self.assertIn('"telegram", "chat"', SMOKE.replace("'", '"'))
        self.assertNotRegex(SMOKE, r"api\.telegram\.org/bot[^g]*sendMessage")

    def test_the_driver_enforces_its_own_floor_and_deny_list_from_its_own_config(self):
        for needle in ("deny_usernames", "required_cases", "min_cases", "username"):
            self.assertIn(needle, self.DRIVER)
        self.assertNotIn("sudo", self.DRIVER)

    def test_the_only_thing_the_ssh_key_can_do_is_start_the_wrapper(self):
        self.assertIn('restrict,command="%s"', self.PC_INSTALLER)
        self.assertRegex(self.PC_INSTALLER, r"ODROID_ENTRY=/usr/local/sbin/hypercal-stage-qa\b")
        self.assertIn("SSH_ORIGINAL_COMMAND", self.WRAPPER)
        self.assertRegex(self.WRAPPER, r"\^\[0-9a-f\]\{40\}\$")

    def test_the_driver_always_ends_the_odroid_session(self):
        self.assertIn("DONE", self.DRIVER)
        self.assertIn("DONE", RUN)


class TheProductionDeployDoesNotDependOnTheStage(unittest.TestCase):
    """Owner order: the check runs on the PR and `gh ship` then simply deploys; no stage inside the swap."""

    def test_deploy_workflow_activator_and_wrapper_know_nothing_about_the_stage(self):
        for relative in (
            ".github/workflows/deploy.yml",
            "scripts/deploy-prebuilt-image.sh",
            "scripts/odroid-activate-release.sh",
        ):
            body = text(relative)
            for word in (
                "stage-gate",
                "stage-smoke",
                "stage-qa",
                "docker-compose.stage",
                "stage gate",
                "on stage",
            ):
                self.assertNotIn(word, body, f"{relative} still mentions {word!r}")

    def test_the_stage_never_takes_the_deploy_runner_label(self):
        self.assertIn("qa-pc", QA_WORKFLOW)
        self.assertNotIn("odroid-hcb", QA_WORKFLOW)


class TheShipGateRequiresTheCheck(unittest.TestCase):
    def test_pr_ship_runs_the_gate_before_the_shared_ship_merges(self):
        self.assertLess(SHIP.index("stage-qa-gate.py"), SHIP.rindex('after_merge "$@"'))

    def test_the_gate_names_the_context_workflow_and_job_the_workflows_really_use(self):
        self.assertIn("stage-qa", GATE)
        self.assertIn(".github/workflows/stage-qa.yml", GATE)
        self.assertIn("Stage QA run", GATE)
        self.assertIn("name: Stage QA run", QA_WORKFLOW)
        self.assertIn("context=stage-qa", BUILD_WORKFLOW)
        self.assertRegex(QA_WORKFLOW, r"-f context=stage-qa|context=stage-qa")

    def test_the_gate_binds_the_status_to_a_trusted_run_not_to_the_status_alone(self):
        for needle in ("workflow_run", "github-actions[bot]", "head_sha"):
            self.assertIn(needle, GATE)


if __name__ == "__main__":
    unittest.main()
