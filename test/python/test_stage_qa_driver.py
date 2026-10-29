"""Tests for scripts/stage-qa-driver.py (the odroid driver of the per-PR stage QA, #840).

The driver runs as a subprocess against two fakes in a temp dir: a python script playing the root wrapper
(config `wrapper`; it reads the token line, prints STAGE_READY per scenario, waits for DONE) and a fake `ssh`
in PATH playing the browser host's forced command (it records the exact argv, prints STAGE_BROWSER_LOCKED when the
scenario lets it, reads the READY payload line, prints scenario output and a STAGE_QA_RESULT line, exits with the
scenario's status). Both append timestamped events to jsonl files, so the tests can assert on order and content. Nothing here talks to Telegram, ssh, sudo, qa-cli
or the network.
"""

import importlib.util
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DRIVER = ROOT / "scripts/stage-qa-driver.py"

SHA = "a" * 40
OTHER_SHA = "b" * 40
FAKE_TOKEN = "fake-test-token-not-a-secret-0001"
# Odd spacing and a non-ASCII character: the payload must be forwarded byte for byte, not re-serialised.
PAYLOAD = '{"stage_url":"http://127.0.0.1:1",  "peer" : "123456789", "name":"caf\u00e9"}'

FAKE_WRAPPER = """#!@PY@
import json, os, sys, time
here = os.path.dirname(os.path.abspath(__file__))
sc = json.load(open(os.path.join(here, "wrapper_scenario.json")))


def rec(**kw):
    with open(os.path.join(here, "wrapper_events.jsonl"), "a") as handle:
        handle.write(json.dumps({"ts": time.time(), **kw}) + "\\n")


def say(line):
    sys.stdout.buffer.write((line + "\\n").encode())
    sys.stdout.buffer.flush()


rec(event="start", argv=sys.argv[1:], env=dict(os.environ), pid=os.getpid())
token = sys.stdin.readline().rstrip("\\n")
rec(event="token", token=token)
for line in sc.get("pre", []):
    say(line)
for line in sc.get("pre_err", []):
    sys.stderr.write(line + "\\n")
    sys.stderr.flush()
if "exit_before_ready" in sc:
    rec(event="exit")
    sys.exit(sc["exit_before_ready"])
if sc.get("ready") is not None:
    say("STAGE_READY " + sc["ready"])
if "exit_after_ssh_payload" in sc:
    deadline = time.time() + 30
    path = os.path.join(here, "ssh_events.jsonl")
    while time.time() < deadline and "payload" not in (open(path).read() if os.path.exists(path) else ""):
        time.sleep(0.05)
    rec(event="exit")
    sys.exit(sc["exit_after_ssh_payload"])
if sc.get("ignore_done"):
    time.sleep(600)
while True:
    line = sys.stdin.readline()
    if not line:
        rec(event="eof")
        break
    if line.strip() == "DONE":
        rec(event="done")
        break
time.sleep(sc.get("teardown_delay", 0))
rec(event="teardown_done")
for line in sc.get("post", []):
    say(line)
sys.exit(sc.get("rc", 0))
"""

FAKE_SSH = """#!@PY@
import json, os, select, sys, time
here = os.path.dirname(os.path.abspath(__file__))
sc = json.load(open(os.path.join(here, "ssh_scenario.json")))


def rec(**kw):
    with open(os.path.join(here, "ssh_events.jsonl"), "a") as handle:
        handle.write(json.dumps({"ts": time.time(), **kw}) + "\\n")


def finish():
    for line in sc.get("out", []):
        print(line, flush=True)
    for line in sc.get("err", []):
        sys.stderr.write(line + "\\n")
        sys.stderr.flush()
    if sc.get("hang"):
        time.sleep(600)
    if sc.get("result"):
        print(sc["result"], flush=True)
    sys.exit(sc.get("rc", 0))


rec(event="start", argv=sys.argv[1:], env=dict(os.environ), pid=os.getpid())
if sc.get("before_locked"):
    # The connection fails, or the browser half refuses/gives up, before it holds its lock.
    finish()
if sc.get("lock_hang"):
    time.sleep(600)
if sc.get("lock_gate"):
    # The browser lock is held by someone else until the test creates this file.
    while not os.path.exists(sc["lock_gate"]):
        time.sleep(0.05)
print("STAGE_BROWSER_LOCKED", flush=True)
rec(event="locked")
if sc.get("die_after_locked"):
    finish()
buf = b""
while not buf.endswith(b"\\n"):
    chunk = os.read(0, 1)
    if not chunk:
        break
    buf += chunk
if not buf:
    # The driver closed the connection before it sent a payload: the browser half fails and frees its lock.
    rec(event="eof_before_payload")
    print("STAGE_QA_RESULT status=failed sha=" + sys.argv[-1] + " cases=0 failed=0", flush=True)
    sys.exit(1)
rec(event="payload", payload=buf.decode())
if sc.get("probe_stdin"):
    time.sleep(0.3)
    readable, _, _ = select.select([0], [], [], 0)
    extra, eof = b"", False
    if readable:
        extra = os.read(0, 4096)
        eof = extra == b""
    rec(event="stdin_probe", extra=extra.decode(), eof=eof)
finish()
"""


