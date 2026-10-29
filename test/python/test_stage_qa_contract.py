"""Contract tests for the per-PR stage QA check (#840, owner order 2026-10-25).

They fail when the pipeline stops running the stage bot and the QA smoke, when the smoke could
target the production bot, when the case list is empty or loses a scenario, when `gh ship` stops
requiring the check, or when the production deploy starts depending on the stage again.
Behaviour of each piece is covered where it lives: test_stage_smoke_guard.py (guards),
test_stage_fetch_artifact.py (artifact verification), test_odroid_stage_qa.py (the root wrapper),
test_stage_qa_gate.py (the ship gate), test/regressions/stage-qa-workflows.test.ts (the workflows).
"""

import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# The runner of the owner's PC, retired with #840; spelled in parts so this file does not name it itself.
RETIRED_RUNNER = "p" + "c"


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


PIDS_CAP = 512
MEMORY_CAP_FORMS = {
    "768m",
    str(768 * 1024 * 1024),
}  # Compose spells the same cap differently across versions
OVERLAY_TEMPLATE = 'services:\n  bot-stage:\n    image: "{image}"\n'


class TheStageComposeCarriesOneProcessCap(unittest.TestCase):
    def test_the_cap_is_not_spelled_as_pids_limit(self):
        # Compose v5 (the odroid's) rejects pids_limit next to deploy.resources.limits ("can't set distinct
        # values on 'pids_limit' and 'deploy.resources.limits.pids'"): every Stage QA run died at compose up (#885).
        self.assertNotRegex(STAGE_COMPOSE, r"(?m)^\s*pids_limit:")
        self.assertRegex(STAGE_COMPOSE, rf"(?m)^\s+pids:\s*{PIDS_CAP}\s*$")

    def test_the_overlay_the_render_test_uses_is_the_one_the_driver_writes(self):
        # render_bot_stage below mirrors compose() in stage-qa-run.sh: keep project name, env file and overlay in sync.
        driver_line = "printf 'services:\\n  bot-stage:\\n    image: \"%s\"\\n'"
        self.assertIn(driver_line, RUN)
        self.assertIn('-p "$COMPOSE_PROJECT"', RUN)
        self.assertIn('--env-file "$STAGE_DIR/stage.env"', RUN)


