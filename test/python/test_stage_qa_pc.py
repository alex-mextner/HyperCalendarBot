"""Tests for scripts/stage-qa-pc.py (the PC driver of the per-PR stage QA, #840) and its installer.

The odroid side is a fake `ssh` (a python script that plays the forced-command wrapper: it reads the
token line, prints STAGE_READY / STAGE_QA_RESULT per scenario and waits for DONE) and the engine is a
stub stage-smoke.py in a temp lib dir next to a copy of the driver, because the driver runs
`<its own dir>/stage-smoke.py run ...`. Nothing here talks to Telegram, ssh, qa-cli or the network.
"""
import fcntl
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DRIVER = ROOT / "scripts/stage-qa-pc.py"
INSTALLER = ROOT / "scripts/install-stage-qa-pc.sh"

SHA = "a" * 40
OTHER_SHA = "b" * 40
FAKE_TOKEN = "fake-test-token-not-a-secret-0001"
USERNAME = "HyperCalendarStageBot"
PEER = "123456789"
REQUIRED = ["start", "ping", "today-read-only-calendar", "simple-intent-phrase", "validation-search-without-query"]

FAKE_SSH = '''#!@PY@
import json, os, sys, time
here = os.path.dirname(os.path.abspath(__file__))
sc = json.load(open(os.path.join(here, "ssh_scenario.json")))


def rec(**kw):
    with open(sc["log"], "a") as handle:
        handle.write(json.dumps(kw) + "\\n")


def result():
    print("STAGE_QA_RESULT status=odroid sha=%s cases=0 failed=0" % sc.get("sha", "-"), flush=True)


rec(event="start", argv=sys.argv[1:], env=dict(os.environ))
secret = sys.stdin.readline().rstrip("\\n")
rec(event="token", token=secret)
for line in sc.get("stderr_lines", []):
    print(line, file=sys.stderr, flush=True)
for line in sc.get("stdout_lines", []):
    print(line, flush=True)


def wait_for_done():
    line = sys.stdin.readline()
    rec(event="done" if line.strip() == "DONE" else "eof", line=line)
    time.sleep(sc.get("teardown_seconds", 0))
    rec(event="finished")


mode = sc["mode"]
if mode == "ready":
    if "ready_raw" in sc:
        print("STAGE_READY " + sc["ready_raw"], flush=True)
    else:
        print("STAGE_READY " + json.dumps(sc["ready"]), flush=True)
    for line in sc.get("stdout_lines_after_ready", []):
        print(line, flush=True)
    if "die_after_ready" in sc:
        time.sleep(sc.get("die_after_ready_delay", 0))
        result()
        sys.exit(sc["die_after_ready"])
    wait_for_done()
elif mode == "silent":
    wait_for_done()
result()
sys.exit(sc.get("rc", 0))
'''

STUB_SMOKE = '''#!@PY@
import json, os, stat, subprocess, sys, time
here = os.path.dirname(os.path.abspath(__file__))
sc = json.load(open(os.path.join(here, "smoke_scenario.json")))
args = sys.argv[1:]
cases_path = args[args.index("--cases-json") + 1] if "--cases-json" in args else None
record = {
    "argv": args,
    "env": dict(os.environ),
    "ppid": os.getppid(),
    "owner": open(sc["owner_file"]).read() if sc.get("owner_file") else None,
}
if cases_path:
    record["cases_mode"] = stat.S_IMODE(os.stat(cases_path).st_mode)
    record["cases"] = json.load(open(cases_path))
with open(sc["record"], "w") as handle:
    json.dump(record, handle)
for line in sc.get("stdout_lines", []):
    print(line, flush=True)
for line in sc.get("stderr_lines", []):
    print(line, file=sys.stderr, flush=True)
if sc.get("sleep"):
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    with open(sc["marker"], "w") as handle:
        json.dump({"pid": os.getpid(), "child": child.pid}, handle)
    time.sleep(sc["sleep"])
if sc.get("final"):
    print(sc["final"], flush=True)
sys.exit(sc.get("rc", 0))
'''


def write_exe(path, text):
    path.write_text(text.replace("@PY@", sys.executable))
    path.chmod(0o755)


def base_cases(names=None):
    return [{"name": name, "send": "/x", "expect": {"text_contains": ["ok"]}} for name in (names or REQUIRED)]


def ready_payload(**overrides):
    cases = base_cases()
    payload = {"sha": SHA, "username": USERNAME, "peer": PEER, "cases": cases, "base_cases": len(cases)}
    payload.update(overrides)
    return payload


def alive(pid):
    try:
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[0]
    except (FileNotFoundError, ProcessLookupError):
        return False
    return state != "Z"