def result(status="passed", cases=7, failed=0, sha=SHA):
    return f"STAGE_QA_RESULT status={status} sha={sha} cases={cases} failed={failed}"


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


def read_events(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line]


def find(events, name):
    return next((event for event in events if event["event"] == name), None)


class Run:
    def __init__(self, proc, out, err, wrapper, ssh):
        self.code, self.out, self.err = proc.returncode, out, err
        self.wrapper, self.ssh = wrapper, ssh

    @property
    def result_lines(self):
        return [line for line in self.out.splitlines() if line.startswith("STAGE_QA_RESULT")]


class DriverCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="stage-qa-driver-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        for name, body in (("fake-wrapper", FAKE_WRAPPER), ("ssh", FAKE_SSH)):
            path = self.bin / name
            path.write_text(body.replace("@PY@", sys.executable))
            path.chmod(0o755)
        self.wrapper_path = self.bin / "fake-wrapper"
        self.key = self.tmp / "key"
        self.key.write_text("not a key\n")
        self.known_hosts = self.tmp / "known_hosts"
        self.known_hosts.write_text("")
        self.config_path = self.tmp / "driver.json"
        self.config = {
            "wrapper": [str(self.wrapper_path)],
            "browser_target": "qa@browser.example",
            "browser_key": str(self.key),
        }
        self.write_config()
        self.wrapper_scenario()
        self.ssh_scenario()
        self.addCleanup(self.reap)

    def reap(self):
        for events in (
            read_events(self.bin / "wrapper_events.jsonl"),
            read_events(self.bin / "ssh_events.jsonl"),
        ):
            for event in events:
                if event["event"] == "start" and alive(event["pid"]):
                    os.kill(event["pid"], signal.SIGKILL)

    def write_config(self, mode=0o644, raw=None):
        self.config_path.write_text(raw if raw is not None else json.dumps(self.config))
        self.config_path.chmod(mode)

    def wrapper_scenario(self, **scenario):
        (self.bin / "wrapper_scenario.json").write_text(json.dumps({"ready": PAYLOAD, **scenario}))

    def ssh_scenario(self, **scenario):
        (self.bin / "ssh_scenario.json").write_text(json.dumps({"result": result(), **scenario}))

    def events(self, which):
        return read_events(self.bin / f"{which}_events.jsonl")

    def wait_event(self, which, name, seconds=30):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            event = find(self.events(which), name)
            if event:
                return event
            time.sleep(0.05)
        self.fail(f"no {name} event from the fake {which} within {seconds}s")

    def start(self, args=None, token=FAKE_TOKEN + "\n", path=None, env=None):
        args = [SHA, "--config", str(self.config_path)] if args is None else args
        env = {
            "PATH": str(self.bin),
            "PYTHONIOENCODING": "utf-8",
            "HOME": str(self.tmp),
            **(env or {}),
        }
        if path is not None:
            env["PATH"] = path
        proc = subprocess.Popen(
            [sys.executable, str(DRIVER), *args],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            env=env,
        )
        if token is not None:
            proc.stdin.write(token)
            proc.stdin.flush()
        return proc

    def finish(self, proc, timeout=90):
        try:
            out, err = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            out, err = proc.communicate()
            self.fail(f"driver did not finish in {timeout}s\nstdout:\n{out}\nstderr:\n{err}")
        return Run(proc, out, err, self.events("wrapper"), self.events("ssh"))

    def run_driver(self, **kwargs):
        timeout = kwargs.pop("timeout", 90)
        token = kwargs.pop("token", FAKE_TOKEN + "\n")
        return self.finish(self.start(token=token, **kwargs), timeout)

    def assert_result(self, run, code, status, cases=0, failed=0, sha=SHA):
        self.assertEqual(run.code, code, run.err)
        self.assertEqual(run.out, result(status, cases, failed, sha) + "\n", run.err)

    def assert_done_sent(self, run):
        names = [event["event"] for event in run.wrapper]
        self.assertIn("done", names, run.err)
        self.assertIn("teardown_done", names, "the driver did not wait for the wrapper's teardown")
        self.assertLess(names.index("done"), names.index("teardown_done"))
        self.assertFalse(alive(find(run.wrapper, "start")["pid"]))

    def assert_no_payload_sent(self, run):
        self.assertIsNotNone(find(run.ssh, "start"))
        self.assertIsNone(find(run.ssh, "payload"), "no payload may reach the browser host")

    def assert_ssh_closed_without_payload(self, run):
        """The browser half got EOF before a payload (it exits, so its lock is free) and the process is gone."""
        self.assert_no_payload_sent(run)
        self.assertIsNotNone(find(run.ssh, "eof_before_payload"), run.err)
        self.assertTrue(wait_dead(find(run.ssh, "start")["pid"]))

    def assert_not_provisioned(self, run):
        self.assert_result(run, 3, "not-provisioned")
        self.assertIn("STAGE_QA_NOT_PROVISIONED", run.err)
        self.assertEqual(run.wrapper, [])
        self.assertEqual(run.ssh, [])


