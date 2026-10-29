"""Tests for scripts/stage-qa-browser.py (the browser half of the per-PR stage QA, #840).

The browser half runs on the QA browser host as an ssh forced command: argv carries the commit SHA, it takes the
browser lock and prints STAGE_BROWSER_LOCKED before it reads anything, the first stdin line is then the stage
instance's STAGE_READY payload, the end of stdin means the odroid driver is gone. It is
run here as a subprocess from a temp lib dir holding copies of stage-qa-browser.py and stage_qa_common.py plus a
STUB stage-smoke.py (the browser half runs `<its own dir>/stage-smoke.py run ...`), with a temp 0600 config.
Nothing here talks to Telegram, ssh, qa-cli, npm, apt or the network.

The stdin pipe stays open until the process ended, exactly like the ssh connection the driver holds open;
closing it early is a driver-gone event and is tested on purpose.
"""

import fcntl
import importlib.util
import itertools
import json
import os
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
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
BROWSER = SCRIPTS / "stage-qa-browser.py"
COMMON = SCRIPTS / "stage_qa_common.py"
LOCKED = "STAGE_BROWSER_LOCKED\n"

SHA = "a" * 40
OTHER_SHA = "b" * 40
USERNAME = "HyperCalendarStageBot"
PEER = "123456789"
REQUIRED = [
    "start",
    "ping",
    "today-read-only-calendar",
    "simple-intent-phrase",
    "validation-search-without-query",
]
PASS_LINE = f"STAGE_SMOKE_PASSED sha={SHA} bot=@{USERNAME} cases=5 failed=0"

STUB_SMOKE = """#!@PY@
import fcntl, json, os, signal, stat, subprocess, sys, time
here = os.path.dirname(os.path.abspath(__file__))
sc = json.load(open(os.path.join(here, "smoke_scenario.json")))
if sc.get("ignore_term"):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
args = sys.argv[1:]
cases_path = args[args.index("--cases-json") + 1] if "--cases-json" in args else None
record = {
    "argv": args,
    "env": dict(os.environ),
    "ppid": os.getppid(),
    "pid": os.getpid(),
    "pgid": os.getpgid(0),
    "stdin": sys.stdin.read(),
    "owner": open(sc["owner_file"]).read() if sc.get("owner_file") else None,
}
if sc.get("lock_file"):
    probe = os.open(sc["lock_file"], os.O_RDONLY)
    try:
        fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
        record["lock_held"] = False
    except BlockingIOError:
        record["lock_held"] = True
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
    child.kill()
if sc.get("final"):
    print(sc["final"], flush=True)
sys.exit(sc.get("rc", 0))
"""


def write_exe(path, text):
    path.write_text(text.replace("@PY@", sys.executable))
    path.chmod(0o755)


def base_cases(names=None):
    return [
        {"name": name, "send": "/x", "expect": {"text_contains": ["ok"]}}
        for name in (names or REQUIRED)
    ]


def ready_payload(**overrides):
    cases = base_cases()
    payload = {
        "sha": SHA,
        "username": USERNAME,
        "peer": PEER,
        "cases": cases,
        "base_cases": len(cases),
    }
    payload.update(overrides)
    return payload


def ready_line(payload=None):
    return json.dumps(ready_payload() if payload is None else payload) + "\n"


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


def load_module():
    sys.path.insert(0, str(SCRIPTS))
    try:
        spec = importlib.util.spec_from_file_location("stage_qa_browser_under_test", BROWSER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(SCRIPTS))
    return module


class Process:
    """One browser-half process; stdout/stderr go to files so reading never blocks the open stdin pipe."""

    def __init__(self, case, argv):
        number = next(case.counter)
        self.out_path = case.tmp / f"out.{number}"
        self.err_path = case.tmp / f"err.{number}"
        self.out_file = self.out_path.open("w")
        self.err_file = self.err_path.open("w")
        case.addCleanup(self.out_file.close)
        case.addCleanup(self.err_file.close)
        self.proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=self.out_file,
            stderr=self.err_file,
            text=True,
            env=case.env,
        )
        case.addCleanup(self.cleanup)

    def cleanup(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        self.close_stdin()

    def send(self, text):
        # The process may already have decided (a refusal needs only the first line) and exited.
        try:
            self.proc.stdin.write(text)
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError, ValueError):
            pass

    def close_stdin(self):
        try:
            self.proc.stdin.close()
        except (BrokenPipeError, OSError, ValueError):
            pass

    def wait(self, timeout=60):
        code = self.proc.wait(timeout=timeout)
        self.close_stdin()
        return code

    @property
    def out(self):
        return self.out_path.read_text()

    @property
    def err(self):
        return self.err_path.read_text()

    def wait_for_out(self, needle, seconds=30):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if needle in self.out:
                return
            if self.proc.poll() is not None:
                break
            time.sleep(0.05)
        self.proc.kill()
        raise AssertionError(f"{needle!r} never appeared on stdout: {self.out!r} {self.err!r}")

    def wait_for_err(self, needle, seconds=30):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if needle in self.err:
                return
            if self.proc.poll() is not None:
                break
            time.sleep(0.1)
        self.proc.kill()
        raise AssertionError(f"{needle!r} never appeared on stderr: {self.err!r}")


