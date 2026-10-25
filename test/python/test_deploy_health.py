"""deploy-health.py: a slow start is not a failure, a dead or crash-looping instance is (#823)."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/deploy-health.py"

FAKE_DOCKER = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
fx = Path(os.environ["FX"])
sc = json.loads((fx / "scenario.json").read_text())
counter = fx / "polls"
n = int(counter.read_text()) if counter.exists() else 0
args = sys.argv[1:]
if args[:1] == ["inspect"]:
    counter.write_text(str(n + 1))
    if n in sc.get("inspect_error_polls", []):
        sys.stderr.write("Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n")
        sys.exit(1)
    if sc.get("missing"):
        sys.stderr.write("Error: No such object: hypercal-bot\n")
        sys.exit(1)
    state = dict(Status="running", Running=True, Restarting=False, OOMKilled=False, ExitCode=0,
                 StartedAt="2026-10-25T00:00:00Z")
    state.update(sc.get("state", {}))
    if n >= sc.get("dies_after", 10**9):
        state.update(Status="exited", Running=False, ExitCode=1)
    restarts = sc.get("restarts", 0) + (1 if n >= sc.get("restart_after", 10**9) else 0)
    if n >= sc.get("loop_after", 10**9):
        restarts += 2
    print(json.dumps(state) + "|" + str(restarts))
elif args[:1] == ["logs"] and "--tail" in args:
    # progress marker: changes while the app boots unless the scenario says it is stuck
    print("stuck" if sc.get("stalled") else "line-%d" % n)
elif args[:1] == ["logs"]:
    for line in sc.get("fresh_logs", []):
        print(line)
'''

FAKE_CURL = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
fx = Path(os.environ["FX"])
sc = json.loads((fx / "scenario.json").read_text())
n = int((fx / "polls").read_text()) if (fx / "polls").exists() else 0
url = sys.argv[-1]
if url.endswith("/ready"):
    if n >= sc.get("ready_after", 0):
        print(sc.get("ready_body", "ok"), end="")
        sys.exit(0)
    sys.exit(22)
if n >= sc.get("health_after", 0):
    print("ok", end="")
    sys.exit(0)
sys.exit(22 if sc.get("answers_503") else 7)
'''


class HealthVerdictTests(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fx = Path(self.tmp.name)
        bin_dir = self.fx / "bin"
        bin_dir.mkdir()
        for name, body in (("docker", FAKE_DOCKER), ("curl", FAKE_CURL)):
            (bin_dir / name).write_text(body)
            (bin_dir / name).chmod(0o755)
        self.bin = bin_dir
        self.proc = self.fx / "proc"
        (self.proc / "pressure").mkdir(parents=True)
        self.set_host(io=0.0, load=0.1)

    def set_host(self, io, load):
        (self.proc / "pressure/io").write_text(f"some avg10={io:.2f} avg60=1.00 avg300=1.00 total=1\nfull avg10=0 avg60=0 avg300=0 total=1\n")
        (self.proc / "loadavg").write_text(f"{load} 1.0 1.0 1/100 123\n")

    def wait(self, scenario, *flags, baseline_ready="ok", mode="ready"):
        (self.fx / "scenario.json").write_text(json.dumps(scenario))
        (self.fx / "polls").unlink(missing_ok=True)
        env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}", FX=str(self.fx))
        cmd = [
            sys.executable, str(SCRIPT), "wait", "--container", "hypercal-bot", "--url", "https://example.invalid",
            "--mode", mode, "--baseline-ready", baseline_ready, "--poll", "0.02", "--stable", "0.1",
            "--base-budget", "0.5", "--hard-cap", "2", "--stall", "0.5", "--proc-dir", str(self.proc), *flags,
        ]
        done = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=30)
        line = next((l for l in done.stdout.splitlines() if l.startswith("RESULT ")), "")
        return done.returncode, line, done.stdout

    def test_healthy_release_is_ok_once_stable(self):
        code, line, _ = self.wait({})
        self.assertEqual(code, 0, line)
        self.assertIn("verdict=ok", line)

    def test_slow_start_under_io_saturation_is_extended_not_failed(self):
        # The 2026-10-24 incident: health answers only after the base budget while the host is saturated.
        self.set_host(io=60.0, load=9.0)
        code, line, out = self.wait({"health_after": 14, "answers_503": True}, "--base-budget", "0.1", "--hard-cap", "8")
        self.assertEqual(code, 0, line + out)
        self.assertIn("extended past", out)

    def test_same_slow_start_on_a_quiet_host_fails_at_the_budget(self):
        code, line, _ = self.wait({"health_after": 10**6})
        self.assertEqual(code, 4, line)
        self.assertIn("verdict=unhealthy", line)
        self.assertIn("host not saturated", line)

    def test_saturated_host_never_extends_past_the_hard_cap(self):
        self.set_host(io=80.0, load=12.0)
        code, line, _ = self.wait({"health_after": 10**6, "answers_503": True})
        self.assertEqual(code, 4, line)
        self.assertIn("hard cap", line)

    def test_alive_but_silent_container_is_not_extended(self):
        self.set_host(io=80.0, load=12.0)
        code, line, _ = self.wait({"health_after": 10**6, "stalled": True})
        self.assertEqual(code, 4, line)
        self.assertIn("no progress", line)

    def test_exited_container_is_dead_immediately(self):
        code, line, _ = self.wait({"dies_after": 2, "health_after": 10**6})
        self.assertEqual(code, 3, line)
        self.assertIn("verdict=dead", line)
        self.assertIn("exit_code=1", line)

    def test_missing_container_is_dead(self):
        code, line, _ = self.wait({"missing": True})
        self.assertEqual(code, 3, line)

    def test_crash_loop_is_dead(self):
        code, line, _ = self.wait({"loop_after": 2, "health_after": 10**6})
        self.assertEqual(code, 3, line)
        self.assertIn("crash loop", line)

    def test_oom_kill_is_dead(self):
        code, line, _ = self.wait({"state": {"OOMKilled": True}})
        self.assertEqual(code, 3, line)

    def test_single_restart_restarts_the_stability_window_but_is_not_a_failure(self):
        code, line, _ = self.wait({"restart_after": 3})
        self.assertEqual(code, 0, line)

    def test_fatal_log_line_is_dead(self):
        code, line, _ = self.wait({"fresh_logs": ['{"level":60,"msg":"boom"}']})
        self.assertEqual(code, 3, line)
        self.assertIn("fatal", line)

    def test_error_storm_fails_but_a_few_errors_are_reported(self):
        errors = ['{"level":50,"msg":"x"}'] * 6
        code, line, _ = self.wait({"fresh_logs": errors})
        self.assertEqual(code, 4, line)
        code, line, _ = self.wait({"fresh_logs": errors[:2]})
        self.assertEqual(code, 0, line)
        self.assertIn("2 level>=50", line)

    def test_readiness_is_required_when_it_was_ok_before(self):
        code, line, _ = self.wait({"ready_after": 10**6})
        self.assertEqual(code, 4, line)

    def test_readiness_already_failing_before_the_deploy_is_not_this_releases_fault(self):
        code, line, out = self.wait({"ready_after": 10**6}, baseline_ready="ai chain down")
        self.assertEqual(code, 0, line)
        self.assertIn("ready not required", out)

    def test_an_unavailable_baseline_probe_proves_nothing_so_readiness_is_required(self):
        code, line, out = self.wait({"ready_after": 10**6}, baseline_ready="")
        self.assertEqual(code, 4, line)
        self.assertNotIn("ready not required", out)

    def test_a_docker_api_hiccup_is_not_a_dead_container(self):
        code, line, _ = self.wait({"inspect_error_polls": [1, 2]})
        self.assertEqual(code, 0, line)

    def test_a_docker_api_that_keeps_failing_is_unhealthy_not_dead(self):
        code, line, _ = self.wait({"inspect_error_polls": list(range(1, 100))})
        self.assertEqual(code, 4, line)
        self.assertIn("docker inspect failed", line)

    def test_unverified_readiness_counts_as_ready(self):
        code, line, _ = self.wait({"ready_body": "ok (unverified)"})
        self.assertEqual(code, 0, line)

    def test_health_mode_ignores_readiness(self):
        code, line, _ = self.wait({"ready_after": 10**6}, mode="health")
        self.assertEqual(code, 0, line)

    def test_result_bodies_are_sanitized_for_the_shell_caller(self):
        code, line, _ = self.wait({"ready_body": "ok (unverified)"})
        self.assertNotRegex(line, r"[;$`]")


if __name__ == "__main__":
    sys.exit(unittest.main())