class VerdictTest(DriverCase):
    def test_pass_prints_only_the_result_line_on_stdout(self):
        self.wrapper_scenario(
            pre=["wrapper chatter", result("passed", 99, 0)],
            pre_err=["wrapper stderr"],
            post=["teardown chatter"],
        )
        self.ssh_scenario(
            out=["browser chatter"], err=["browser stderr"], result=result("passed", 9, 0)
        )
        run = self.run_driver()
        self.assert_result(run, 0, "passed", cases=9)
        for text in (
            "wrapper chatter",
            "wrapper stderr",
            "browser chatter",
            "browser stderr",
            "teardown chatter",
        ):
            self.assertIn(text, run.err)
        self.assertNotIn("cases=99", run.out)
        self.assert_done_sent(run)

    def test_browser_exit_codes_are_the_verdict(self):
        table = {
            1: ("failed", result("failed", 6, 2), 6, 2),
            2: ("refused", result("refused", 0, 0), 0, 0),
            3: ("not-provisioned", result("not-provisioned", 0, 0), 0, 0),
            75: ("lock-timeout", result("lock-timeout", 0, 0), 0, 0),
        }
        for code, (status, line, cases, failed) in table.items():
            with self.subTest(code=code):
                self.setUp()
                self.ssh_scenario(rc=code, result=line)
                run = self.run_driver()
                self.assert_result(run, code, status, cases, failed)
                self.assert_done_sent(run)

    def test_browser_failure_without_result_line_has_zero_counts(self):
        self.ssh_scenario(rc=1, result=None)
        self.assert_result(self.run_driver(), 1, "failed")

    def test_exit_zero_without_a_result_line_is_a_failure(self):
        self.ssh_scenario(rc=0, result=None)
        self.assert_result(self.run_driver(), 1, "failed")

    def test_exit_zero_with_a_non_pass_result_line_is_a_failure(self):
        for line in (result("failed", 7, 1), result("passed", 7, 1), result("refused", 7, 0)):
            with self.subTest(line=line):
                self.setUp()
                self.ssh_scenario(rc=0, result=line)
                run = self.run_driver()
                self.assertEqual(run.code, 1, run.err)
                self.assertEqual(len(run.result_lines), 1)
                self.assertIn("status=failed", run.out)

    def test_exit_zero_with_zero_cases_is_a_failure(self):
        self.ssh_scenario(rc=0, result=result("passed", 0, 0))
        self.assert_result(self.run_driver(), 1, "failed")

    def test_the_driver_has_no_case_floor_of_its_own(self):
        # The floor of cases is enforced by the wrapper and the browser half; here one real case is enough.
        self.ssh_scenario(rc=0, result=result("passed", 1, 0))
        self.assert_result(self.run_driver(), 0, "passed", cases=1)

    def test_min_cases_is_no_longer_a_config_key(self):
        self.config["min_cases"] = 5
        self.write_config()
        run = self.run_driver()
        self.assert_not_provisioned(run)
        self.assertIn("unknown key", run.err)

    def test_a_result_line_for_another_commit_is_not_a_verdict(self):
        for rc, line in (
            (0, result("passed", 7, 0, OTHER_SHA)),
            (1, result("failed", 7, 1, OTHER_SHA)),
            (0, result("passed", 7, 0, "-")),
        ):
            with self.subTest(rc=rc, line=line):
                self.setUp()
                self.ssh_scenario(rc=rc, result=line)
                run = self.run_driver()
                self.assertEqual(run.code, 3, run.err)
                self.assertIn("status=not-provisioned", run.out)
                self.assertNotIn("status=passed", run.out)
                self.assertIn("not " + SHA, run.err)
                self.assert_done_sent(run)

    def test_the_last_result_line_of_the_browser_wins(self):
        self.ssh_scenario(rc=0, out=[result("passed", 9, 0)], result=result("failed", 9, 1))
        self.assert_result(self.run_driver(), 1, "failed", cases=9, failed=1)

    def test_unknown_browser_exit_codes_are_not_a_verdict(self):
        for code in (255, 137, 143, 4, 76):
            with self.subTest(code=code):
                self.setUp()
                self.ssh_scenario(rc=code, result=result("passed", 7, 0))
                run = self.run_driver()
                self.assertEqual(run.code, 3, run.err)
                self.assertIn("status=not-provisioned", run.out)
                self.assertNotIn("status=failed", run.out)
                self.assertNotIn("status=passed", run.out)
                self.assert_done_sent(run)

    def test_ssh_that_cannot_connect_is_not_provisioned_and_the_stage_is_never_started(self):
        self.ssh_scenario(
            rc=255, before_locked=True, result=None, err=["ssh: connect to host failed"]
        )
        run = self.run_driver()
        self.assert_result(run, 3, "not-provisioned")
        self.assertIn("connect to host failed", run.err)
        self.assertEqual(run.wrapper, [], "the wrapper must not start without the browser lock")

    def test_browser_refusal_still_sends_done(self):
        self.ssh_scenario(rc=2, result=result("refused", 0, 0))
        run = self.run_driver()
        self.assert_result(run, 2, "refused")
        self.assert_done_sent(run)

    def test_wrapper_exit_after_ready_is_only_logged(self):
        for rc in (1, 3, 76, 0):
            with self.subTest(rc=rc):
                self.setUp()
                self.wrapper_scenario(rc=rc)
                run = self.run_driver()
                self.assert_result(run, 0, "passed", cases=7)
                if rc:
                    self.assertIn(f"stage teardown reported exit status {rc}", run.err)

    def test_wrapper_that_ignores_done_is_killed_after_done_timeout(self):
        self.config["done_timeout"] = 1
        self.write_config()
        self.wrapper_scenario(ignore_done=True)
        run = self.run_driver()
        self.assert_result(run, 0, "passed", cases=7)
        self.assertTrue(wait_dead(find(run.wrapper, "start")["pid"]))
        self.assertIn("did not finish within 1s", run.err)