def wait_dead(pid, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not alive(pid):
            return True
        time.sleep(0.1)
    return not alive(pid)


def start_ticks(pid):
    return Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[19]


class DriverCase(unittest.TestCase):
    """Temp lib dir (driver copy + stub smoke), fake ssh in PATH, temp config/state."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.lib = self.tmp / "lib"
        self.bin = self.tmp / "bin"
        self.state = self.tmp / "state"
        self.lib.mkdir()
        self.bin.mkdir()
        shutil.copy(DRIVER, self.lib / "stage-qa-pc.py")
        write_exe(self.lib / "stage-smoke.py", STUB_SMOKE)
        write_exe(self.bin / "ssh", FAKE_SSH)
        self.qa = self.tmp / "qa"
        write_exe(self.qa, "#!/bin/sh\nexit 0\n")
        self.key = self.tmp / "id_ed25519"
        self.key.write_text("not a real key\n")
        self.key.chmod(0o600)
        self.lock = self.tmp / "qa.lock"
        self.ssh_log = self.tmp / "ssh.log"
        self.smoke_record = self.tmp / "smoke-record.json"
        self.marker = self.tmp / "smoke-marker.json"
        self.config = {
            "ssh_target": "root@odroidn2",
            "ssh_key": str(self.key),
            "username": USERNAME,
            "deny_usernames": ["HyperCalendarBot"],
            "qa_bin": str(self.qa),
            "python": sys.executable,
            "lock_file": str(self.lock),
            "lock_max_wait": 5,
            "state_dir": str(self.state),
            "min_cases": 5,
            "required_cases": REQUIRED,
            "smoke_timeout": 30,
            "ready_timeout": 30,
            "done_timeout": 30,
        }
        self.config_path = self.tmp / "config.json"
        self.write_config()
        self.set_ssh(mode="ready", ready=ready_payload(), sha=SHA)
        self.set_smoke(final=f"STAGE_SMOKE_PASSED sha={SHA} bot=@{USERNAME} cases=5 failed=0")
        self.env = {"PATH": f"{self.bin}:/usr/bin:/bin", "HOME": str(self.tmp)}

    def write_config(self, mode=0o600):
        self.config_path.write_text(json.dumps(self.config))
        self.config_path.chmod(mode)

    def set_ssh(self, **scenario):
        scenario["log"] = str(self.ssh_log)
        (self.bin / "ssh_scenario.json").write_text(json.dumps(scenario))

    def set_smoke(self, **scenario):
        scenario["record"] = str(self.smoke_record)
        scenario["marker"] = str(self.marker)
        (self.lib / "smoke_scenario.json").write_text(json.dumps(scenario))

    def argv(self, sha=SHA, config=True):
        argv = [sys.executable, str(self.lib / "stage-qa-pc.py"), sha]
        if config:
            argv += ["--config", str(self.config_path)]
        return argv

    def spawn(self, sha=SHA, token=FAKE_TOKEN + "\n", config=True):
        process = subprocess.Popen(self.argv(sha, config), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, env=self.env)
        process.stdin.write(token)
        process.stdin.close()
        return process

    def run_driver(self, sha=SHA, token=FAKE_TOKEN + "\n", config=True):
        process = subprocess.Popen(self.argv(sha, config), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, env=self.env)
        out, err = process.communicate(token, timeout=60)
        return process.returncode, out, err

    def ssh_events(self):
        if not self.ssh_log.exists():
            return []
        return [json.loads(line) for line in self.ssh_log.read_text().splitlines()]

    def ssh_event(self, name):
        found = [event for event in self.ssh_events() if event["event"] == name]
        return found[0] if found else None

    def smoke(self):
        return json.loads(self.smoke_record.read_text())

    def assert_result(self, out, status, sha=SHA, cases=0, failed=0):
        self.assertEqual(out, f"STAGE_QA_RESULT status={status} sha={sha} cases={cases} failed={failed}\n")

    def assert_done_sent_and_waited(self):
        self.assertIsNotNone(self.ssh_event("done"), self.ssh_events())
        self.assertIsNotNone(self.ssh_event("finished"), self.ssh_events())


class Verdicts(DriverCase):
    def test_pass_prints_only_the_result_on_stdout_and_forwards_the_rest_to_stderr(self):
        self.set_ssh(mode="ready", ready=ready_payload(), sha=SHA, stderr_lines=["odroid says hello"],
                     stdout_lines=["odroid stdout noise"])
        self.set_smoke(stdout_lines=["SMOKE PASS start 0.5s"], stderr_lines=["smoke stderr line"],
                       final=f"STAGE_SMOKE_PASSED sha={SHA} bot=@{USERNAME} cases=5 failed=0")
        rc, out, err = self.run_driver()
        self.assertEqual(rc, 0, err)
        self.assert_result(out, "passed", cases=5, failed=0)
        for line in ("odroid says hello", "odroid stdout noise", "SMOKE PASS start 0.5s", "smoke stderr line"):
            self.assertIn(line, err)
        self.assert_done_sent_and_waited()

    def test_ssh_is_started_with_the_exact_options_and_the_token_goes_through_stdin_only(self):
        rc, out, err = self.run_driver()
        self.assertEqual(rc, 0, err)
        start = self.ssh_event("start")
        self.assertEqual(start["argv"], [
            "-i", str(self.key), "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes",
            "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4", "-o", "ConnectTimeout=30",
            "root@odroidn2", SHA])
        self.assertEqual(self.ssh_event("token")["token"], FAKE_TOKEN)
        self.assertNotIn(FAKE_TOKEN, json.dumps(start))
        self.assertNotIn(FAKE_TOKEN, json.dumps(self.smoke()))
        self.assertNotIn(FAKE_TOKEN, out + err)

    def test_known_hosts_file_from_the_config_is_passed_to_ssh(self):
        known = self.tmp / "known_hosts"
        known.write_text("odroidn2 ssh-ed25519 AAAA\n")
        self.config["ssh_known_hosts"] = str(known)
        self.write_config()
        rc, _, err = self.run_driver()
        self.assertEqual(rc, 0, err)
        argv = self.ssh_event("start")["argv"]
        self.assertIn(f"UserKnownHostsFile={known}", argv)
        self.assertEqual(argv[-2:], ["root@odroidn2", SHA])

    def test_smoke_child_gets_the_validated_cases_in_a_private_file(self):
        extra = {"name": "replayed", "send": "/y", "expect": {"text_contains": ["ok"]}}
        cases = [*base_cases(), extra]
        self.set_ssh(mode="ready", ready=ready_payload(cases=cases, base_cases=5), sha=SHA)
        self.set_smoke(final=f"STAGE_SMOKE_PASSED sha={SHA} bot=@{USERNAME} cases=6 failed=0")
        rc, out, err = self.run_driver()
        self.assertEqual(rc, 0, err)
        self.assert_result(out, "passed", cases=6, failed=0)
        record = self.smoke()
        argv = record["argv"]
        self.assertEqual(argv[:2], ["run", "--cases-json"])
        self.assertEqual(argv[3:], [
            "--username", USERNAME, "--peer", PEER, "--sha", SHA, "--deny", "HyperCalendarBot",
            "--receipt", str(self.state / "receipts" / f"{SHA}.json"), "--qa-bin", str(self.qa),
            "--min-cases", "5", "--base-cases", "5"])
        self.assertEqual(record["cases"], cases)
        self.assertEqual(record["cases_mode"], 0o600)
        self.assertFalse(Path(argv[2]).exists(), "the cases file must be removed after the run")
        self.assertEqual(stat.S_IMODE((self.state / "receipts").stat().st_mode), 0o700)

    def test_username_match_is_case_insensitive_but_the_smoke_gets_the_configured_name(self):
        self.set_ssh(mode="ready", ready=ready_payload(username=USERNAME.lower()), sha=SHA)
        rc, _, err = self.run_driver()
        self.assertEqual(rc, 0, err)
        self.assertEqual(self.smoke()["argv"][self.smoke()["argv"].index("--username") + 1], USERNAME)

    def test_a_failed_case_is_exit_1_with_the_counts_of_the_smoke(self):
        self.set_smoke(rc=1, final=f"STAGE_SMOKE_FAILED sha={SHA} bot=@{USERNAME} cases=5 failed=2")
        rc, out, err = self.run_driver()
        self.assertEqual(rc, 1, err)
        self.assert_result(out, "failed", cases=5, failed=2)
        self.assert_done_sent_and_waited()

    def test_smoke_refused_is_2_and_qa_unavailable_is_3_and_done_is_still_sent(self):
        for smoke_rc, status, expected in ((64, "refused", 2), (69, "not-provisioned", 3)):
            with self.subTest(smoke_rc=smoke_rc):
                self.ssh_log.unlink(missing_ok=True)
                self.set_smoke(rc=smoke_rc, stderr_lines=["qa problem"])
                rc, out, err = self.run_driver()
                self.assertEqual(rc, expected, err)
                self.assert_result(out, status)
                self.assert_done_sent_and_waited()

    def test_smoke_crash_or_unknown_exit_is_a_failure(self):
        self.set_smoke(rc=137)
        rc, out, _ = self.run_driver()
        self.assertEqual(rc, 1)
        self.assert_result(out, "failed")

    def test_exit_0_without_a_pass_summary_is_not_a_pass(self):
        for final in (None, f"STAGE_SMOKE_FAILED sha={SHA} bot=@{USERNAME} cases=5 failed=1",
                      f"STAGE_SMOKE_PASSED sha={SHA} bot=@{USERNAME} cases=0 failed=0",
                      f"STAGE_SMOKE_PASSED sha={SHA} bot=@{USERNAME} cases=4 failed=0"):
            with self.subTest(final=final):
                self.set_smoke(rc=0, final=final)
                rc, out, err = self.run_driver()
                self.assertEqual(rc, 1, err)
                self.assertIn("status=failed", out)
                self.assertNotIn("status=passed", out)

    def test_a_teardown_problem_on_the_odroid_is_logged_not_a_verdict(self):
        self.set_ssh(mode="ready", ready=ready_payload(), sha=SHA, rc=1)
        rc, out, err = self.run_driver()
        self.assertEqual(rc, 0, err)
        self.assert_result(out, "passed", cases=5)
        self.assertRegex(err, r"teardown")


class WrapperEndsBeforeReady(DriverCase):
    def test_the_wrapper_exit_code_is_the_verdict_and_nothing_runs(self):
        table = ((76, "superseded"), (2, "refused"), (3, "not-provisioned"), (75, "lock-timeout"), (1, "failed"))
        for wrapper_rc, status in table:
            with self.subTest(wrapper_rc=wrapper_rc):
                self.ssh_log.unlink(missing_ok=True)
                self.smoke_record.unlink(missing_ok=True)
                self.set_ssh(mode="result_only", rc=wrapper_rc, sha=SHA, stderr_lines=["wrapper explains"])
                rc, out, err = self.run_driver()
                self.assertEqual(rc, wrapper_rc, err)
                self.assert_result(out, status)
                self.assertIn("wrapper explains", err)
                self.assertFalse(self.smoke_record.exists())

    def test_wrapper_exit_0_without_ready_is_never_a_pass(self):
        self.set_ssh(mode="result_only", rc=0, sha=SHA)
        rc, out, err = self.run_driver()
        self.assertEqual(rc, 1, err)
        self.assert_result(out, "failed")

    def test_unexpected_ssh_exit_codes_collapse_to_failure(self):
        for wrapper_rc in (255, 9, 143):
            with self.subTest(wrapper_rc=wrapper_rc):
                self.set_ssh(mode="result_only", rc=wrapper_rc, sha=SHA)
                rc, out, _ = self.run_driver()
                self.assertEqual(rc, 1)
                self.assert_result(out, "failed")

    def test_no_ready_within_the_deadline_is_a_failure_and_done_is_sent(self):
        self.config["ready_timeout"] = 1
        self.write_config()
        self.set_ssh(mode="silent", sha=SHA)
        rc, out, err = self.run_driver()
        self.assertEqual(rc, 1, err)
        self.assert_result(out, "failed")
        self.assert_done_sent_and_waited()
        self.assertFalse(self.smoke_record.exists())

    def test_ssh_dying_after_ready_kills_the_smoke_and_fails(self):
        self.set_ssh(mode="ready", ready=ready_payload(), sha=SHA, die_after_ready=1, die_after_ready_delay=1)
        self.set_smoke(sleep=60)
        started = time.monotonic()
        rc, out, err = self.run_driver()
        self.assertLess(time.monotonic() - started, 30)
        self.assertEqual(rc, 1, err)
        self.assert_result(out, "failed")
        ids = json.loads(self.marker.read_text())
        self.assertTrue(wait_dead(ids["pid"]) and wait_dead(ids["child"]))

    def test_ssh_ending_cleanly_after_ready_without_done_is_not_a_pass(self):
        self.set_ssh(mode="ready", ready=ready_payload(), sha=SHA, die_after_ready=0, die_after_ready_delay=1)
        self.set_smoke(sleep=60)
        rc, out, err = self.run_driver()
        self.assertEqual(rc, 1, err)
        self.assert_result(out, "failed")


class ReadyValidation(DriverCase):
    def refuses(self, payload=None, raw=None):
        self.ssh_log.unlink(missing_ok=True)
        self.smoke_record.unlink(missing_ok=True)
        if raw is not None:
            self.set_ssh(mode="ready", ready_raw=raw, sha=SHA)
        else:
            self.set_ssh(mode="ready", ready=payload, sha=SHA)
        rc, out, err = self.run_driver()
        self.assertEqual(rc, 2, err)
        self.assert_result(out, "refused")
        self.assertFalse(self.smoke_record.exists(), "the smoke must not run on a refused READY")
        self.assert_done_sent_and_waited()
        self.assertNotIn(FAKE_TOKEN, out + err)

    def test_every_untrusted_ready_is_refused_with_done_still_sent(self):
        base = base_cases()
        replaced = [dict(c, name="other") if c["name"] == "ping" else c for c in base]
        duplicate = [*base[:4], base[0]]
        scenarios = {
            "sha mismatch": ready_payload(sha=OTHER_SHA),
            "wrong username": ready_payload(username="SomeOtherStageBot"),
            "prod username": ready_payload(username="HyperCalendarBot"),
            "username missing": {k: v for k, v in ready_payload().items() if k != "username"},
            "non numeric peer": ready_payload(peer="12ab"),
            "peer is an int": ready_payload(peer=123),
            "empty peer": ready_payload(peer=""),
            "empty cases": ready_payload(cases=[], base_cases=0),
            "short list": ready_payload(cases=base[:4], base_cases=4),
            "extras do not fill the floor": ready_payload(cases=[*base[:4], dict(base[4], name="extra")], base_cases=4),
            "missing required": ready_payload(cases=replaced, base_cases=5),
            "base_cases larger than the list": ready_payload(base_cases=99),
            "base_cases not an int": ready_payload(base_cases="5"),
            "base_cases bool": ready_payload(base_cases=True),
            "duplicate names": ready_payload(cases=duplicate, base_cases=5),
            "case not an object": ready_payload(cases=["start"] * 5, base_cases=5),
            "case without a name": ready_payload(cases=[{"send": "/x"}] * 5, base_cases=5),
            "payload is a list": [],
        }
        for label, payload in scenarios.items():
            with self.subTest(label):
                self.refuses(payload)

    def test_ready_that_is_not_json_is_refused(self):
        for raw in ("{not json", "", "null", "[1]"):
            with self.subTest(raw=raw):
                self.refuses(raw=raw)

    def test_required_case_only_in_the_extras_does_not_count(self):
        base = [dict(c, name=f"filler-{i}") for i, c in enumerate(base_cases())]
        self.refuses(ready_payload(cases=[*base, *base_cases(["start"])], base_cases=5))

    def test_a_second_ready_line_is_ignored_and_does_not_start_a_second_run(self):
        self.set_ssh(mode="ready", ready=ready_payload(), sha=SHA,
                     stdout_lines_after_ready=["STAGE_READY " + json.dumps(ready_payload(username="evil"))])
        rc, out, err = self.run_driver()
        self.assertEqual(rc, 0, err)
        self.assert_result(out, "passed", cases=5)


class NotProvisioned(DriverCase):
    def expect_not_provisioned(self, needle):
        rc, out, err = self.run_driver()
        self.assertEqual(rc, 3, err)
        self.assert_result(out, "not-provisioned")
        self.assertIn("STAGE_QA_NOT_PROVISIONED:", err)
        self.assertIn(needle, err)
        self.assertEqual(self.ssh_events(), [], "no ssh before the PC is provisioned")

    def test_missing_config(self):
        self.config_path.unlink()
        self.expect_not_provisioned("config")

    def test_config_that_is_not_json_or_not_an_object(self):
        for text in ("{nope", "[1]", ""):
            with self.subTest(text=text):
                self.config_path.write_text(text)
                self.config_path.chmod(0o600)
                self.expect_not_provisioned("config")

    def test_config_with_group_or_world_access_is_refused(self):
        self.write_config(mode=0o644)
        self.expect_not_provisioned("mode")

    def test_unknown_or_missing_keys_and_bad_values(self):
        bad = {
            "unknown key": ("sudo", True),
            "target with option injection": ("ssh_target", "-oProxyCommand=x@h"),
            "target without user": ("ssh_target", "odroidn2"),
            "username without stage": ("username", "HyperCalendarBot"),
            "username in the deny list": ("deny_usernames", [USERNAME]),
            "deny not a list": ("deny_usernames", "HyperCalendarBot"),
            "min_cases zero": ("min_cases", 0),
            "min_cases bool": ("min_cases", True),
            "required not a list": ("required_cases", "start"),
            "required empty": ("required_cases", []),
            "lock wait negative": ("lock_max_wait", -1),
            "smoke timeout zero": ("smoke_timeout", 0),
            "relative lock file": ("lock_file", "qa.lock"),
        }
        pristine = dict(self.config)
        for label, (key, value) in bad.items():
            with self.subTest(label):
                self.config = dict(pristine)
                self.config[key] = value
                self.write_config()
                self.expect_not_provisioned("config")
        for key in ("ssh_target", "ssh_key", "username"):
            with self.subTest(missing=key):
                self.config = {k: v for k, v in pristine.items() if k != key}
                self.write_config()
                self.expect_not_provisioned(key)

    def test_missing_ssh_key_or_qa_binary_or_known_hosts(self):
        pristine = dict(self.config)
        for key, needle in (("ssh_key", "ssh key"), ("qa_bin", "qa"), ("ssh_known_hosts", "known")):
            with self.subTest(key):
                self.config = dict(pristine)
                self.config[key] = str(self.tmp / "absent")
                self.write_config()
                self.expect_not_provisioned(needle)

    def test_qa_binary_that_is_not_executable(self):
        self.qa.chmod(0o644)
        self.expect_not_provisioned("qa")

    def test_missing_ssh_client(self):
        self.env["PATH"] = str(self.tmp / "empty")
        self.expect_not_provisioned("ssh")

    def test_defaults_fill_the_optional_keys(self):
        for key in ("deny_usernames", "min_cases", "required_cases", "lock_max_wait", "smoke_timeout",
                    "ready_timeout", "done_timeout"):
            self.config.pop(key)
        self.write_config()
        rc, out, err = self.run_driver()
        self.assertEqual(rc, 0, err)
        argv = self.smoke()["argv"]
        self.assertEqual(argv[argv.index("--min-cases") + 1], "5")


class ArgumentsAndToken(DriverCase):
    def test_bad_sha_is_refused_before_anything_runs(self):
        for sha in ("nothex", "A" * 40, "a" * 39, "a" * 41, "a" * 40 + "\n"):
            with self.subTest(sha=sha):
                rc, out, err = self.run_driver(sha=sha)
                self.assertEqual(rc, 2, err)
                self.assert_result(out, "refused", sha="-")
                self.assertEqual(self.ssh_events(), [])

    def test_missing_sha_is_refused(self):
        process = subprocess.run([sys.executable, str(self.lib / "stage-qa-pc.py")], input=FAKE_TOKEN + "\n",
                                 capture_output=True, text=True, env=self.env, timeout=30)
        self.assertEqual(process.returncode, 2)
        self.assert_result(process.stdout, "refused", sha="-")

    def test_empty_or_malformed_token_is_refused(self):
        for token in ("", "\n", "has space\n", "a" * 5000 + "\n"):
            with self.subTest(token=token[:12]):
                rc, out, err = self.run_driver(token=token)
                self.assertEqual(rc, 2, err)
                self.assert_result(out, "refused")
                self.assertEqual(self.ssh_events(), [])

    def test_token_without_trailing_newline_is_accepted(self):
        rc, _, err = self.run_driver(token=FAKE_TOKEN)
        self.assertEqual(rc, 0, err)
        self.assertEqual(self.ssh_event("token")["token"], FAKE_TOKEN)

    def test_default_config_path_comes_from_home(self):
        home_cfg = self.tmp / ".config/hypercal-stage-qa/config.json"
        home_cfg.parent.mkdir(parents=True)
        home_cfg.write_text(json.dumps(self.config))
        home_cfg.chmod(0o600)
        rc, out, err = self.run_driver(config=False)
        self.assertEqual(rc, 0, err)
        self.assert_result(out, "passed", cases=5)


class PcLock(DriverCase):
    def hold(self, release_after=None, owner=True):
        fd = os.open(self.lock, os.O_RDWR | os.O_CREAT, 0o666)
        fcntl.flock(fd, fcntl.LOCK_EX)
        if owner:
            Path(str(self.lock) + ".owner").write_text(
                f"repo=esb-qa\npid={os.getpid()}\nstart_ticks={start_ticks(os.getpid())}\nstarted=2026-10-26T00:00:00Z\n")
        state = {"open": True}

        def release():
            if state["open"]:
                state["open"] = False
                fcntl.flock(fd, fcntl.LOCK_UN)
                os.close(fd)

        if release_after is None:
            self.addCleanup(release)
        else:
            timer = threading.Timer(release_after, release)
            timer.start()
            self.addCleanup(timer.cancel)
            self.addCleanup(release)

    def test_a_held_lock_is_waited_for_logged_and_then_the_run_proceeds(self):
        self.config["lock_max_wait"] = 30
        self.write_config()
        self.hold(release_after=1.5)
        rc, out, err = self.run_driver()
        self.assertEqual(rc, 0, err)
        self.assert_result(out, "passed", cases=5)
        self.assertIn("waiting", err)
        self.assertIn("esb-qa", err)
        self.assertIn(f"pid={os.getpid()}", err)

    def test_wait_gives_up_with_75_and_never_starts_ssh(self):
        self.config["lock_max_wait"] = 1
        self.write_config()
        self.hold()
        started = time.monotonic()
        rc, out, err = self.run_driver()
        self.assertLess(time.monotonic() - started, 20)
        self.assertEqual(rc, 75, err)
        self.assert_result(out, "lock-timeout")
        self.assertEqual(self.ssh_events(), [])
        self.assertIn("esb-qa", err)

    def test_stale_owner_file_is_described_as_stale(self):
        self.config["lock_max_wait"] = 1
        self.write_config()
        self.hold(owner=False)
        Path(str(self.lock) + ".owner").write_text("repo=esb-qa\npid=999999\nstart_ticks=1\nstarted=x\n")
        rc, _, err = self.run_driver()
        self.assertEqual(rc, 75)
        self.assertIn("stale", err)

    def test_the_driver_records_itself_as_owner_while_running_and_clears_it_after(self):
        self.set_smoke(owner_file=str(self.lock) + ".owner",
                       final=f"STAGE_SMOKE_PASSED sha={SHA} bot=@{USERNAME} cases=5 failed=0")
        rc, _, err = self.run_driver()
        self.assertEqual(rc, 0, err)
        owner = dict(line.split("=", 1) for line in self.smoke()["owner"].splitlines())
        self.assertEqual(owner["repo"], "hcb-stage-qa-pc")
        self.assertEqual(owner["pid"], str(self.smoke()["ppid"]))
        self.assertRegex(owner["start_ticks"], r"^[0-9]+$")
        self.assertEqual(Path(str(self.lock) + ".owner").read_text(), "")

    def test_the_lock_is_free_after_the_run(self):
        rc, _, err = self.run_driver()
        self.assertEqual(rc, 0, err)
        fd = os.open(self.lock, os.O_RDWR)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)


class Signals(DriverCase):
    def wait_for_marker(self, process):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if self.marker.exists() and self.marker.read_text():
                return json.loads(self.marker.read_text())
            if process.poll() is not None:
                self.fail(f"driver ended early: {process.communicate()}")
            time.sleep(0.1)
        process.kill()
        self.fail("the smoke never started")

    def test_signal_mid_smoke_sends_done_waits_for_ssh_and_kills_the_smoke(self):
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            with self.subTest(signal=signum.name):
                self.ssh_log.unlink(missing_ok=True)
                self.marker.unlink(missing_ok=True)
                self.set_ssh(mode="ready", ready=ready_payload(), sha=SHA, teardown_seconds=1)
                self.set_smoke(sleep=60)
                process = self.spawn()
                ids = self.wait_for_marker(process)
                process.send_signal(signum)
                out, err = process.communicate(timeout=30)
                self.assertEqual(process.returncode, 128 + signum.value, err)
                self.assertTrue(out.startswith("STAGE_QA_RESULT status=failed sha="), out)
                self.assertEqual(len(out.splitlines()), 1)
                self.assert_done_sent_and_waited()
                self.assertTrue(wait_dead(ids["pid"]) and wait_dead(ids["child"]), "smoke process group must die")
                fd = os.open(self.lock, os.O_RDWR)
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    os.close(fd)

    def test_a_second_signal_during_teardown_does_not_cut_the_wait(self):
        self.set_ssh(mode="ready", ready=ready_payload(), sha=SHA, teardown_seconds=2)
        self.set_smoke(sleep=60)
        process = self.spawn()
        self.wait_for_marker(process)
        process.send_signal(signal.SIGTERM)
        time.sleep(0.7)
        process.send_signal(signal.SIGTERM)
        out, err = process.communicate(timeout=30)
        self.assertEqual(process.returncode, 143, err)
        self.assertIsNotNone(self.ssh_event("finished"), "ssh must be waited for even after a second signal")

    def test_signal_while_waiting_for_the_lock_exits_without_ssh(self):
        self.config["lock_max_wait"] = 60
        self.write_config()
        fd = os.open(self.lock, os.O_RDWR | os.O_CREAT, 0o666)
        fcntl.flock(fd, fcntl.LOCK_EX)
        self.addCleanup(os.close, fd)
        process = self.spawn()
        time.sleep(1)
        process.send_signal(signal.SIGTERM)
        out, err = process.communicate(timeout=30)
        self.assertEqual(process.returncode, 143, err)
        self.assertTrue(out.startswith("STAGE_QA_RESULT status=failed"), out)
        self.assertEqual(self.ssh_events(), [])

    def test_signal_while_waiting_for_ready_sends_done_and_waits(self):
        self.set_ssh(mode="silent", sha=SHA, teardown_seconds=1)
        process = self.spawn()
        deadline = time.monotonic() + 30
        while self.ssh_event("token") is None and time.monotonic() < deadline:
            time.sleep(0.1)
        process.send_signal(signal.SIGTERM)
        out, err = process.communicate(timeout=30)
        self.assertEqual(process.returncode, 143, err)
        self.assert_done_sent_and_waited()


class SmokeTimeout(DriverCase):
    def test_a_hung_smoke_is_killed_with_its_whole_process_group(self):
        self.config["smoke_timeout"] = 2
        self.write_config()
        self.set_smoke(sleep=60)
        started = time.monotonic()
        rc, out, err = self.run_driver()
        self.assertLess(time.monotonic() - started, 40)
        self.assertEqual(rc, 1, err)
        self.assert_result(out, "failed")
        self.assertIn("timed out", err)
        ids = json.loads(self.marker.read_text())
        self.assertTrue(wait_dead(ids["pid"]) and wait_dead(ids["child"]))
        self.assert_done_sent_and_waited()


class SshTeardownWait(DriverCase):
    def test_a_stuck_ssh_is_killed_after_the_done_deadline(self):
        self.config["done_timeout"] = 1
        self.write_config()
        self.set_ssh(mode="ready", ready=ready_payload(), sha=SHA, teardown_seconds=30)
        started = time.monotonic()
        rc, out, err = self.run_driver()
        self.assertLess(time.monotonic() - started, 25)
        self.assertEqual(rc, 0, err)
        self.assert_result(out, "passed", cases=5)
        self.assertRegex(err, r"teardown")


class Static(unittest.TestCase):
    def test_driver_has_no_telethon_and_never_puts_the_token_in_argv_or_env(self):
        text = DRIVER.read_text()
        self.assertNotIn("telethon", text.lower())
        self.assertNotRegex(text, r"env\[[^\]]*TOKEN")
        self.assertNotRegex(text, r"shell\s*=\s*True")

    def test_scripts_parse(self):
        subprocess.run([sys.executable, "-c", f"import ast; ast.parse(open({str(DRIVER)!r}).read())"], check=True)
        subprocess.run(["bash", "-n", str(INSTALLER)], check=True)


def rewrite(text, replacements):
    for old, new in replacements:
        if old not in text:
            raise AssertionError(f"installer no longer contains {old!r}")
        text = text.replace(old, new)
    return text


class Installer(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.src = self.tmp / "checkout"
        (self.src / "scripts").mkdir(parents=True)
        self.lib = self.home / ".local/lib/hypercal-stage-qa"
        self.entry = self.home / ".local/bin/hypercal-stage-qa-pc"
        self.config = self.home / ".config/hypercal-stage-qa/config.json"
        self.key = self.home / ".ssh/hypercal-stage-qa_ed25519"
        self.lock = self.home / ".local/state/hypercal-stage-qa/qa.lock"
        self.write_checkout("one")
        self.git("init", "-q", "-b", "main")
        self.commit("initial")
        self.publish()
        self.script = self.make_script()

    def make_script(self, forbidden_euid=None):
        replacements = [("readonly PC_LOCK_WAIT=60\n", "readonly PC_LOCK_WAIT=1\n")]
        if forbidden_euid is not None:
            replacements.append(("readonly FORBIDDEN_EUID=0\n", f"readonly FORBIDDEN_EUID={forbidden_euid}\n"))
        script = self.tmp / "install-stage-qa-pc.sh"
        script.write_text(rewrite(INSTALLER.read_text(), replacements))
        script.chmod(0o755)
        return script

    def write_checkout(self, version):
        (self.src / "scripts/stage-qa-pc.py").write_text(DRIVER.read_text() + f"\n# {version}\n")
        (self.src / "scripts/stage-smoke.py").write_text(f"# stage-smoke {version}\n")

    def git(self, *args):
        subprocess.run(["git", "-C", str(self.src), "-c", "user.name=t", "-c", "user.email=t@t", *args],
                       check=True, capture_output=True)

    def publish(self):
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")

    def commit(self, message):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)

    def install(self, *args, script=None):
        return subprocess.run([str(script or self.script), *(args or (str(self.src),))], capture_output=True,
                              text=True, env={"PATH": "/usr/bin:/bin", "HOME": str(self.home)}, timeout=60)

    def test_fresh_install_lays_out_lib_entry_config_and_key(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(p.name for p in self.lib.iterdir()), ["stage-qa-pc.py", "stage-smoke.py"])
        self.assertEqual((self.lib / "stage-smoke.py").read_text(), "# stage-smoke one\n")
        self.assertTrue((self.lib / "stage-qa-pc.py").read_text().endswith("# one\n"))
        entry = self.entry.read_text()
        self.assertTrue(entry.startswith("#!"))
        self.assertIn(f'exec python3 {self.lib}/stage-qa-pc.py "$@"', entry)
        self.assertEqual(stat.S_IMODE(self.entry.stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE(self.config.stat().st_mode), 0o600)
        config = json.loads(self.config.read_text())
        self.assertEqual(config, {
            "ssh_target": "root@odroidn2",
            "ssh_key": "~/.ssh/hypercal-stage-qa_ed25519",
            "username": "HyperCalendarStageBot",
            "deny_usernames": ["HyperCalendarBot"],
            "qa_bin": "~/.local/bin/qa",
            "python": "python3",
            "lock_file": "~/.local/state/hypercal-stage-qa/qa.lock",
            "lock_max_wait": 2700,
            "state_dir": "~/.local/state/hypercal-stage-qa",
            "min_cases": 5,
            "required_cases": REQUIRED,
        })
        self.assertEqual(stat.S_IMODE(self.key.stat().st_mode), 0o600)
        self.assertTrue(self.key.with_name(self.key.name + ".pub").exists())
        self.assertEqual(sorted(p.name for p in self.lib.parent.iterdir() if ".new" in p.name or ".bak" in p.name), [])

    def test_prints_the_authorized_keys_line_and_the_rollback(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        public = self.key.with_name(self.key.name + ".pub").read_text().split()
        line = f'restrict,command="/usr/local/sbin/hypercal-stage-qa" {public[0]} {public[1]} hypercal-stage-qa-pc'
        self.assertIn(line + "\n", result.stdout)
        self.assertRegex(result.stdout, r"(?m)^rollback: .+")
        self.assertNotIn("PRIVATE KEY", result.stdout + result.stderr)

    def test_reinstall_keeps_config_and_key_backs_up_and_the_rollback_restores(self):
        self.assertEqual(self.install().returncode, 0)
        self.config.write_text('{"edited": true}\n')
        key_before = self.key.read_text()
        self.write_checkout("two")
        self.commit("second")
        self.publish()
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config.read_text(), '{"edited": true}\n')
        self.assertEqual(self.key.read_text(), key_before)
        self.assertEqual((self.lib / "stage-smoke.py").read_text(), "# stage-smoke two\n")
        backups = [p for p in self.lib.parent.iterdir() if ".bak-" in p.name]
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / "stage-smoke.py").read_text(), "# stage-smoke one\n")
        rollback = re.search(r"(?m)^rollback: (.+)$", result.stdout).group(1)
        done = subprocess.run(["bash", "-c", rollback], capture_output=True, text=True,
                              env={"PATH": "/usr/bin:/bin", "HOME": str(self.home)})
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual((self.lib / "stage-smoke.py").read_text(), "# stage-smoke one\n")
        self.assertTrue((self.lib / "stage-qa-pc.py").read_text().endswith("# one\n"))
        self.assertIn("exec python3", self.entry.read_text())

    def test_first_install_rollback_removes_what_it_created(self):
        result = self.install()
        rollback = re.search(r"(?m)^rollback: (.+)$", result.stdout).group(1)
        done = subprocess.run(["bash", "-c", rollback], capture_output=True, text=True,
                              env={"PATH": "/usr/bin:/bin", "HOME": str(self.home)})
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertFalse(self.lib.exists())
        self.assertFalse(self.entry.exists())

    def test_dirty_untracked_or_missing_sources_are_refused_and_the_old_install_stays(self):
        self.assertEqual(self.install().returncode, 0)
        (self.src / "scripts/stage-smoke.py").write_text("# tampered\n")
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("uncommitted", result.stderr)
        self.assertEqual((self.lib / "stage-smoke.py").read_text(), "# stage-smoke one\n")
        (self.src / "scripts/stage-smoke.py").unlink()
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing", result.stderr)

    def test_head_must_be_on_origin_main(self):
        self.write_checkout("two")
        self.commit("not on main")
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("origin/main", result.stderr)
        self.assertFalse(self.lib.exists())
        self.git("update-ref", "-d", "refs/remotes/origin/main")
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("origin/main", result.stderr)

    def test_not_a_git_checkout_is_refused(self):
        shutil.rmtree(self.src / ".git")
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("git checkout", result.stderr)

    def test_root_is_refused(self):
        script = self.make_script(forbidden_euid=os.getuid())
        result = self.install(script=script)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("normal user", result.stderr)
        self.assertFalse(self.lib.exists())

    def test_a_running_qa_blocks_the_swap(self):
        self.lock.parent.mkdir(parents=True)
        fd = os.open(self.lock, os.O_RDWR | os.O_CREAT, 0o666)
        fcntl.flock(fd, fcntl.LOCK_EX)
        self.addCleanup(os.close, fd)
        result = self.install()
        self.assertEqual(result.returncode, 75, result.stderr)
        self.assertFalse(self.lib.exists())

    def test_installer_never_talks_to_the_odroid_or_github(self):
        text = INSTALLER.read_text()
        self.assertNotRegex(text, r"(?m)^\s*(ssh|scp|gh|curl|ssh-copy-id)\s")
        self.assertIn("set -euo pipefail", text)

    def test_the_installed_entry_runs_the_installed_driver_with_the_generated_config(self):
        self.assertEqual(self.install().returncode, 0)
        bin_dir = self.tmp / "bin"
        bin_dir.mkdir()
        write_exe(bin_dir / "ssh", FAKE_SSH)
        log = self.tmp / "ssh.log"
        (bin_dir / "ssh_scenario.json").write_text(
            json.dumps({"mode": "result_only", "rc": 76, "sha": SHA, "log": str(log)}))
        write_exe(self.home / ".local/bin/qa", "#!/bin/sh\nexit 0\n")
        done = subprocess.run([str(self.entry), SHA], input=FAKE_TOKEN + "\n", capture_output=True, text=True,
                              timeout=60, env={"PATH": f"{bin_dir}:/usr/bin:/bin", "HOME": str(self.home)})
        self.assertEqual(done.returncode, 76, done.stderr)
        self.assertEqual(done.stdout, f"STAGE_QA_RESULT status=superseded sha={SHA} cases=0 failed=0\n")
        start = json.loads(log.read_text().splitlines()[0])
        self.assertEqual(start["argv"][:2], ["-i", str(self.key)])
        self.assertEqual(start["argv"][-2:], ["root@odroidn2", SHA])


if __name__ == "__main__":
    unittest.main()