def docker_compose_available():
    try:
        probe = subprocess.run(
            ["docker", "compose", "version"],
            capture_output=True,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return probe.returncode == 0


class TheStageComposeRendersWithTheRealCompose(unittest.TestCase):
    """The text checks cannot see what Compose itself refuses, so this renders the tracked file exactly
    as compose() in stage-qa-run.sh does: the stage file plus the image overlay, env from stage.env.
    `config` only parses: no daemon, no container. Skipped without the compose plugin, except in CI,
    where a missing plugin fails so the check cannot silently vanish."""

    def setUp(self):
        if docker_compose_available():
            return
        if os.environ.get("GITHUB_ACTIONS") == "true":
            self.fail("CI must have the docker compose plugin: this is the real-engine check")
        self.skipTest("no docker compose plugin on this host (CI runs it)")

    def render_bot_stage(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            (tmp / "stage").mkdir()
            (tmp / "stage" / "bot.env").write_text("")
            stage_env = tmp / "stage" / "stage.env"
            stage_env.write_text("STAGE_REDIS_PASSWORD=dummy0password\n")
            overlay = tmp / "image.yml"
            overlay.write_text(OVERLAY_TEMPLATE.format(image="hypercalendarbot-stage:test"))
            command = [
                "docker",
                "compose",
                "-p",
                "hypercalstage",
                "--project-directory",
                tmpdir,
                "--env-file",
                str(stage_env),
                "-f",
                str(ROOT / "docker-compose.stage.yml"),
                "-f",
                str(overlay),
                "config",
                "--format",
                "json",
            ]
            done = subprocess.run(
                command,
                capture_output=True,
                text=True,
                check=False,
                timeout=60,
                env={
                    **os.environ,
                    "DOCKER_CONFIG": tmpdir,
                },  # no user credential helpers or contexts
            )
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)["services"]["bot-stage"]

    def test_the_effective_stage_compose_renders_and_keeps_the_process_cap(self):
        bot = self.render_bot_stage()
        self.assertEqual(bot["image"], "hypercalendarbot-stage:test")
        limits = bot["deploy"]["resources"]["limits"]
        self.assertEqual(limits["pids"], PIDS_CAP)
        self.assertNotIn("pids_limit", bot)
        self.assertIn(str(limits["memory"]), MEMORY_CAP_FORMS)
        self.assertEqual(float(limits["cpus"]), 1.0)
        self.assertEqual(bot["security_opt"], ["no-new-privileges:true"])


class TheQaRunsThroughQaCliOnTheBrowserHost(unittest.TestCase):
    """Owner decision (tg#25056, then 2026-10-28): the smoke uses the browser host's qa-cli Telegram Web
    session; no Telethon, no 2FA, and nothing browser-shaped on the odroid."""

    DRIVER = text("scripts/stage-qa-driver.py")
    BROWSER = text("scripts/stage-qa-browser.py")
    COMMON = text("scripts/stage_qa_common.py")
    BROWSER_INSTALLER = text("scripts/install-stage-qa-browser.sh")
    ODROID_INSTALLER = text("scripts/install-stage-qa.sh")
    WRAPPER = text("scripts/odroid-stage-qa.sh")

    def function_body(self, source, name, kind="def"):
        match = re.search(
            rf"^{kind} {name}\b.*?(?=^def |^class |\Z)", source, re.DOTALL | re.MULTILINE
        )
        self.assertIsNotNone(match, f"{name} not found")
        return match.group(0)

    def test_no_default_path_file_mentions_telethon_or_a_qa_session(self):
        for name, body in (
            ("stage-smoke.py", SMOKE),
            ("stage-qa-driver.py", self.DRIVER),
            ("stage-qa-browser.py", self.BROWSER),
            ("stage_qa_common.py", self.COMMON),
            ("stage-qa-run.sh", RUN),
            ("odroid-stage-qa.sh", self.WRAPPER),
            ("stage-qa.yml", QA_WORKFLOW),
            ("stage-build.yml", BUILD_WORKFLOW),
            ("install-stage-qa-browser.sh", self.BROWSER_INSTALLER),
            ("install-stage-qa.sh", self.ODROID_INSTALLER),
        ):
            for word in ("telethon", "qa_session", "qa-smoke.env", "provision_smoke_session"):
                self.assertNotIn(word, body.lower(), f"{name} still mentions {word}")

    def test_the_smoke_talks_to_telegram_only_through_qa_telegram_chat(self):
        self.assertIn('"telegram", "chat"', SMOKE.replace("'", '"'))
        self.assertNotRegex(SMOKE, r"api\.telegram\.org/bot[^g]*sendMessage")

    def test_the_browser_half_enforces_its_own_floor_and_deny_list_from_its_own_config(self):
        for needle in ("deny_usernames", "required_cases", "min_cases", "username"):
            self.assertIn(needle, self.BROWSER)
        self.assertNotIn("sudo", self.BROWSER)

    def test_the_odroid_ssh_key_can_only_start_the_browser_entry_and_the_wrapper_takes_only_a_sha(
        self,
    ):
        self.assertIn('restrict,command="%s"', self.BROWSER_INSTALLER)
        self.assertIn(
            'exec python3 %q/stage-qa-browser.py "${SSH_ORIGINAL_COMMAND-}"', self.BROWSER_INSTALLER
        )
        self.assertRegex(self.ODROID_INSTALLER, r"ENTRY_PATH=/usr/local/sbin/hypercal-stage-qa\b")
        self.assertIn("SSH_ORIGINAL_COMMAND", self.WRAPPER)
        self.assertRegex(self.WRAPPER, r"\^\[0-9a-f\]\{40\}\$")

    def test_the_driver_always_ends_the_odroid_session(self):
        self.assertIn("DONE", self.DRIVER)
        self.assertIn("DONE", RUN)

    def test_the_driver_never_runs_the_browser(self):
        for word in ("qa telegram", "agent-browser", "agent_browser"):
            self.assertNotIn(word, self.DRIVER)

    def test_the_browser_half_never_talks_to_the_wrapper_or_github(self):
        for word in ("api.github.com", "sudo", "GH_TOKEN", "TOKEN_PATTERN", "read_token"):
            self.assertNotIn(word, self.BROWSER, word)
        self.assertNotRegex(self.BROWSER, r"/usr/local/sbin/hypercal-stage-qa\b")

    def test_the_driver_hands_the_browser_ssh_only_the_ready_payload(self):
        argv = self.function_body(self.DRIVER, "browser_argv")
        self.assertNotRegex(argv, r"token", "browser_argv must not see the token")
        session = self.function_body(self.DRIVER, "BrowserSession", kind="class")
        self.assertNotRegex(session, r"token")
        self.assertIn("send_payload", session)
        # The payload comes from the wrapper's READY line, the token only goes to the wrapper's stdin.
        drive = self.function_body(self.DRIVER, "drive")
        self.assertIn("session.write_line(token)", drive)
        self.assertIn("browser.send_payload(payload)", drive)
        self.assertNotRegex(drive, r"browser\.\w+\([^)]*token")

    def test_the_browser_lock_is_taken_before_the_wrapper_is_started(self):
        # The wrapper's watchdog runs from its own locks: a wait for the browser lock after it would kill the run.
        run_session = self.function_body(self.DRIVER, "run_session")
        self.assertLess(
            run_session.index("BrowserSession("), run_session.index("await_browser_lock(")
        )
        self.assertLess(
            run_session.index("await_browser_lock("), run_session.index("WrapperSession(")
        )
        self.assertIn("LOCKED_LINE", self.DRIVER)
        browser = self.function_body(self.BROWSER, "execute")
        self.assertLess(browser.index("lock.acquire("), browser.index("announce_locked()"))
        self.assertLess(browser.index("announce_locked()"), browser.index("wait_payload("))
        self.assertIn("LOCKED_LINE", self.COMMON)

    def test_the_driver_has_no_case_floor_of_its_own(self):
        self.assertNotIn("min_cases", self.DRIVER)
        self.assertNotIn("min_cases", self.ODROID_INSTALLER)

    def test_the_workflow_runs_the_root_installed_driver(self):
        self.assertIn("python3 /usr/local/lib/hypercal-stage/stage-qa-driver.py", QA_WORKFLOW)

    def test_the_odroid_installer_installs_the_driver_and_its_common_module(self):
        lib = re.search(r"LIB_SOURCES=\((.*?)\)", self.ODROID_INSTALLER, re.DOTALL).group(1)
        self.assertIn("scripts/stage-qa-driver.py", lib)
        self.assertIn("scripts/stage_qa_common.py", lib)


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
        self.assertIn("runs-on: [self-hosted, stage-qa]", QA_WORKFLOW)
        runs_on = re.findall(r"^\s*runs-on:.*$", QA_WORKFLOW, re.MULTILINE)
        self.assertTrue(runs_on)
        for line in runs_on:
            self.assertNotIn("odroid-hcb", line)
        self.assertNotIn(f"qa-{RETIRED_RUNNER}", QA_WORKFLOW)

    def test_nothing_tracked_still_names_the_pc_runner(self):
        listed = subprocess.run(
            ["git", "ls-files", "scripts", "test", ".github", ".claude"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.splitlines()
        needles = tuple(
            f"{prefix}{RETIRED_RUNNER}"
            for prefix in ("qa-", "stage-qa-", "hypercal-stage-qa-", "install-stage-qa-")
        )
        me = Path(__file__).resolve().relative_to(ROOT).as_posix()
        for relative in listed:
            path = ROOT / relative
            if relative == me or not path.is_file():
                continue
            body = path.read_text(errors="ignore")
            for needle in needles:
                self.assertNotIn(needle, body, f"{relative} still mentions {needle}")


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