class BrowserConnectionTest(DriverCase):
    def test_ready_payload_is_forwarded_byte_identical_as_the_first_stdin_line(self):
        self.ssh_scenario(probe_stdin=True)
        run = self.run_driver()
        self.assert_result(run, 0, "passed", cases=7)
        self.assertEqual(find(run.ssh, "payload")["payload"], PAYLOAD + "\n")
        # Nothing else is written, and the connection's stdin is still open when the browser host exits.
        probe = find(run.ssh, "stdin_probe")
        self.assertEqual(probe["extra"], "")
        self.assertFalse(probe["eof"])

    def test_ssh_options_are_exact(self):
        run = self.run_driver()
        self.assertEqual(run.code, 0, run.err)
        self.assertEqual(
            find(run.ssh, "start")["argv"],
            [
                "-i",
                str(self.key),
                "-o",
                "BatchMode=yes",
                "-o",
                "IdentitiesOnly=yes",
                "-o",
                "StrictHostKeyChecking=yes",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=4",
                "-o",
                "ConnectTimeout=30",
                "qa@browser.example",
                SHA,
            ],
        )

    def test_known_hosts_option_when_configured(self):
        self.config["browser_known_hosts"] = str(self.known_hosts)
        self.write_config()
        run = self.run_driver()
        self.assertEqual(run.code, 0, run.err)
        self.assertEqual(
            find(run.ssh, "start")["argv"],
            [
                "-i",
                str(self.key),
                "-o",
                "BatchMode=yes",
                "-o",
                "IdentitiesOnly=yes",
                "-o",
                "StrictHostKeyChecking=yes",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=4",
                "-o",
                "ConnectTimeout=30",
                "-o",
                f"UserKnownHostsFile={self.known_hosts}",
                "qa@browser.example",
                SHA,
            ],
        )

    def test_browser_key_with_tilde_is_expanded(self):
        self.config["browser_key"] = "~/key"
        self.write_config()
        run = self.run_driver()
        self.assertEqual(run.code, 0, run.err)
        self.assertEqual(find(run.ssh, "start")["argv"][1], str(self.key))

    def test_browser_timeout_is_not_a_verdict_and_kills_the_connection(self):
        self.config["browser_timeout"] = 1
        self.write_config()
        self.ssh_scenario(hang=True, result=None)
        run = self.run_driver()
        self.assert_result(run, 3, "not-provisioned")
        self.assertTrue(wait_dead(find(run.ssh, "start")["pid"]))
        self.assertIn("did not finish within 1s", run.err)
        self.assert_done_sent(run)

    def test_wrapper_ending_while_the_browser_runs_kills_ssh_and_takes_the_wrapper_verdict(self):
        for rc, status in (
            (76, "superseded"),
            (1, "failed"),
            (0, "failed"),
            (3, "not-provisioned"),
        ):
            with self.subTest(rc=rc):
                self.setUp()
                self.wrapper_scenario(exit_after_ssh_payload=rc)
                self.ssh_scenario(hang=True, result=None)
                run = self.run_driver()
                self.assert_result(run, rc or 1, status)
                self.assertTrue(wait_dead(find(run.ssh, "start")["pid"]))
                self.assertIn("the wrapper ended while the browser host", run.err)

    def test_ready_timeout_gives_up_and_still_tears_down(self):
        self.config["ready_timeout"] = 1
        self.write_config()
        self.wrapper_scenario(ready=None)
        run = self.run_driver()
        self.assert_result(run, 1, "failed")
        self.assert_ssh_closed_without_payload(run)
        self.assertIn("no STAGE_READY within 1s", run.err)
        self.assert_done_sent(run)

    def test_wrapper_prefix_is_kept_and_the_sha_is_appended(self):
        self.config["wrapper"] = [sys.executable, str(self.wrapper_path)]
        self.write_config()
        run = self.run_driver()
        self.assertEqual(run.code, 0, run.err)
        self.assertEqual(find(run.wrapper, "start")["argv"], [SHA])