class BrowserCase(unittest.TestCase):
    """Temp lib dir (browser copy + common + stub smoke), temp config/state, fake qa binary."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.counter = itertools.count()
        self.lib = self.tmp / "lib"
        self.state = self.tmp / "state"
        self.lib.mkdir()
        shutil.copy(BROWSER, self.lib / "stage-qa-browser.py")
        shutil.copy(COMMON, self.lib / "stage_qa_common.py")
        write_exe(self.lib / "stage-smoke.py", STUB_SMOKE)
        self.qa = self.tmp / "qa"
        write_exe(self.qa, "#!/bin/sh\nexit 0\n")
        self.lock = self.tmp / "qa.lock"
        self.smoke_record = self.tmp / "smoke-record.json"
        self.marker = self.tmp / "smoke-marker.json"
        self.config = {
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
            "payload_wait": 30,
        }
        self.config_path = self.tmp / "browser.json"
        self.write_config()
        self.set_smoke(final=PASS_LINE)
        self.env = {"PATH": "/usr/bin:/bin", "HOME": str(self.tmp)}

    def write_config(self, mode=0o600):
        self.config_path.write_text(json.dumps(self.config))
        self.config_path.chmod(mode)

    def set_smoke(self, **scenario):
        scenario["record"] = str(self.smoke_record)
        scenario["marker"] = str(self.marker)
        (self.lib / "smoke_scenario.json").write_text(json.dumps(scenario))

    def argv(self, sha=SHA, config=True):
        argv = [sys.executable, str(self.lib / "stage-qa-browser.py"), sha]
        if config:
            argv += ["--config", str(self.config_path)]
        return argv

    def spawn(self, sha=SHA, payload=None, config=True):
        """Starts the process and sends the READY line (a str is sent verbatim, None sends the default
        payload, False sends nothing); stdin stays open."""
        process = Process(self, self.argv(sha, config))
        if payload is not False:
            process.send(payload if isinstance(payload, str) else ready_line(payload))
        return process

    def run_browser(self, sha=SHA, payload=None, config=True):
        process = self.spawn(sha, payload, config)
        code = process.wait()
        return code, process.out, process.err

    def smoke(self):
        return json.loads(self.smoke_record.read_text())

    def wait_for_marker(self, process):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if self.marker.exists() and self.marker.read_text():
                return json.loads(self.marker.read_text())
            if process.proc.poll() is not None:
                self.fail(f"browser half ended early: {process.out!r} {process.err!r}")
            time.sleep(0.1)
        process.proc.kill()
        self.fail("the smoke never started")

    def assert_result(self, out, status, sha=SHA, cases=0, failed=0, locked=True):
        """stdout is exactly the LOCKED line (when the lock was taken) and the result line."""
        self.assertEqual(
            out,
            (LOCKED if locked else "")
            + f"STAGE_QA_RESULT status={status} sha={sha} cases={cases} failed={failed}\n",
        )

    def lock_is_held(self):
        fd = os.open(self.lock, os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        finally:
            os.close(fd)
        return False

    def assert_lock_free(self):
        if not self.lock.exists():
            return  # refused before the lock was ever created
        fd = os.open(self.lock, os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(fd)

    def assert_group_dead(self, ids):
        self.assertTrue(
            wait_dead(ids["pid"]) and wait_dead(ids["child"]), "the smoke process group must die"
        )


class Verdicts(BrowserCase):
    def test_pass_prints_only_the_result_on_stdout_and_forwards_the_rest_to_stderr(self):
        self.set_smoke(
            stdout_lines=["SMOKE PASS start 0.5s"],
            stderr_lines=["smoke stderr line"],
            final=PASS_LINE,
        )
        rc, out, err = self.run_browser()
        self.assertEqual(rc, 0, err)
        self.assert_result(out, "passed", cases=5, failed=0)
        for line in ("SMOKE PASS start 0.5s", "smoke stderr line", PASS_LINE):
            self.assertIn(line, err)

    def test_smoke_command_line_cases_file_and_receipts_dir(self):
        extra = {"name": "replayed", "send": "/y", "expect": {"text_contains": ["ok"]}}
        cases = [*base_cases(), extra]
        self.config["deny_usernames"] = ["HyperCalendarBot", "OtherProdBot"]
        self.write_config()
        self.set_smoke(final=f"STAGE_SMOKE_PASSED sha={SHA} bot=@{USERNAME} cases=6 failed=0")
        rc, out, err = self.run_browser(payload=ready_payload(cases=cases, base_cases=5))
        self.assertEqual(rc, 0, err)
        self.assert_result(out, "passed", cases=6, failed=0)
        record = self.smoke()
        argv = record["argv"]
        self.assertEqual(argv[:2], ["run", "--cases-json"])
        self.assertEqual(
            argv[3:],
            [
                "--username",
                USERNAME,
                "--peer",
                PEER,
                "--sha",
                SHA,
                "--deny",
                "HyperCalendarBot",
                "--deny",
                "OtherProdBot",
                "--receipt",
                str(self.state / "receipts" / f"{SHA}.json"),
                "--qa-bin",
                str(self.qa),
                "--min-cases",
                "5",
                "--base-cases",
                "5",
            ],
        )
        self.assertEqual(record["cases"], cases)
        self.assertEqual(record["cases_mode"], 0o600)
        self.assertFalse(Path(argv[2]).exists(), "the cases file must be removed after the run")
        self.assertEqual(Path(argv[2]).parent, self.state)
        self.assertEqual(stat.S_IMODE((self.state / "receipts").stat().st_mode), 0o700)

    def test_smoke_runs_in_its_own_session_with_no_stdin(self):
        rc, _, err = self.run_browser()
        self.assertEqual(rc, 0, err)
        record = self.smoke()
        self.assertEqual(record["pgid"], record["pid"], "the smoke must lead its own process group")
        self.assertEqual(
            record["stdin"], "", "the READY payload and the driver's stdin never reach the smoke"
        )

    def test_username_match_is_case_insensitive_but_the_smoke_gets_the_configured_name(self):
        rc, _, err = self.run_browser(payload=ready_payload(username=USERNAME.lower()))
        self.assertEqual(rc, 0, err)
        argv = self.smoke()["argv"]
        self.assertEqual(argv[argv.index("--username") + 1], USERNAME)

    def test_a_failed_case_is_exit_1_with_the_counts_of_the_smoke(self):
        self.set_smoke(rc=1, final=f"STAGE_SMOKE_FAILED sha={SHA} bot=@{USERNAME} cases=5 failed=2")
        rc, out, err = self.run_browser()
        self.assertEqual(rc, 1, err)
        self.assert_result(out, "failed", cases=5, failed=2)

    def test_smoke_refused_is_2_and_qa_unavailable_is_3(self):
        for smoke_rc, status, expected in ((64, "refused", 2), (69, "not-provisioned", 3)):
            with self.subTest(smoke_rc=smoke_rc):
                self.set_smoke(rc=smoke_rc, stderr_lines=["qa problem"])
                rc, out, err = self.run_browser()
                self.assertEqual(rc, expected, err)
                self.assert_result(out, status)
                self.assertIn("qa problem", err)

    def test_smoke_crash_or_unknown_exit_is_a_failure(self):
        for smoke_rc in (137, 2, 3, 255):
            with self.subTest(smoke_rc=smoke_rc):
                self.set_smoke(rc=smoke_rc)
                rc, out, _ = self.run_browser()
                self.assertEqual(rc, 1)
                self.assert_result(out, "failed")

    def test_exit_0_without_a_pass_summary_is_not_a_pass(self):
        for final in (
            None,
            f"STAGE_SMOKE_FAILED sha={SHA} bot=@{USERNAME} cases=5 failed=1",
            f"STAGE_SMOKE_PASSED sha={SHA} bot=@{USERNAME} cases=0 failed=0",
            f"STAGE_SMOKE_PASSED sha={SHA} bot=@{USERNAME} cases=4 failed=0",
            f"STAGE_SMOKE_PASSED sha={SHA} bot=@{USERNAME} cases=5 failed=1",
        ):
            with self.subTest(final=final):
                self.set_smoke(rc=0, final=final)
                rc, out, err = self.run_browser()
                self.assertEqual(rc, 1, err)
                self.assertIn("status=failed", out)
                self.assertNotIn("status=passed", out)

    def test_the_last_summary_line_wins(self):
        self.set_smoke(
            rc=0,
            stdout_lines=[f"STAGE_SMOKE_FAILED sha={SHA} bot=@{USERNAME} cases=5 failed=3"],
            final=PASS_LINE,
        )
        rc, out, err = self.run_browser()
        self.assertEqual(rc, 0, err)
        self.assert_result(out, "passed", cases=5)

    def test_the_lock_is_free_after_every_verdict(self):
        for smoke_rc in (0, 1, 64, 69):
            with self.subTest(smoke_rc=smoke_rc):
                self.set_smoke(rc=smoke_rc, final=PASS_LINE)
                self.run_browser()
                self.assert_lock_free()


def without(key):
    """A READY payload with one key removed."""
    return {k: v for k, v in ready_payload().items() if k != key}


class ReadyValidation(BrowserCase):
    def refuses(self, needle, payload=None, raw=None):
        self.smoke_record.unlink(missing_ok=True)
        rc, out, err = self.run_browser(payload=raw if raw is not None else payload)
        self.assertEqual(rc, 2, err)
        self.assert_result(out, "refused")
        self.assertIn(needle, err)
        self.assertFalse(self.smoke_record.exists(), "the smoke must not run on a refused READY")
        self.assert_lock_free()

    def identity_scenarios(self):
        return {
            "sha mismatch": ("another commit", ready_payload(sha=OTHER_SHA)),
            "sha missing": ("another commit", without("sha")),
            "wrong username": ("another bot", ready_payload(username="SomeOtherStageBot")),
            "prod username": ("another bot", ready_payload(username="HyperCalendarBot")),
            "username missing": ("another bot", without("username")),
            "username is an int": ("another bot", ready_payload(username=12345)),
        }

    def peer_and_cases_scenarios(self):
        return {
            "non numeric peer": ("numeric bot id", ready_payload(peer="12ab")),
            "peer is an int": ("numeric bot id", ready_payload(peer=123)),
            "empty peer": ("numeric bot id", ready_payload(peer="")),
            "peer missing": ("numeric bot id", without("peer")),
            "peer too long": ("numeric bot id", ready_payload(peer="1" * 21)),
            "empty cases": ("no cases", ready_payload(cases=[], base_cases=0)),
            "cases not a list": ("no cases", ready_payload(cases="start")),
            "cases missing": ("no cases", without("cases")),
        }

    def base_count_scenarios(self):
        base = base_cases()
        replaced = [dict(c, name="other") if c["name"] == "ping" else c for c in base]
        return {
            "short list": ("only 4 base cases", ready_payload(cases=base[:4], base_cases=4)),
            "extras do not fill the floor": (
                "only 4 base cases",
                ready_payload(cases=[*base[:4], dict(base[4], name="extra")], base_cases=4),
            ),
            "missing required": ("required base case", ready_payload(cases=replaced, base_cases=5)),
            "base_cases larger than the list": ("base_cases", ready_payload(base_cases=99)),
            "base_cases zero": ("base_cases", ready_payload(base_cases=0)),
            "base_cases negative": ("base_cases", ready_payload(base_cases=-1)),
            "base_cases not an int": ("base_cases", ready_payload(base_cases="5")),
            "base_cases bool": ("base_cases", ready_payload(base_cases=True)),
            "base_cases missing": ("base_cases", without("base_cases")),
        }

    def case_shape_scenarios(self):
        base = base_cases()
        duplicate = [*base[:4], base[0]]
        return {
            "duplicate names": ("duplicate", ready_payload(cases=duplicate, base_cases=5)),
            "case not an object": (
                "without a name",
                ready_payload(cases=["start"] * 5, base_cases=5),
            ),
            "case without a name": (
                "without a name",
                ready_payload(cases=[{"send": "/x"}] * 5, base_cases=5),
            ),
            "case with an empty name": (
                "without a name",
                ready_payload(cases=[{"name": ""}] * 5, base_cases=5),
            ),
            "case name is an int": (
                "without a name",
                ready_payload(cases=[{"name": 1}] * 5, base_cases=5),
            ),
            "payload is a list": ("not an object", []),
            "payload is a string": ("not an object", '"start"\n'),
        }

    def test_every_untrusted_ready_is_refused_with_its_own_reason(self):
        scenarios = {
            **self.identity_scenarios(),
            **self.peer_and_cases_scenarios(),
            **self.base_count_scenarios(),
            **self.case_shape_scenarios(),
        }
        for label, (needle, payload) in scenarios.items():
            with self.subTest(label):
                self.refuses(needle, payload)

    def test_ready_that_is_not_json_is_refused(self):
        for raw, needle in (
            ("{not json\n", "not valid JSON"),
            ("NaN-ish\n", "not valid JSON"),
            ("null\n", "not an object"),
            ("[1]\n", "not an object"),
        ):
            with self.subTest(raw=raw):
                self.refuses(needle, raw=raw)

    def test_the_first_stdin_line_must_be_the_payload(self):
        for raw in ("\n", "\r\n"):
            with self.subTest(raw=raw):
                self.refuses("first stdin line", raw=raw)

    def test_a_payload_over_one_mebibyte_is_refused_without_buffering_it(self):
        oversized = "x" * ((1 << 20) + 1) + "\n"
        self.refuses("larger than", raw=oversized)

    def test_a_payload_just_inside_the_bound_is_parsed(self):
        # Valid JSON padded to just under 1 MiB through a case field: still a normal pass.
        cases = base_cases()
        cases[0]["pad"] = "p" * ((1 << 20) - 4096)
        rc, out, err = self.run_browser(payload=ready_payload(cases=cases, base_cases=5))
        self.assertEqual(rc, 0, err)
        self.assert_result(out, "passed", cases=5)

    def test_required_case_only_in_the_extras_does_not_count(self):
        base = [dict(c, name=f"filler-{i}") for i, c in enumerate(base_cases())]
        self.refuses(
            "required base case", ready_payload(cases=[*base, *base_cases(["start"])], base_cases=5)
        )

    def test_floor_and_required_cases_come_from_the_browser_config_not_from_the_payload(self):
        self.config["min_cases"] = 3
        self.config["required_cases"] = ["start"]
        self.write_config()
        three = base_cases(["start", "a", "b"])
        self.set_smoke(final=f"STAGE_SMOKE_PASSED sha={SHA} bot=@{USERNAME} cases=3 failed=0")
        rc, out, err = self.run_browser(payload=ready_payload(cases=three, base_cases=3))
        self.assertEqual(rc, 0, err)
        self.assert_result(out, "passed", cases=3)
        argv = self.smoke()["argv"]
        self.assertEqual(argv[argv.index("--min-cases") + 1], "3")
        self.refuses("only 2 base cases", ready_payload(cases=three[:2], base_cases=2))
        self.refuses(
            "required base case", ready_payload(cases=base_cases(["x", "y", "z"]), base_cases=3)
        )

    def test_everything_after_the_payload_line_is_ignored(self):
        process = self.spawn()
        process.send(ready_line(ready_payload(username="evil")))
        process.send("STAGE_READY garbage\n")
        self.assertEqual(process.wait(), 0, process.err)
        self.assert_result(process.out, "passed", cases=5)
        self.assertEqual(
            self.smoke()["argv"][self.smoke()["argv"].index("--username") + 1], USERNAME
        )


class ReadyValidationUnreachableThroughTheConfig(unittest.TestCase):
    """load_config refuses a deny-listed or marker-less bot name, so these two branches of validate_ready only
    guard against a future config path; they are exercised on the function directly."""

    def setUp(self):
        self.module = load_module()

    def config(self, **overrides):
        values = {
            "username": USERNAME,
            "deny_usernames": ("HyperCalendarBot",),
            "qa_bin": "/x/qa",
            "python": "python3",
            "lock_file": "/x/lock",
            "lock_max_wait": 1,
            "state_dir": "/x/state",
            "min_cases": 5,
            "required_cases": tuple(REQUIRED),
            "smoke_timeout": 1,
            "payload_wait": 1,
        }
        values.update(overrides)
        return self.module.Config(**values)

    def validate(self, config, payload):
        return self.module.validate_ready(json.dumps(payload), config, SHA)

    def test_a_valid_payload_is_accepted_as_is(self):
        ready = self.validate(self.config(), ready_payload())
        self.assertEqual(ready.base_cases, 5)
        self.assertEqual(ready.peer, PEER)
        self.assertEqual(ready.cases, base_cases())

    def test_a_deny_listed_name_is_refused_even_when_it_equals_the_configured_one(self):
        config = self.config(deny_usernames=("@hypercalendarstagebot",))
        with self.assertRaisesRegex(self.module.Refused, "denied"):
            self.validate(config, ready_payload())

    def test_a_name_without_the_stage_marker_is_refused_even_when_it_equals_the_configured_one(
        self,
    ):
        config = self.config(username="HyperCalendarBot", deny_usernames=())
        with self.assertRaisesRegex(self.module.Refused, "stage or stg"):
            self.validate(config, ready_payload(username="HyperCalendarBot"))

    def test_the_marker_is_stage_or_stg_in_any_case(self):
        for name in ("MyStgBot", "MySTAGEbot", "stg_helper_bot"):
            with self.subTest(name=name):
                config = self.config(username=name)
                self.assertEqual(
                    self.validate(config, ready_payload(username=name.upper())).peer, PEER
                )


class NotProvisioned(BrowserCase):
    def expect_not_provisioned(self, needle):
        rc, out, err = self.run_browser()
        self.assertEqual(rc, 3, err)
        self.assert_result(out, "not-provisioned", locked=False)
        self.assertIn("STAGE_QA_NOT_PROVISIONED:", err)
        self.assertIn(needle, err)
        self.assertFalse(self.smoke_record.exists())
        self.assertFalse(
            self.lock.exists(), "a host that is not provisioned never reaches the lock"
        )

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
        for mode in (0o644, 0o640, 0o604, 0o660, 0o622, 0o666):
            with self.subTest(mode=oct(mode)):
                self.write_config(mode=mode)
                self.expect_not_provisioned("group/other must have no access")

    def test_config_must_be_a_regular_file(self):
        self.config_path.unlink()
        self.config_path.mkdir(mode=0o700)
        self.expect_not_provisioned("not a regular file")

    def test_config_must_belong_to_the_current_user(self):
        module = load_module()
        with (
            mock.patch.object(
                sys.modules["stage_qa_common"].os, "geteuid", return_value=os.geteuid() + 12345
            ),
            self.assertRaisesRegex(module.NotProvisioned, "not owned"),
        ):
            module.load_config(str(self.config_path))

    def test_config_symlink_is_followed_but_checked_on_its_target(self):
        target = self.tmp / "target.json"
        target.write_text(json.dumps(self.config))
        target.chmod(0o644)
        self.config_path.unlink()
        self.config_path.symlink_to(target)
        self.expect_not_provisioned("mode")

    def test_unknown_keys_and_bad_values(self):
        bad = {
            "unknown key": ("sudo", True),
            "ssh key from the old pc config": ("ssh_target", "root@odroidn2"),
            "username without stage": ("username", "HyperCalendarBot"),
            "username too short": ("username", "stg1"),
            "username with a hyphen": ("username", "Hyper-Stage-Bot"),
            "username starting with a digit": ("username", "1StageBotX"),
            "username with a space": ("username", "Stage Bot"),
            "username not a string": ("username", 12345),
            "username in the deny list": ("deny_usernames", [USERNAME]),
            "username in the deny list, other case and @": (
                "deny_usernames",
                ["@" + USERNAME.lower()],
            ),
            "deny not a list": ("deny_usernames", "HyperCalendarBot"),
            "deny with an empty name": ("deny_usernames", [""]),
            "deny with a non string": ("deny_usernames", [1]),
            "min_cases zero": ("min_cases", 0),
            "min_cases bool": ("min_cases", True),
            "min_cases float": ("min_cases", 5.0),
            "required not a list": ("required_cases", "start"),
            "required empty": ("required_cases", []),
            "required with an empty name": ("required_cases", [""]),
            "lock wait negative": ("lock_max_wait", -1),
            "lock wait a string": ("lock_max_wait", "5"),
            "smoke timeout zero": ("smoke_timeout", 0),
            "smoke timeout negative": ("smoke_timeout", -5),
            "payload wait zero": ("payload_wait", 0),
            "payload wait negative": ("payload_wait", -1),
            "payload wait a string": ("payload_wait", "30"),
            "relative lock file": ("lock_file", "qa.lock"),
            "relative qa binary": ("qa_bin", "qa"),
            "relative state dir": ("state_dir", "state"),
            "empty python": ("python", ""),
        }
        pristine = dict(self.config)
        for label, (key, value) in bad.items():
            with self.subTest(label):
                self.config = dict(pristine)
                self.config[key] = value
                self.write_config()
                self.expect_not_provisioned("config")
        self.config = {k: v for k, v in pristine.items() if k != "username"}
        self.write_config()
        self.expect_not_provisioned("username")

    def test_an_empty_deny_list_is_allowed(self):
        self.config["deny_usernames"] = []
        self.write_config()
        rc, _out, err = self.run_browser()
        self.assertEqual(rc, 0, err)
        self.assertNotIn("--deny", self.smoke()["argv"])

    def test_missing_qa_binary_or_not_executable(self):
        self.config["qa_bin"] = str(self.tmp / "absent")
        self.write_config()
        self.expect_not_provisioned("qa binary")
        self.config["qa_bin"] = str(self.qa)
        self.write_config()
        self.qa.chmod(0o644)
        self.expect_not_provisioned("qa binary")

    def test_missing_python(self):
        self.config["python"] = "no-such-python-for-stage-qa"
        self.write_config()
        self.expect_not_provisioned("python")

    def test_missing_stage_smoke_script(self):
        (self.lib / "stage-smoke.py").unlink()
        self.expect_not_provisioned("stage-smoke.py")

    def test_defaults_fill_the_optional_keys_relative_to_home(self):
        (self.tmp / ".local/bin").mkdir(parents=True)
        shutil.copy(self.qa, self.tmp / ".local/bin/qa")
        self.config = {"username": USERNAME}
        self.write_config()
        rc, out, err = self.run_browser()
        self.assertEqual(rc, 0, err)
        self.assert_result(out, "passed", cases=5)
        argv = self.smoke()["argv"]
        self.assertEqual(argv[argv.index("--min-cases") + 1], "5")
        self.assertEqual(argv[argv.index("--deny") + 1], "HyperCalendarBot")
        self.assertEqual(argv[argv.index("--qa-bin") + 1], str(self.tmp / ".local/bin/qa"))
        state = self.tmp / ".local/state/hypercal-stage-qa"
        self.assertEqual(argv[argv.index("--receipt") + 1], str(state / "receipts" / f"{SHA}.json"))
        self.assertTrue((state / "qa.lock").exists())


class ConfigPath(BrowserCase):
    def test_default_config_path_constant(self):
        self.assertEqual(load_module().DEFAULT_CONFIG, "~/.config/hypercal-stage-qa/browser.json")

    def test_default_config_path_comes_from_home(self):
        home_cfg = self.tmp / ".config/hypercal-stage-qa/browser.json"
        home_cfg.parent.mkdir(parents=True)
        home_cfg.write_text(json.dumps(self.config))
        home_cfg.chmod(0o600)
        rc, out, err = self.run_browser(config=False)
        self.assertEqual(rc, 0, err)
        self.assert_result(out, "passed", cases=5)

    def test_missing_default_config_is_not_provisioned_and_names_the_installer(self):
        rc, out, err = self.run_browser(config=False)
        self.assertEqual(rc, 3, err)
        self.assert_result(out, "not-provisioned", locked=False)
        self.assertIn("scripts/install-stage-qa-browser.sh", err)


class ShaArgument(BrowserCase):
    def test_anything_but_40_lowercase_hex_is_refused_before_anything_runs(self):
        hostile = (
            "nothex",
            "A" * 40,
            "a" * 39,
            "a" * 41,
            "a" * 40 + "\n",
            "",
            " ",
            "a" * 40 + " ",
            "$(touch " + str(self.tmp / "pwned") + ")",
            "`touch " + str(self.tmp / "pwned") + "`",
            "a" * 40 + "; touch " + str(self.tmp / "pwned"),
            "a" * 40 + " --config /tmp/evil",
            "a" * 40 + "\nSTAGE_READY {}",
            "../../etc/passwd",
            "-x",
            "--config=/tmp/evil",
            "--",
            "g" * 40,
        )
        for sha in hostile:
            with self.subTest(sha=sha):
                rc, out, err = self.run_browser(sha=sha)
                self.assertEqual(rc, 2, err)
                self.assert_result(out, "refused", sha="-", locked=False)
                self.assertFalse(self.smoke_record.exists())
        self.assertFalse((self.tmp / "pwned").exists())
        self.assertFalse(self.lock.exists(), "a refused argument never reaches the lock")

    def test_missing_sha_is_refused(self):
        process = Process(self, [sys.executable, str(self.lib / "stage-qa-browser.py")])
        process.send(ready_line())
        self.assertEqual(process.wait(), 2)
        self.assert_result(process.out, "refused", sha="-", locked=False)

    def test_help_flags_are_refused_and_stdout_carries_only_the_result_line(self):
        for args in (["--help"], ["-h"], ["--help", "--config", str(self.config_path)]):
            with self.subTest(args=args):
                process = Process(
                    self, [sys.executable, str(self.lib / "stage-qa-browser.py"), *args]
                )
                process.send(ready_line())
                self.assertEqual(process.wait(), 2, process.err)
                self.assert_result(process.out, "refused", sha="-", locked=False)
                self.assertFalse(self.smoke_record.exists())

    def test_two_arguments_are_refused(self):
        process = Process(self, [*self.argv(), SHA])
        process.send(ready_line())
        self.assertEqual(process.wait(), 2)
        self.assert_result(process.out, "refused", sha="-", locked=False)

    def test_the_sha_is_what_the_payload_must_name(self):
        rc, out, err = self.run_browser(sha=OTHER_SHA, payload=ready_payload(sha=SHA))
        self.assertEqual(rc, 2, err)
        self.assert_result(out, "refused", sha=OTHER_SHA)
        self.assertIn("another commit", err)


class BrowserLock(BrowserCase):
    def hold(self, release_after=None, owner=True):
        fd = os.open(self.lock, os.O_RDWR | os.O_CREAT, 0o666)
        fcntl.flock(fd, fcntl.LOCK_EX)
        if owner:
            Path(str(self.lock) + ".owner").write_text(
                f"repo=esb-qa\npid={os.getpid()}\nstart_ticks={start_ticks(os.getpid())}\nstarted=2026-10-26T00:00:00Z\n"
            )
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
        rc, out, err = self.run_browser()
        self.assertEqual(rc, 0, err)
        self.assert_result(out, "passed", cases=5)
        self.assertIn("waiting for the browser lock", err)
        self.assertIn("esb-qa", err)
        self.assertIn(f"pid={os.getpid()}", err)

    def test_wait_gives_up_with_75_and_never_runs_the_smoke(self):
        self.config["lock_max_wait"] = 1
        self.write_config()
        self.hold()
        started = time.monotonic()
        rc, out, err = self.run_browser()
        self.assertLess(time.monotonic() - started, 20)
        self.assertEqual(rc, 75, err)
        self.assert_result(out, "lock-timeout", locked=False)
        self.assertFalse(self.smoke_record.exists())
        self.assertIn("esb-qa", err)
        self.assertIn("gave up", err)

    def test_a_payload_is_never_judged_while_the_lock_is_held_by_someone_else(self):
        self.config["lock_max_wait"] = 1
        self.write_config()
        self.hold()
        rc, out, _ = self.run_browser(payload=ready_payload(sha=OTHER_SHA))
        self.assertEqual(rc, 75)
        self.assert_result(out, "lock-timeout", locked=False)

    def test_stale_owner_file_is_described_as_stale(self):
        self.config["lock_max_wait"] = 1
        self.write_config()
        self.hold(owner=False)
        Path(str(self.lock) + ".owner").write_text(
            "repo=esb-qa\npid=999999\nstart_ticks=1\nstarted=x\n"
        )
        rc, _, err = self.run_browser()
        self.assertEqual(rc, 75)
        self.assertIn("stale", err)

    def test_missing_or_garbled_owner_file_is_described_as_unknown(self):
        self.config["lock_max_wait"] = 1
        self.write_config()
        self.hold(owner=False)
        Path(str(self.lock) + ".owner").write_text("pid=notanumber\n")
        rc, _, err = self.run_browser()
        self.assertEqual(rc, 75)
        self.assertIn("held by: unknown", err)

    def test_the_lock_is_held_during_the_smoke_with_this_process_as_owner_and_released_after(self):
        self.set_smoke(
            owner_file=str(self.lock) + ".owner", lock_file=str(self.lock), final=PASS_LINE
        )
        process = self.spawn()
        self.assertEqual(process.wait(), 0, process.err)
        record = self.smoke()
        self.assertTrue(record["lock_held"], "the flock must be held while the smoke runs")
        owner = dict(line.split("=", 1) for line in record["owner"].splitlines())
        self.assertEqual(owner["repo"], "hcb-stage-qa-browser")
        self.assertEqual(owner["pid"], str(record["ppid"]))
        self.assertEqual(owner["pid"], str(process.proc.pid))
        self.assertRegex(owner["start_ticks"], r"^[0-9]+$")
        self.assertEqual(Path(str(self.lock) + ".owner").read_text(), "")
        self.assert_lock_free()

    def test_the_lock_files_are_created_open_to_other_accounts(self):
        rc, _, err = self.run_browser()
        self.assertEqual(rc, 0, err)
        for path in (self.lock, Path(str(self.lock) + ".owner")):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode) & 0o666, 0o666, path)

    def test_the_lock_is_released_after_a_refused_payload(self):
        rc, _, _ = self.run_browser(payload=ready_payload(sha=OTHER_SHA))
        self.assertEqual(rc, 2)
        self.assert_lock_free()


class LockedBeforePayload(BrowserCase):
    """The driver starts the stage only after LOCKED, so the lock must be held (and announced) before the payload."""

    def test_locked_is_printed_with_the_lock_held_before_any_payload_is_sent(self):
        process = self.spawn(payload=False)
        process.wait_for_out(LOCKED)
        self.assertEqual(process.out, LOCKED)
        self.assertTrue(self.lock_is_held())
        self.assertFalse(self.smoke_record.exists())
        process.send(ready_line())
        self.assertEqual(process.wait(), 0, process.err)
        self.assert_result(process.out, "passed", cases=5)

    def test_locked_is_not_printed_while_the_lock_is_held_by_someone_else(self):
        self.config["lock_max_wait"] = 60
        self.write_config()
        fd = os.open(self.lock, os.O_RDWR | os.O_CREAT, 0o666)
        fcntl.flock(fd, fcntl.LOCK_EX)
        self.addCleanup(os.close, fd)
        process = self.spawn()
        process.wait_for_err("waiting for the browser lock")
        self.assertEqual(process.out, "")
        fcntl.flock(fd, fcntl.LOCK_UN)
        process.wait_for_out(LOCKED)
        self.assertEqual(process.wait(), 0, process.err)
        self.assert_result(process.out, "passed", cases=5)

    def test_no_payload_within_payload_wait_is_a_failed_run_that_frees_the_lock(self):
        self.config["payload_wait"] = 1
        self.write_config()
        process = self.spawn(payload=False)
        started = time.monotonic()
        self.assertEqual(process.wait(30), 1, process.err)
        self.assertLess(time.monotonic() - started, 20)
        self.assert_result(process.out, "failed")
        self.assertIn("no READY payload within 1s", process.err)
        self.assertFalse(self.smoke_record.exists())
        self.assert_lock_free()

    def test_stdin_eof_before_the_payload_is_a_failed_run_that_frees_the_lock(self):
        process = self.spawn(payload=False)
        process.wait_for_out(LOCKED)
        process.close_stdin()
        self.assertEqual(process.wait(30), 1, process.err)
        self.assert_result(process.out, "failed")
        self.assertIn("went away before the run started", process.err)
        self.assertFalse(self.smoke_record.exists())
        self.assert_lock_free()

    def test_the_payload_may_arrive_late_but_inside_payload_wait(self):
        process = self.spawn(payload=False)
        process.wait_for_out(LOCKED)
        time.sleep(1.5)
        process.send(ready_line())
        self.assertEqual(process.wait(), 0, process.err)
        self.assert_result(process.out, "passed", cases=5)


class DriverGone(BrowserCase):
    def test_stdin_eof_while_the_smoke_runs_kills_its_group_fails_and_frees_the_lock(self):
        self.set_smoke(sleep=60, lock_file=str(self.lock))
        process = self.spawn()
        ids = self.wait_for_marker(process)
        started = time.monotonic()
        process.close_stdin()
        self.assertEqual(process.wait(30), 1, process.err)
        self.assertLess(time.monotonic() - started, 20)
        self.assert_result(process.out, "failed")
        self.assertIn("went away", process.err)
        self.assert_group_dead(ids)
        self.assert_lock_free()
        self.assertEqual(Path(str(self.lock) + ".owner").read_text(), "")

    def test_lines_after_the_payload_do_not_count_as_the_driver_leaving(self):
        self.set_smoke(sleep=2, final=PASS_LINE)
        process = self.spawn()
        self.wait_for_marker(process)
        process.send("noise\nmore noise\n")
        self.assertEqual(process.wait(30), 0, process.err)
        self.assert_result(process.out, "passed", cases=5)

    def test_stdin_eof_while_waiting_for_a_held_lock_exits_without_running_the_smoke(self):
        self.config["lock_max_wait"] = 60
        self.write_config()
        fd = os.open(self.lock, os.O_RDWR | os.O_CREAT, 0o666)
        fcntl.flock(fd, fcntl.LOCK_EX)
        self.addCleanup(os.close, fd)
        process = self.spawn()
        process.wait_for_err("waiting for the browser lock")
        started = time.monotonic()
        process.close_stdin()
        self.assertEqual(process.wait(30), 1, process.err)
        self.assertLess(time.monotonic() - started, 15)
        self.assert_result(process.out, "failed", locked=False)
        self.assertIn("went away before the run started", process.err)
        self.assertFalse(self.smoke_record.exists())
        fcntl.flock(fd, fcntl.LOCK_UN)
        self.assert_lock_free()

    def test_eof_after_the_payload_is_not_a_pass_even_when_the_smoke_would_have_passed(self):
        self.set_smoke(sleep=5, final=PASS_LINE)
        process = self.spawn()
        self.wait_for_marker(process)
        process.close_stdin()
        self.assertEqual(process.wait(30), 1, process.err)
        self.assertNotIn("status=passed", process.out)


class SmokeTimeout(BrowserCase):
    def test_a_hung_smoke_is_killed_with_its_whole_process_group(self):
        self.config["smoke_timeout"] = 2
        self.write_config()
        self.set_smoke(sleep=60)
        started = time.monotonic()
        rc, out, err = self.run_browser()
        self.assertLess(time.monotonic() - started, 40)
        self.assertEqual(rc, 1, err)
        self.assert_result(out, "failed")
        self.assertIn("timed out", err)
        self.assert_group_dead(json.loads(self.marker.read_text()))
        self.assert_lock_free()

    def test_a_smoke_that_ignores_sigterm_is_killed_after_the_grace_and_a_second_signal_changes_nothing(
        self,
    ):
        self.set_smoke(sleep=60, ignore_term=True)
        process = self.spawn()
        ids = self.wait_for_marker(process)
        process.proc.send_signal(signal.SIGTERM)
        time.sleep(0.7)
        process.proc.send_signal(signal.SIGTERM)
        self.assertEqual(process.wait(30), 143, process.err)
        self.assert_result(process.out, "failed")
        self.assert_group_dead(ids)
        self.assert_lock_free()


class Signals(BrowserCase):
    def test_signal_mid_smoke_kills_the_group_frees_the_lock_and_prints_the_result(self):
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            with self.subTest(signal=signum.name):
                self.marker.unlink(missing_ok=True)
                self.set_smoke(sleep=60)
                process = self.spawn()
                ids = self.wait_for_marker(process)
                process.proc.send_signal(signum)
                self.assertEqual(process.wait(30), 128 + signum.value, process.err)
                self.assertTrue(
                    process.out.startswith(LOCKED + f"STAGE_QA_RESULT status=failed sha={SHA} "),
                    process.out,
                )
                self.assertEqual(len(process.out.splitlines()), 2)
                self.assert_group_dead(ids)
                self.assert_lock_free()

    def test_signal_while_waiting_for_the_lock_exits_without_running_the_smoke(self):
        self.config["lock_max_wait"] = 60
        self.write_config()
        fd = os.open(self.lock, os.O_RDWR | os.O_CREAT, 0o666)
        fcntl.flock(fd, fcntl.LOCK_EX)
        self.addCleanup(os.close, fd)
        process = self.spawn()
        process.wait_for_err("waiting for the browser lock")
        process.proc.send_signal(signal.SIGTERM)
        self.assertEqual(process.wait(30), 143, process.err)
        self.assertTrue(process.out.startswith("STAGE_QA_RESULT status=failed"), process.out)
        self.assertEqual(len(process.out.splitlines()), 1)
        self.assertFalse(self.smoke_record.exists())

    def test_signal_while_waiting_for_the_payload_exits_with_the_signal_code(self):
        process = self.spawn(payload=False)
        process.wait_for_out(LOCKED)
        process.proc.send_signal(signal.SIGTERM)
        self.assertEqual(process.wait(30), 143, process.err)
        self.assertTrue(
            process.out.startswith(LOCKED + "STAGE_QA_RESULT status=failed"), process.out
        )
        self.assertEqual(len(process.out.splitlines()), 2)
        self.assertFalse(self.smoke_record.exists())
        self.assert_lock_free()


class Static(unittest.TestCase):
    def test_browser_half_never_uses_a_shell_and_never_reads_a_token(self):
        text = BROWSER.read_text()
        self.assertNotRegex(text, r"shell\s*=\s*True")
        self.assertNotIn("telethon", text.lower())
        self.assertNotRegex(text, r"(?i)env\[[^\]]*TOKEN")
        self.assertNotRegex(text, r"(?m)^\s*(?:os\.system|subprocess\.\w+)\([^)]*\bssh\b")

    def test_scripts_parse(self):
        for path in (BROWSER, COMMON):
            subprocess.run(
                [sys.executable, "-c", f"import ast; ast.parse(open({str(path)!r}).read())"],
                check=True,
            )


if __name__ == "__main__":
    unittest.main()
