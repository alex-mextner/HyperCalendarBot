"""Fixed stage-only model profiles through the real installed-wrapper boundary."""

import json
import shutil
import subprocess
import sys

from odroid_stage_qa_support import FAKE_TOKEN, ROOT, SHA, HeldLock, StageWorld


CHAINS = (
    "AI_SMART_CHAIN",
    "AI_FAST_CHAIN",
    "AI_PLANNER_CHAIN",
    "AI_EXECUTOR_CHAIN",
    "AI_REPAIR_CHAIN",
)


class StageModelProfiles(StageWorld):
    def append_production(self, values):
        with (self.deploy / ".env").open("a") as stream:
            for key, value in values:
                stream.write(f"{key}={value}\n")

    def environment_lines(self):
        return [line.partition("=") for line in (self.stage / "bot.env").read_text().splitlines()]

    def environment(self):
        return {key: value for key, _, value in self.environment_lines()}

    def run_arguments(self, arguments, *, ssh_command=None, extra_env=None):
        env = {"PATH": "/usr/bin:/bin", "HOME": str(self.tmp), **(extra_env or {})}
        if ssh_command is not None:
            env["SSH_ORIGINAL_COMMAND"] = ssh_command
        return subprocess.run(
            [str(self.entry), *arguments],
            input=FAKE_TOKEN + "\nDONE\n",
            capture_output=True,
            text=True,
            env=env,
            timeout=90,
            check=False,
        )

    def ready_profile(self, result):
        lines = [line for line in result.stdout.splitlines() if line.startswith("STAGE_READY ")]
        self.assertEqual(len(lines), 1, result.stderr)
        ready = json.loads(lines[0].removeprefix("STAGE_READY "))
        self.assertIn("model_profile", ready)
        return ready["model_profile"]

    def assert_refuses_without_input(self, argv, *, ssh_command=None):
        env = {"PATH": "/usr/bin:/bin", "HOME": str(self.tmp)}
        if ssh_command is not None:
            env["SSH_ORIGINAL_COMMAND"] = ssh_command
        process = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        try:
            # stdin stays open and empty. A token read or a lock wait cannot pass this check.
            process.wait(timeout=3)
            out = process.stdout.read()
            err = process.stderr.read()
            self.assertEqual(process.returncode, 2, err)
            self.assertIn("status=refused", out)
            self.assertNotIn("STAGE_READY", out)
            self.assertFalse(self.has_event("fetch-fetch"))
            self.assertFalse(self.has_event("compose-up"))
            return err
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=3)
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()

    def test_default_preserves_ai_environment_and_ignores_inherited_profile(self):
        inherited = self.run_arguments([SHA], extra_env={"MODEL_PROFILE": "opus"})
        self.assertOutcome(inherited, 0, "passed")
        before = self.environment()
        self.assertEqual(before["CLAUDE_MODEL"], "claude-x")
        self.assertNotIn("AI_SMART_CHAIN", before)
        self.assertEqual(self.ready_profile(inherited), "default")

        explicit = self.run_arguments([SHA, "default"])
        self.assertOutcome(explicit, 0, "passed")
        after = self.environment()
        before.pop("TELEGRAM_SESSION_MASTER_KEY")
        after.pop("TELEGRAM_SESSION_MASTER_KEY")
        self.assertEqual(after, before)
        self.assertEqual(self.ready_profile(explicit), "default")

    def check_fixed_profile(self, profile, prefix, model, provider, credential):
        overrides = (f"{prefix}_MODEL", f"{prefix}_FAST_MODEL", *CHAINS)
        self.append_production([(key, value) for key in overrides for value in ("old-one", "old-two")])
        preserved = {
            credential: "synthetic-selected-provider-token",
            "AI_ROUTING": "roles",
            "AI_ROUTING_USER_IDS": "7654321",
            "AI_CLAUDE_TRANSPORT": "native",
            "CLAUDE_MODEL_SUFFIX": "unchanged-suffix",
            "AI_SMART_CHAIN_EXTRA": "unchanged-extra",
            "ZAI_BASE_URL": "https://provider.invalid/v1",
        }
        self.append_production(preserved.items())

        result = self.run_arguments([SHA, profile])

        self.assertOutcome(result, 0, "passed")
        env = self.environment()
        self.assertEqual(self.ready_profile(result), profile)
        self.assertIn(f"stage-qa-run: model profile {profile}", result.stderr)
        evidence = json.loads((self.rec / "evidence-release-logs.json").read_text())
        label = evidence["argv"][evidence["argv"].index("--label") + 1]
        self.assertEqual(label, f"stage-{SHA[:12]}-{profile}")
        for key in overrides:
            self.assertEqual(sum(name == key for name, _, _ in self.environment_lines()), 1, key)
            self.assertEqual(env[key], provider if key in CHAINS else model)
        for key, value in preserved.items():
            self.assertEqual(env[key], value)
        if prefix == "ZAI":
            self.assertEqual(env["CLAUDE_MODEL"], "claude-x")
        self.assertNotIn("synthetic-selected-provider-token", result.stdout + result.stderr + self.record_text())
        self.assertNoSecrets(result)

    def test_opus_overrides_only_fixed_model_and_chain_keys(self):
        self.check_fixed_profile("opus", "CLAUDE", "claude-opus-5-5", "claude", "CLAUDE_API_TOKEN")

    def test_glm_overrides_only_fixed_model_and_chain_keys(self):
        self.check_fixed_profile("glm", "ZAI", "glm-5.3", "zai", "ZAI_API_KEY")

    def test_opus_accepts_the_existing_second_credential(self):
        self.append_production([("CLAUDE_API_TOKEN", '""'), ("CLAUDE_API_TOKEN2", "synthetic-second-token")])
        result = self.run_arguments([SHA, "opus"])
        self.assertOutcome(result, 0, "passed")
        self.assertEqual(self.environment()["CLAUDE_MODEL"], "claude-opus-5-5")
        self.assertNotIn("synthetic-second-token", result.stdout + result.stderr + self.record_text())

    def test_missing_effective_provider_credential_refuses_before_startup(self):
        for profile, credential in (("opus", "CLAUDE_API_TOKEN"), ("glm", "ZAI_API_KEY")):
            with self.subTest(profile):
                self.build()
                self.append_production([(credential, "earlier-value"), (credential, '"   "')])
                original = self.stage / "bot.env"
                original.write_text("previous-complete-environment\n")
                lock = HeldLock(self.host_lock)
                self.addCleanup(lock.release)
                result = self.run_arguments([SHA, profile])
                self.assertOutcome(result, 3, "not-provisioned")
                self.assertNotIn("STAGE_READY", result.stdout)
                self.assertIn("model profile", result.stderr)
                self.assertFalse(self.has_event("compose-up"))
                self.assertFalse(self.has_event("health"))
                self.assertFalse(self.has_event("fetch-current"))
                self.assertFalse(self.has_event("docker-load"))
                self.assertFalse((self.stage / "bot.env.new").exists())
                self.assertEqual(original.read_text(), "previous-complete-environment\n")
                self.assertNotIn("earlier-value", result.stdout + result.stderr + self.record_text())

    def test_invalid_and_extra_profiles_refuse_before_input_locks_or_workdirs(self):
        stage_lock = HeldLock(self.stage_lock)
        host_lock = HeldLock(self.host_lock)
        self.addCleanup(stage_lock.release)
        self.addCleanup(host_lock.release)
        marker = self.tmp / "injection-was-executed"
        arguments = [
            [SHA, ""],
            [SHA, "Opus"],
            [SHA, "claude"],
            [SHA, f"opus;touch {marker}"],
            [SHA, f"$(touch {marker})"],
            [SHA, "opus", "extra"],
            [SHA, "default", "extra"],
        ]
        for args in arguments:
            with self.subTest(args):
                self.assert_refuses_without_input([str(self.entry), *args])
                self.assertEqual(self.leftover_work_dirs(), [])
        self.assertFalse(marker.exists())

    def test_forced_ssh_remains_exact_sha_only(self):
        result = self.run_arguments([], ssh_command=SHA)
        self.assertOutcome(result, 0, "passed")
        self.assertEqual(self.ready_profile(result), "default")
        self.build()
        for profile in ("default", "opus", "glm"):
            with self.subTest(profile):
                self.assert_refuses_without_input(
                    [str(self.entry)], ssh_command=f"{SHA} {profile}"
                )

    def test_internal_runner_rejects_invalid_or_extra_profiles_before_owning_workdir(self):
        lock = HeldLock(self.host_lock)
        self.addCleanup(lock.release)
        for index, profile_args in enumerate((["unknown"], [""], ["default", "extra"], ["opus", "extra"])):
            with self.subTest(profile_args):
                work = self.deploy / f".stage-incoming-{SHA}-1-{index}"
                work.mkdir(mode=0o700)
                marker = work / "not-owned-until-arguments-pass"
                marker.write_text("preserve")
                err = self.assert_refuses_without_input(
                    ["bash", str(self.lib / "stage-qa-run.sh"), SHA, str(work), *profile_args]
                )
                self.assertIn("profile", err)
                self.assertTrue(marker.is_file())

    def test_provider_credential_is_rechecked_after_the_host_lock(self):
        for profile, credential in (("opus", "CLAUDE_API_TOKEN"), ("glm", "ZAI_API_KEY")):
            with self.subTest(profile):
                self.build()
                self.append_production([(credential, "synthetic-before-lock")])
                original = self.lib / "stage-fetch-artifact-original.py"
                (self.lib / "stage-fetch-artifact.py").rename(original)
                self.write_exec(
                    self.lib / "stage-fetch-artifact.py",
                    f"""#!{sys.executable}
import os, sys
if sys.argv[1] == "current":
    with open({str(self.deploy / ".env")!r}, "a") as stream:
        stream.write({(credential + '=""\n')!r})
os.execv({sys.executable!r}, [{sys.executable!r}, {str(original)!r}, *sys.argv[1:]])
""",
                )
                previous = self.stage / "bot.env"
                previous.write_text("previous-complete-environment\n")

                result = self.run_arguments([SHA, profile])

                self.assertOutcome(result, 3, "not-provisioned")
                self.assertTrue(self.has_event("fetch-current"))
                self.assertTrue(self.has_event("docker-load"))
                self.assertFalse(self.has_event("compose-up"))
                self.assertFalse((self.stage / "bot.env.new").exists())
                self.assertEqual(previous.read_text(), "previous-complete-environment\n")
                self.assertNotIn("synthetic-before-lock", result.stdout + result.stderr + self.record_text())

    def test_generated_profiles_construct_only_requested_models(self):
        # Real application parsing and chain construction, with synthetic credentials and no calls.
        code = f"""
globalThis.fetch = () => {{ throw new Error("profile contract must stay offline"); }};
const {{ loadConfig }} = await import({json.dumps(str(ROOT / "src/config/env.ts"))});
const {{ buildSmartChain, buildFastChain, buildRoleChain }} =
  await import({json.dumps(str(ROOT / "src/services/ai/streaming/chains.ts"))});
const config = loadConfig();
const summarize = slots => slots.map(slot => ({{provider: slot.provider, model: slot.configuredModel}}));
const chains = {{smart: summarize(buildSmartChain(config)), fast: summarize(buildFastChain(config))}};
for (const role of ["planner", "executor", "repair"]) chains[role] = summarize(buildRoleChain(role, config));
console.log("STAGE_PROFILE_CHAINS " + JSON.stringify(chains));
"""
        bun = shutil.which("bun")
        self.assertIsNotNone(bun, "the repository's Bun runtime is required for this contract")
        for profile, provider, model, credential in (
            ("opus", "claude", "claude-opus-5-5", "CLAUDE_API_TOKEN"),
            ("glm", "zai", "glm-5.3", "ZAI_API_KEY"),
        ):
            with self.subTest(profile):
                self.build()
                self.append_production([
                    (credential, "synthetic-contract-token"),
                    ("ZAI_BASE_URL", "https://zai.invalid/v1"),
                    ("ZAI_MODEL", "synthetic-unselected-smart"),
                    ("ZAI_FAST_MODEL", "synthetic-unselected-fast"),
                    ("HF_BASE_URL", "https://hf.invalid/v1"),
                    ("HF_MODEL", "synthetic-unselected-smart"),
                    ("HF_FAST_MODEL", "synthetic-unselected-fast"),
                ])
                generated = self.run_arguments([SHA, profile])
                self.assertOutcome(generated, 0, "passed")
                result = subprocess.run(
                    [bun, "--no-env-file", "--eval", code],
                    cwd=self.tmp,
                    env={"PATH": "/usr/bin:/bin", "REDIS_URL": "redis://stage-only.invalid:6379",
                         **self.environment()},
                    capture_output=True, text=True, timeout=15, check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                reports = [line.removeprefix("STAGE_PROFILE_CHAINS ") for line in result.stdout.splitlines()
                           if line.startswith("STAGE_PROFILE_CHAINS ")]
                self.assertEqual(len(reports), 1)
                self.assertEqual(
                    json.loads(reports[0]),
                    {name: [{"provider": provider, "model": model}]
                     for name in ("smart", "fast", "planner", "executor", "repair")},
                )