class LockOrderTest(DriverCase):
    """The browser lock comes first: the wrapper (whose watchdog starts at its own locks) is started only after it."""

    def test_the_wrapper_starts_only_after_the_browser_half_reported_its_lock(self):
        gate = self.tmp / "release-browser-lock"
        self.ssh_scenario(lock_gate=str(gate))
        proc = self.start()
        self.wait_event("ssh", "start")
        time.sleep(1.5)
        self.assertEqual(
            self.events("wrapper"),
            [],
            "the wrapper must not start while the browser lock is held elsewhere",
        )
        released = time.time()
        gate.write_text("")
        run = self.finish(proc)
        self.assert_result(run, 0, "passed", cases=7)
        locked = find(run.ssh, "locked")["ts"]
        self.assertGreaterEqual(locked, released)
        self.assertGreaterEqual(find(run.wrapper, "start")["ts"], locked)
        self.assertGreaterEqual(find(run.ssh, "payload")["ts"], find(run.wrapper, "start")["ts"])
        self.assert_done_sent(run)

    def test_the_connection_is_opened_with_the_sha_before_any_wrapper_exists(self):
        run = self.run_driver()
        self.assertEqual(run.code, 0, run.err)
        self.assertLess(find(run.ssh, "start")["ts"], find(run.wrapper, "start")["ts"])

    def test_lock_timeout_gives_up_not_runnable_and_never_starts_the_wrapper(self):
        self.config["lock_timeout"] = 1
        self.write_config()
        self.ssh_scenario(lock_hang=True, result=None)
        run = self.run_driver()
        self.assert_result(run, 3, "not-provisioned")
        self.assertEqual(run.wrapper, [])
        self.assertIn("did not take its lock within 1s", run.err)
        self.assertTrue(wait_dead(find(run.ssh, "start")["pid"]))

    def test_browser_half_ending_before_locked_is_the_verdict(self):
        table = {
            75: ("lock-timeout", result("lock-timeout", 0, 0)),
            2: ("refused", result("refused", 0, 0)),
            3: ("not-provisioned", result("not-provisioned", 0, 0)),
            1: ("failed", result("failed", 0, 0)),
        }
        for code, (status, line) in table.items():
            with self.subTest(code=code):
                self.setUp()
                self.ssh_scenario(before_locked=True, rc=code, result=line)
                run = self.run_driver()
                self.assert_result(run, code, status)
                self.assertEqual(run.wrapper, [])

    def test_unknown_browser_exit_before_locked_is_not_a_verdict(self):
        for code in (255, 137, 4, 76):
            with self.subTest(code=code):
                self.setUp()
                self.ssh_scenario(before_locked=True, rc=code, result=result("passed", 7, 0))
                run = self.run_driver()
                self.assert_result(run, 3, "not-provisioned", cases=7)
                self.assertEqual(run.wrapper, [])

    def test_browser_half_exiting_zero_before_locked_is_never_a_pass(self):
        self.ssh_scenario(before_locked=True, rc=0, result=result("passed", 7, 0))
        run = self.run_driver()
        self.assert_result(run, 1, "failed")
        self.assertEqual(run.wrapper, [])

    def test_browser_half_ending_while_the_stage_starts_is_its_verdict_and_done_is_sent(self):
        self.wrapper_scenario(ready=None)
        self.ssh_scenario(die_after_locked=True, rc=75, result=result("lock-timeout", 0, 0))
        run = self.run_driver()
        self.assert_result(run, 75, "lock-timeout")
        self.assertIsNone(find(run.ssh, "payload"))
        self.assert_done_sent(run)

    def test_signal_while_waiting_for_the_browser_lock_never_starts_the_wrapper(self):
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            with self.subTest(signum=signum.name):
                self.setUp()
                self.ssh_scenario(lock_gate=str(self.tmp / "never"))
                proc = self.start()
                self.wait_event("ssh", "start")
                proc.send_signal(signum)
                run = self.finish(proc)
                self.assertEqual(run.code, 128 + signum, run.err)
                self.assertEqual(run.out, result("failed", 0, 0) + "\n")
                self.assertEqual(run.wrapper, [])
                self.assertTrue(wait_dead(find(run.ssh, "start")["pid"]))


class WrapperEndsBeforeReadyTest(DriverCase):
    def test_wrapper_exit_code_table(self):
        table = {
            1: (1, "failed"),
            2: (2, "refused"),
            3: (3, "not-provisioned"),
            4: (4, "infra-error"),
            75: (75, "lock-timeout"),
            76: (76, "superseded"),
            0: (1, "failed"),
            5: (1, "failed"),
            6: (1, "failed"),
            64: (1, "failed"),
            69: (1, "failed"),
            70: (1, "failed"),
            77: (1, "failed"),
            255: (1, "failed"),
            137: (1, "failed"),
        }
        for wrapper_rc, (code, status) in table.items():
            with self.subTest(wrapper_rc=wrapper_rc):
                self.setUp()
                self.wrapper_scenario(exit_before_ready=wrapper_rc, pre_err=["wrapper says no"])
                run = self.run_driver()
                self.assert_result(run, code, status)
                # The connection is already open (the lock is held); it is closed without a payload.
                self.assert_ssh_closed_without_payload(run)
                self.assertIn("wrapper says no", run.err)

    def test_wrapper_result_line_is_not_copied_to_stdout(self):
        self.wrapper_scenario(exit_before_ready=2, pre=[result("refused", 0, 0, SHA)])
        run = self.run_driver()
        self.assert_result(run, 2, "refused")
        self.assertIn("wrapper: STAGE_QA_RESULT", run.err)


class TokenTest(DriverCase):
    def test_token_goes_only_to_the_wrapper_stdin(self):
        self.ssh_scenario(probe_stdin=True, out=["x"], err=["y"])
        run = self.run_driver()
        self.assertEqual(run.code, 0, run.err)
        self.assertEqual(find(run.wrapper, "token")["token"], FAKE_TOKEN)
        start = json.dumps(find(run.wrapper, "start"))
        self.assertNotIn(FAKE_TOKEN, start)
        self.assertNotIn(FAKE_TOKEN, json.dumps(run.ssh))
        self.assertNotIn(FAKE_TOKEN, run.out)
        self.assertNotIn(FAKE_TOKEN, run.err)

    def test_token_is_not_leaked_when_the_wrapper_fails(self):
        self.wrapper_scenario(exit_before_ready=1)
        run = self.run_driver()
        self.assertNotIn(FAKE_TOKEN, run.out + run.err)
        self.assertNotIn(FAKE_TOKEN, json.dumps(run.ssh))
        self.assert_no_payload_sent(run)


class SignalTest(DriverCase):
    def assert_signalled(self, run, signum):
        self.assertEqual(run.code, 128 + signum, run.err)
        self.assertEqual(run.out, result("failed", 0, 0) + "\n")
        self.assertIn(f"terminated by signal {signum}", run.err)
        self.assert_done_sent(run)
        for event in run.ssh:
            if event["event"] == "start":
                self.assertTrue(wait_dead(event["pid"]))

    def test_signal_while_the_browser_runs(self):
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            with self.subTest(signum=signum.name):
                self.setUp()
                self.ssh_scenario(hang=True, result=None)
                proc = self.start()
                self.wait_event("ssh", "payload")
                proc.send_signal(signum)
                self.assert_signalled(self.finish(proc), signum)

    def test_signal_before_ready(self):
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            with self.subTest(signum=signum.name):
                self.setUp()
                self.wrapper_scenario(ready=None)
                proc = self.start()
                self.wait_event("wrapper", "token")
                proc.send_signal(signum)
                run = self.finish(proc)
                self.assert_signalled(run, signum)
                self.assert_no_payload_sent(run)

    def test_signal_during_teardown_does_not_cut_the_wrapper(self):
        self.wrapper_scenario(teardown_delay=1)
        proc = self.start()
        self.wait_event("wrapper", "done")
        proc.send_signal(signal.SIGTERM)
        run = self.finish(proc)
        self.assertEqual(run.code, 128 + signal.SIGTERM, run.err)
        self.assertIn("teardown_done", [event["event"] for event in run.wrapper])

    def test_children_run_in_their_own_session(self):
        self.wrapper_scenario(ready=None)
        proc = self.start()
        pid = self.wait_event("wrapper", "start")["pid"]
        self.assertNotEqual(os.getpgid(pid), os.getpgid(proc.pid))
        proc.send_signal(signal.SIGTERM)
        self.finish(proc)


class RefusedInputTest(DriverCase):
    def refused(self, run, sha="-"):
        self.assert_result(run, 2, "refused", sha=sha)
        self.assertEqual(run.wrapper, [])
        self.assertEqual(run.ssh, [])

    def test_bad_sha_is_refused(self):
        for sha in ("a" * 39, "a" * 41, "A" * 40, "g" * 40, "main", ""):
            with self.subTest(sha=sha):
                self.refused(self.run_driver(args=[sha, "--config", str(self.config_path)]))

    def test_missing_or_unknown_arguments_are_refused(self):
        self.refused(self.run_driver(args=[]))
        self.refused(self.run_driver(args=[SHA, "--bogus"]))
        self.refused(self.run_driver(args=[SHA, SHA]))

    def test_help_flags_are_refused_and_stdout_carries_only_the_result_line(self):
        for args in (["--help"], ["-h"], ["--help", "--config", str(self.config_path)]):
            with self.subTest(args=args):
                run = self.run_driver(args=args)
                self.refused(run)
                self.assertEqual(run.out.count("\n"), 1, run.out)

    def test_missing_or_malformed_token_is_refused(self):
        for token in ("", "\n", "has space\n", "tab\there\n", "x" * 4097 + "\n", "caf\u00e9\n"):
            with self.subTest(token=token[:12]):
                self.refused(self.run_driver(token=token), sha=SHA)

    def test_missing_token_is_refused_before_the_config_is_read(self):
        self.config_path.unlink()
        self.refused(self.run_driver(token=""), sha=SHA)

    def test_maximal_token_is_accepted(self):
        run = self.run_driver(token="t" * 4096 + "\n")
        self.assertEqual(run.code, 0, run.err)
        self.assertEqual(find(run.wrapper, "token")["token"], "t" * 4096)


class ConfigTest(DriverCase):
    def refuse_config(self, message=None):
        run = self.run_driver()
        self.assert_not_provisioned(run)
        if message:
            self.assertIn(message, run.err)

    def test_missing_config(self):
        self.config_path.unlink()
        self.refuse_config("not found")

    def test_config_that_is_not_a_regular_file(self):
        self.config_path.unlink()
        self.config_path.mkdir()
        self.refuse_config("not a regular file")

    def test_group_or_other_writable_config_is_refused(self):
        for mode in (0o664, 0o646, 0o666, 0o620):
            with self.subTest(mode=oct(mode)):
                self.write_config(mode=mode)
                self.refuse_config("must not be able to write")

    def test_readable_modes_are_accepted(self):
        for mode in (0o600, 0o644, 0o640):
            with self.subTest(mode=oct(mode)):
                self.setUp()
                self.write_config(mode=mode)
                self.assertEqual(self.run_driver().code, 0)

    def test_invalid_json(self):
        for raw in ("{not json", "", "[]", '"text"', "null"):
            with self.subTest(raw=raw):
                self.write_config(raw=raw)
                self.refuse_config()

    def test_unknown_and_missing_keys(self):
        self.config["surprise"] = 1
        self.write_config()
        self.refuse_config("unknown key")
        del self.config["surprise"]
        del self.config["browser_target"]
        self.write_config()
        self.refuse_config("missing required key browser_target")
        self.config["browser_target"] = "qa@browser.example"
        del self.config["browser_key"]
        self.write_config()
        self.refuse_config("missing required key browser_key")

    def test_bad_browser_target(self):
        for target in (
            "browserexample",
            "a b@host",
            "-oProxyCommand=x@host",
            "qa@",
            "@host",
            "",
            5,
            "qa@host;ls",
        ):
            with self.subTest(target=target):
                self.config["browser_target"] = target
                self.write_config()
                self.refuse_config()

    def test_bad_values(self):
        cases = {
            "wrapper": ([], "sudo", [""], [1], None),
            "lock_timeout": (0, -5, "10", None),
            "ready_timeout": (0, -5, "10", None),
            "browser_timeout": (0, -5, "10", None),
            "done_timeout": (0, -5, "10", None),
            "browser_key": ("relative/key", "", 5),
            "browser_known_hosts": ("relative/kh", "", 5),
        }
        pristine = dict(self.config)
        for key, values in cases.items():
            for value in values:
                with self.subTest(key=key, value=value):
                    # Every value is tried on its own against a good config, so the refusal can only be its.
                    self.config = {**pristine, key: value}
                    self.write_config()
                    self.refuse_config(f"config: {key} must")

    def test_missing_key_file(self):
        self.key.unlink()
        self.refuse_config("ssh key")

    def test_missing_known_hosts_file(self):
        self.config["browser_known_hosts"] = str(self.tmp / "nope")
        self.write_config()
        self.refuse_config("known_hosts")

    def test_ssh_not_found(self):
        (self.tmp / "empty").mkdir()
        run = self.run_driver(path=str(self.tmp / "empty"))
        self.assert_not_provisioned(run)
        self.assertIn("ssh client not found", run.err)

    def test_wrapper_not_installed(self):
        for wrapper in (
            [str(self.bin / "missing-wrapper")],
            [sys.executable, str(self.bin / "missing-wrapper")],
            ["no-such-command-xyz", str(self.wrapper_path)],
        ):
            with self.subTest(wrapper=wrapper):
                self.config["wrapper"] = wrapper
                self.write_config()
                self.refuse_config()

    def test_not_provisioned_never_starts_children_even_with_a_valid_token(self):
        self.config["lock_timeout"] = 0
        self.write_config()
        run = self.run_driver()
        self.assert_not_provisioned(run)
        self.assertNotIn(FAKE_TOKEN, run.out + run.err)


class ModuleConstantsTest(unittest.TestCase):
    def test_defaults(self):
        sys.path.insert(0, str(DRIVER.parent))
        try:
            spec = importlib.util.spec_from_file_location("stage_qa_driver_under_test", DRIVER)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        finally:
            sys.path.remove(str(DRIVER.parent))
        self.assertEqual(module.DEFAULT_CONFIG, "/etc/hypercal-stage-qa/driver.json")
        self.assertEqual(
            module.DEFAULTS["wrapper"], ["sudo", "-n", "/usr/local/sbin/hypercal-stage-qa"]
        )
        self.assertNotIn("min_cases", module.DEFAULTS)
        self.assertEqual(module.DEFAULTS["lock_timeout"], 3000)
        self.assertEqual(module.DEFAULTS["ready_timeout"], 5700)
        self.assertEqual(module.DEFAULTS["browser_timeout"], 1800)
        self.assertEqual(module.DEFAULTS["done_timeout"], 600)
        # Each wait covers what the other half may legitimately spend before it answers (pinned against the real
        # browser half, not copies of its numbers).
        sys.path.insert(0, str(DRIVER.parent))
        try:
            browser_spec = importlib.util.spec_from_file_location(
                "stage_qa_browser_for_driver_constants", DRIVER.parent / "stage-qa-browser.py"
            )
            browser = importlib.util.module_from_spec(browser_spec)
            browser_spec.loader.exec_module(browser)
        finally:
            sys.path.remove(str(DRIVER.parent))
        self.assertGreater(module.DEFAULT_LOCK_TIMEOUT, browser.DEFAULTS["lock_max_wait"])
        self.assertGreater(
            module.DEFAULT_READY_TIMEOUT, 3000 + 2400
        )  # stage lock + host deploy lock of the wrapper
        self.assertGreater(module.DEFAULT_BROWSER_TIMEOUT, browser.DEFAULTS["smoke_timeout"])
        self.assertGreaterEqual(browser.DEFAULTS["payload_wait"], module.DEFAULT_READY_TIMEOUT)
        self.assertTrue(re.fullmatch(r"/etc/hypercal-stage-qa/[a-z.]+", module.DEFAULT_CONFIG))


if __name__ == "__main__":
    unittest.main()
