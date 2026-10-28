"""Run the real stage QA root scripts against fake docker, fake GitHub fetch and stub smoke/health.

odroid-stage-qa.sh (root entry), stage-qa-run.sh (orchestration) and install-stage-qa.sh are
real bash; their fixed constants (paths, lock files, wait budgets, PATH) are rewritten in COPIES
to point at a temp tree, as test_odroid_activate_release.py does for the activator. Everything
the PR-controlled artifact would supply (the image, the case list) and every external program
(docker, the artifact fetcher, smoke, health, evidence) is a stub that records what it saw into
one directory, so each test can assert on argv, environment and event order.
"""

import fcntl
import gzip
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENTRY = ROOT / "scripts/odroid-stage-qa.sh"
RUN = ROOT / "scripts/stage-qa-run.sh"
INSTALLER = ROOT / "scripts/install-stage-qa.sh"
REAL_LOCK_LIB = ROOT / "scripts/odroid-deploy-lock.sh"
SHA = "0123456789abcdef0123456789abcdef01234567"
STAGE_IMAGE = "ghcr.io/alex-mextner/hypercalendarbot-stage"
FAKE_TOKEN = "FAKE-GITHUB-TOKEN-FOR-STAGE-TESTS-" + "0" * 10
PROD_BOT_TOKEN = "1234567:PROD-TELEGRAM-TOKEN-MUST-NEVER-REACH-STAGE"
STAGE_BOT_TOKEN = "7654321:STAGE-TELEGRAM-TOKEN"
SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
CONFIG_DIGEST = "sha256:" + "ab" * 32
LIB_FILES = [
    "stage-fetch-artifact.py",
    "stage-qa-run.sh",
    "stage-smoke.py",
    "docker-compose.stage.yml",
    "release-artifact.py",
    "odroid-deploy-lock.sh",
    "deploy-health.py",
    "deploy-evidence.py",
    "prepare-runtime-dirs.sh",
    "log-retention.py",
]
RESULT = re.compile(r"^STAGE_QA_RESULT status=([a-z-]+) sha=(\S+) cases=(\d+) failed=(\d+)$")

PROD_ENV = """\
# comment ZAI_COMMENTED=no
ZAI_API_KEY=zai-secret
HF_TOKEN=hf-secret
CLAUDE_MODEL=claude-x
OPENROUTER_API_KEY=or-secret
GROQ_API_KEY=groq-secret
AI_PRIMARY=zai
INTENT_LEARNER_ENABLED=1
LOG_LEVEL=debug
TZ=Europe/Berlin
LOG_LEVELX=leak-1
BOT_TOKEN={prod}
BOT_USERNAME=hypercal_prod_bot
TELEGRAM_API_HASH=tg-hash
GOOGLE_CLIENT_SECRET=google-secret
MTPROTO_API_HASH=mtproto-secret
MTPROTO_SERVICE_TOKEN=svc-secret
SMTP_PASSWORD=smtp-secret
INLINE_BOT_TOKEN=inline-secret
PUBLIC_DOMAIN=bot.example.org
WEBHOOK_SECRET=hook-secret
"""
GUARD_JSON = {
    "username": "hypercal_stage_bot",
    "peer": "7654321",
    "base_cases": 5,
    "cases": [{"name": name, "send": "/" + name} for name in ("start", "ping", "a", "b", "c")],
}
ALLOWED_KEYS = {
    "ZAI_API_KEY",
    "HF_TOKEN",
    "CLAUDE_MODEL",
    "OPENROUTER_API_KEY",
    "GROQ_API_KEY",
    "AI_PRIMARY",
    "INTENT_LEARNER_ENABLED",
    "LOG_LEVEL",
    "TZ",
    "BOT_TOKEN",
    "BOT_USERNAME",
}


def rewrite(text, replacements):
    for old, new in replacements:
        assert text.count(old) == 1, old
        text = text.replace(old, new)
    return text


def close_stdin(process):
    """Close the pipe and drop the handle: Python 3.12's Popen.communicate() flushes a closed stdin and raises ValueError."""
    process.stdin.close()
    process.stdin = None


def wait_for(predicate, what, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {what}")


def lock_is_free(path):
    result = subprocess.run(["flock", "-n", str(path), "true"], capture_output=True, check=False)
    return result.returncode == 0


class HeldLock:
    """A flock(2) the test holds, standing in for a prod deploy or another stage run."""

    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.fd = os.open(path, os.O_RDWR | os.O_APPEND | os.O_CREAT)
        fcntl.flock(self.fd, fcntl.LOCK_EX)

    def release(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


STUB_FETCH = r"""
import json, os, re, stat, sys
REC, CTL, TOKEN = {rec!r}, {ctl!r}, {token!r}
ctl = json.load(open(CTL))
cmd = sys.argv[1]
line = sys.stdin.readline().rstrip("\n")
record = {{"argv": sys.argv[1:], "stdin_is_token": line == TOKEN, "env": dict(os.environ),
           "fd3_open": os.path.exists("/proc/self/fd/3")}}
with open(os.path.join(REC, f"fetch-{{cmd}}.{{os.getpid()}}.json"), "w") as f:
    json.dump(record, f)
with open(os.path.join(REC, "events.log"), "a") as f:
    f.write(f"fetch-{{cmd}}\n")
if cmd == "current":
    sys.exit(ctl["current_rc"])
out = sys.argv[sys.argv.index("--out") + 1]
with open(os.path.join(REC, "fetch-out.json"), "w") as f:
    json.dump({{"out": out, "mode": stat.S_IMODE(os.stat(out).st_mode), "entries": os.listdir(out)}}, f)
if ctl["fetch_rc"]:
    sys.exit(ctl["fetch_rc"])
with open(os.path.join(out, "image.tar.gz"), "wb") as f:
    f.write(open(os.path.join(REC, "image.tar.gz"), "rb").read())
with open(os.path.join(out, "stage-smoke-cases.json"), "w") as f:
    f.write(ctl["cases_text"])
if ctl["replay"]:
    with open(os.path.join(out, "stage-smoke-cases.replay.json"), "w") as f:
        f.write("[]")
with open(os.path.join(out, "artifact.json"), "w") as f:
    json.dump({{"config_digest": ctl["image_id"], "manifest_digest": "sha256:" + "cd" * 32, "image_bytes": 1000}}, f)
print("STAGE_ARTIFACT archive_sha256=" + "00" * 32 + " config_digest=" + ctl["image_id"] + " image_bytes=1000 replay=0")
"""

STUB_SMOKE = r"""
import json, os, sys
REC, CTL = {rec!r}, {ctl!r}
ctl = json.load(open(CTL))
argv = sys.argv[1:]
record = {{"argv": argv, "env": dict(os.environ), "fd3_open": os.path.exists("/proc/self/fd/3")}}
with open(os.path.join(REC, "guard.json"), "w") as f:
    json.dump(record, f)
with open(os.path.join(REC, "events.log"), "a") as f:
    f.write("guard\n")
if argv[0] != "guard" or ctl["guard_rc"]:
    sys.exit(ctl["guard_rc"] or 64)
if ctl["guard_garbage"]:
    print("not a guard line")
    sys.exit(0)
print("STAGE_GUARD " + json.dumps(ctl["guard_json"], separators=(",", ":")))
"""

STUB_HEALTH = r"""
import json, os, sys
REC, CTL = {rec!r}, {ctl!r}
ctl = json.load(open(CTL))
with open(os.path.join(REC, "health.json"), "w") as f:
    json.dump({{"argv": sys.argv[1:], "env": dict(os.environ)}}, f)
with open(os.path.join(REC, "events.log"), "a") as f:
    f.write("health\n")
print("RESULT verdict=" + ("ok" if ctl["health_rc"] == 0 else "unhealthy") + " health=ok ready=ok elapsed=1s reason=stub")
sys.exit(ctl["health_rc"])
"""

STUB_EVIDENCE = r"""
import json, os, sys
REC = {rec!r}
cmd = sys.argv[1]
opts = dict(zip(sys.argv[2::2], sys.argv[3::2]))
root = opts["--logs-root"]
name = "release-" + opts["--label"] if cmd == "release-logs" else "failed-" + opts["--sha"][:12]
os.makedirs(os.path.join(root, name), exist_ok=True)
with open(os.path.join(root, name, "container.log"), "w") as f:
    f.write("evidence\n")
with open(os.path.join(REC, "events.log"), "a") as f:
    f.write(f"evidence {{cmd}} {{name}}\n")
with open(os.path.join(REC, f"evidence-{{cmd}}.json"), "w") as f:
    json.dump({{"argv": sys.argv[1:], "env": dict(os.environ)}}, f)
print("EVIDENCE_DIR=" + os.path.join(root, name))
"""

STUB_DOCKER = r"""#!/bin/bash
REC={rec}
CTL={ctl}
ev() {{ printf '%s\n' "$*" >>"$REC/events.log"; }}
printf '%s\n' "docker $*" >>"$REC/docker.log"
printf '%s\n' "$@" >"$REC/docker-argv.$$"
env >"$REC/docker-env.$$"
case "$1" in
  info)
    case "$*" in
      *DockerRootDir*) echo "$REC/dockerroot" ;;
      *DriverStatus*) echo '[]' ;;
    esac ;;
  load) ev "docker-load bytes=$(wc -c)"; echo 'Loaded image' ;;
  rm) ev "docker-rm $*" ;;
  image)
    if [ "$2" = ls ]; then cat "$REC/stale-images" 2>/dev/null; exit 0; fi
    python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["image_id"])' "$CTL" ;;
  rmi) ev "docker-rmi $2" ;;
  compose)
    for arg in "$@"; do
      case "$arg" in
        up) ev "compose-up db_present=$([ -e {deploy}/stage/data/calendar.db ] && echo 1 || echo 0)"; break ;;
        down) ev "compose-down"; break ;;
      esac
    done ;;
esac
exit 0
"""

STUB_PREPARE = """#!/bin/bash
printf 'prepare-dirs %s\\n' "$1" >>{rec}/events.log
"""


class StageWorld(unittest.TestCase):
    """A temp tree with the whole host layout and rewritten copies of the two stage scripts."""

    def setUp(self):
        self.build()

    def build(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.deploy = self.tmp / "deploy"
        self.stage = self.deploy / "stage"
        self.rec = self.tmp / "rec"
        self.bin = self.tmp / "bin"
        self.lib = self.tmp / "lib"
        self.locks = self.tmp / "locks"
        for directory in (
            self.deploy,
            self.stage,
            self.rec,
            self.bin,
            self.lib,
            self.locks,
            self.rec / "dockerroot",
            self.stage / "data",
            self.stage / "logs",
        ):
            directory.mkdir(parents=True, exist_ok=True)
        self.stage_lock = self.locks / "hypercal-stage.lock"
        self.host_lock = self.locks / "odroid-deploy.lock"
        self.ctl_path = self.tmp / "ctl.json"
        self.ctl(
            fetch_rc=0,
            current_rc=0,
            health_rc=0,
            guard_rc=0,
            guard_garbage=False,
            guard_json=GUARD_JSON,
            image_id=CONFIG_DIGEST,
            replay=False,
            cases_text='[{"name": "ping"}]',
        )
        (self.rec / "image.tar.gz").write_bytes(gzip.compress(b"IMAGE-BYTES"))
        (self.deploy / ".env").write_text(PROD_ENV.format(prod=PROD_BOT_TOKEN))
        (self.stage / "stage.env").write_text(
            f"BOT_TOKEN={STAGE_BOT_TOKEN}\nBOT_USERNAME=hypercal_stage_bot\nSTAGE_REDIS_PASSWORD=redispass1\n"
        )
        fmt = {
            "rec": str(self.rec),
            "ctl": str(self.ctl_path),
            "token": FAKE_TOKEN,
            "deploy": str(self.deploy),
        }
        self.write_exec(self.bin / "docker", STUB_DOCKER.format(**fmt))
        self.write_exec(self.lib / "stage-fetch-artifact.py", STUB_FETCH.format(**fmt))
        self.write_exec(self.lib / "stage-smoke.py", STUB_SMOKE.format(**fmt))
        self.write_exec(self.lib / "deploy-health.py", STUB_HEALTH.format(**fmt))
        self.write_exec(self.lib / "deploy-evidence.py", STUB_EVIDENCE.format(**fmt))
        self.write_exec(self.lib / "prepare-runtime-dirs.sh", STUB_PREPARE.format(**fmt))
        (self.lib / "docker-compose.stage.yml").write_text("name: hypercalstage\n")
        shutil.copy(REAL_LOCK_LIB, self.lib / "odroid-deploy-lock.sh")
        self.set_constants(stage_wait=2, stage_slice=1, host_wait=2, host_slice=1, run_timeout=60)

    def write_exec(self, path, text):
        path.write_text(text if text.startswith("#!") else "#!/usr/bin/env python3\n" + text)
        path.chmod(0o755)

    def ctl(self, **updates):
        current = json.loads(self.ctl_path.read_text()) if self.ctl_path.exists() else {}
        current.update(updates)
        self.ctl_path.write_text(json.dumps(current))

    def set_constants(self, stage_wait, stage_slice, host_wait, host_slice, run_timeout):
        path = f"{self.bin}:{SAFE_PATH}"
        self.entry = self.tmp / "hypercal-stage-qa"
        self.entry.write_text(
            rewrite(
                ENTRY.read_text(),
                [
                    ("readonly API=https://api.github.com\n", "readonly API=http://127.0.0.1:9\n"),
                    (
                        "readonly DEPLOY_PATH=/opt/hypercal\n",
                        f"readonly DEPLOY_PATH={self.deploy}\n",
                    ),
                    ("readonly LIB=/usr/local/lib/hypercal-stage\n", f"readonly LIB={self.lib}\n"),
                    (
                        "readonly STAGE_LOCK_FILE=/run/lock/hypercal-stage.lock\n",
                        f"readonly STAGE_LOCK_FILE={self.stage_lock}\n",
                    ),
                    (
                        "readonly STAGE_LOCK_MAX_WAIT=3000\n",
                        f"readonly STAGE_LOCK_MAX_WAIT={stage_wait}\n",
                    ),
                    (
                        "readonly STAGE_LOCK_SLICE=30\n",
                        f"readonly STAGE_LOCK_SLICE={stage_slice}\n",
                    ),
                    (f"readonly SAFE_PATH={SAFE_PATH}\n", f"readonly SAFE_PATH={path}\n"),
                ],
            )
        )
        self.entry.chmod(0o755)
        run = self.lib / "stage-qa-run.sh"
        run.write_text(
            rewrite(
                RUN.read_text(),
                [
                    ("readonly API=https://api.github.com\n", "readonly API=http://127.0.0.1:9\n"),
                    (
                        "readonly DEPLOY_PATH=/opt/hypercal\n",
                        f"readonly DEPLOY_PATH={self.deploy}\n",
                    ),
                    (
                        "readonly HOST_LOCK_FILE=/run/lock/odroid-deploy.lock\n",
                        f"readonly HOST_LOCK_FILE={self.host_lock}\n",
                    ),
                    (
                        "readonly HOST_LOCK_MAX_WAIT=2400\n",
                        f"readonly HOST_LOCK_MAX_WAIT={host_wait}\n",
                    ),
                    ("readonly HOST_LOCK_SLICE=30\n", f"readonly HOST_LOCK_SLICE={host_slice}\n"),
                    ("readonly RUN_TIMEOUT=2400\n", f"readonly RUN_TIMEOUT={run_timeout}\n"),
                    (f"readonly SAFE_PATH={SAFE_PATH}\n", f"readonly SAFE_PATH={path}\n"),
                ],
            )
        )
        run.chmod(0o755)

    def popen(self, sha=SHA, token=FAKE_TOKEN, done=True, ssh_command=None):
        """Start the entry. sha=None means zero arguments (the ssh forced-command shape).

        done=True queues the DONE line the PC driver writes after its smoke; done=False keeps stdin
        open so a test can drive the wait for DONE (or EOF, or a signal) itself.
        """
        env = {"PATH": "/usr/bin:/bin", "HOME": str(self.tmp)}
        if ssh_command is not None:
            env["SSH_ORIGINAL_COMMAND"] = ssh_command
        process = subprocess.Popen(
            [str(self.entry), *([] if sha is None else [sha])],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        process.stdin.write("" if token is None else token + "\n")
        if done and token is not None:
            process.stdin.write("DONE\n")
        process.stdin.flush()
        if done or token is None:
            close_stdin(process)
        return process

    def run_entry(self, sha=SHA, token=FAKE_TOKEN, **kwargs):
        process = self.popen(sha, token, **kwargs)
        out, err = process.communicate(timeout=90)
        return subprocess.CompletedProcess(process.args, process.returncode, out, err)

    def ready(self, process):
        """Read the STAGE_READY line from the entry's stdout (blocks until the stage is up)."""
        line = process.stdout.readline()
        self.assertRegex(line, r"^STAGE_READY \{", line)
        return json.loads(line[len("STAGE_READY ") :])

    def finish(self, process):
        out = process.stdout.read()
        err = process.stderr.read()
        process.wait(timeout=60)
        for stream in (process.stdout, process.stderr, process.stdin):
            if stream and not stream.closed:
                try:
                    stream.close()
                except BrokenPipeError:
                    pass
        return subprocess.CompletedProcess(process.args, process.returncode, out, err)

    def events(self):
        path = self.rec / "events.log"
        return path.read_text().splitlines() if path.exists() else []

    def has_event(self, prefix):
        return any(line.startswith(prefix) for line in self.events())

    def index_of(self, prefix):
        for position, line in enumerate(self.events()):
            if line.startswith(prefix):
                return position
        raise AssertionError(f"no event {prefix!r} in {self.events()}")

    def result(self, completed):
        lines = completed.stdout.strip().splitlines()
        self.assertTrue(lines, completed.stderr)
        match = RESULT.match(lines[-1])
        self.assertIsNotNone(
            match, f"last stdout line is not a RESULT line: {lines[-1]!r}\n{completed.stderr}"
        )
        return match.group(1), match.group(2), int(match.group(3)), int(match.group(4))

    def assertOutcome(self, completed, code, status, cases=0, failed=0):
        self.assertEqual(completed.returncode, code, completed.stderr)
        self.assertEqual(self.result(completed), (status, SHA, cases, failed), completed.stderr)

    def leftover_work_dirs(self):
        return sorted(
            p.name for p in self.deploy.iterdir() if p.name.startswith(".stage-incoming-")
        )

    def record_text(self):
        parts = []
        for path in self.rec.iterdir():
            if path.is_file() and path.name != "image.tar.gz":
                parts.append(path.read_text(errors="replace"))
        return "\n".join(parts)

    def assertNoSecrets(self, completed):
        everything = completed.stdout + completed.stderr + self.record_text()
        self.assertNotIn(FAKE_TOKEN, everything)
        self.assertNotIn(PROD_BOT_TOKEN, everything)

    def assertTornDown(self):
        self.assertTrue(self.has_event("compose-down"), self.events())
        self.assertTrue(self.has_event(f"docker-rmi {STAGE_IMAGE}:{SHA}"), self.events())
        self.assertEqual(self.leftover_work_dirs(), [])


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


class Refusals(StageWorld):
    def test_bad_arguments_and_missing_token_are_refused_without_touching_anything(self):
        for sha, token in (
            ("main", FAKE_TOKEN),
            (SHA.upper(), FAKE_TOKEN),
            (SHA[:39], FAKE_TOKEN),
            (SHA, None),
            (SHA, ""),
        ):
            with self.subTest(sha=sha, token=bool(token)):
                result = self.run_entry(sha, token)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertRegex(
                    result.stdout.strip().splitlines()[-1],
                    r"^STAGE_QA_RESULT status=refused sha=\S+ cases=0 failed=0$",
                )
                self.assertEqual(self.events(), [])
                self.assertFalse(self.stage_lock.exists())

    def test_zero_arguments_take_the_sha_from_ssh_original_command(self):
        result = self.run_entry(None, ssh_command=SHA)
        self.assertOutcome(result, 0, "passed")
        self.assertTrue(self.has_event("fetch-fetch"))

    def test_invalid_ssh_original_command_is_refused_without_touching_anything(self):
        for command in (
            None,
            "",
            SHA + " extra",
            "rm -rf /",
            SHA[:39],
            SHA.upper(),
            SHA + "\n" + SHA,
            "main",
            "-" + SHA[1:],
            SHA + ";id",
        ):
            with self.subTest(command=command):
                result = self.run_entry(None, ssh_command=command)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertRegex(
                    result.stdout.strip().splitlines()[-1],
                    r"^STAGE_QA_RESULT status=refused sha=\S+ cases=0 failed=0$",
                )
                self.assertEqual(self.events(), [])
                self.assertFalse(self.stage_lock.exists())

    def test_an_argument_wins_and_ssh_original_command_is_ignored(self):
        result = self.run_entry(SHA, ssh_command="f" * 40)
        self.assertOutcome(result, 0, "passed")
        fetch = json.loads(next(self.rec.glob("fetch-fetch.*.json")).read_text())["argv"]
        self.assertEqual(fetch[fetch.index("--sha") + 1], SHA)

    def test_refused_fetch_is_exit_2_and_nothing_runs(self):
        self.ctl(fetch_rc=2)
        result = self.run_entry()
        self.assertOutcome(result, 2, "refused")
        self.assertFalse(self.has_event("docker-load"))
        self.assertEqual(self.leftover_work_dirs(), [])
        self.assertNoSecrets(result)

    def test_any_other_fetch_failure_is_refused_too(self):
        self.ctl(fetch_rc=1)
        self.assertOutcome(self.run_entry(), 2, "refused")

    def test_superseded_at_fetch_is_76(self):
        self.ctl(fetch_rc=76)
        result = self.run_entry()
        self.assertOutcome(result, 76, "superseded")
        self.assertFalse(self.has_event("docker-load"))
        self.assertEqual(self.leftover_work_dirs(), [])

    def test_superseded_while_waiting_for_the_host_lock_is_76_and_nothing_started(self):
        self.ctl(current_rc=76)
        result = self.run_entry()
        self.assertOutcome(result, 76, "superseded")
        self.assertFalse(self.has_event("docker-load"))
        self.assertFalse(self.has_event("compose-up"))
        self.assertEqual(self.leftover_work_dirs(), [])

    def test_unexpected_current_check_failure_is_refused(self):
        self.ctl(current_rc=2)
        self.assertOutcome(self.run_entry(), 2, "refused")
        self.assertFalse(self.has_event("docker-load"))


class Locks(StageWorld):
    def test_stage_lock_timeout_is_75_and_nothing_else_happens(self):
        held = HeldLock(self.stage_lock)
        self.addCleanup(held.release)
        started = time.monotonic()
        result = self.run_entry()
        self.assertOutcome(result, 75, "lock-timeout")
        self.assertGreaterEqual(time.monotonic() - started, 1)
        self.assertEqual(self.events(), [])
        self.assertEqual(self.leftover_work_dirs(), [])

    def test_host_lock_timeout_is_75_without_starting_the_stage(self):
        held = HeldLock(self.host_lock)
        self.addCleanup(held.release)
        result = self.run_entry()
        self.assertOutcome(result, 75, "lock-timeout")
        self.assertTrue(self.has_event("fetch-fetch"))
        self.assertFalse(self.has_event("fetch-current"))
        self.assertFalse(self.has_event("docker-load"))
        self.assertFalse(self.has_event("compose-down"))
        self.assertEqual(self.leftover_work_dirs(), [])
        self.assertTrue(lock_is_free(self.stage_lock))

    def test_stage_lock_is_taken_first_then_host_lock_and_a_second_contender_waits(self):
        self.set_constants(stage_wait=60, stage_slice=1, host_wait=60, host_slice=1, run_timeout=60)
        host = HeldLock(self.host_lock)
        self.addCleanup(host.release)
        first = self.popen()
        wait_for(lambda: self.has_event("fetch-fetch"), "first run to fetch")
        # The first run owns the stage lock and is parked on the host lock: nothing is loaded yet.
        self.assertFalse(lock_is_free(self.stage_lock))
        self.assertFalse(self.has_event("fetch-current"))
        second = self.popen()
        time.sleep(2.5)
        self.assertEqual(self.events().count("fetch-fetch"), 1, self.events())
        self.assertIsNone(first.poll())
        self.assertIsNone(second.poll())
        host.release()
        for process in (first, second):
            out, err = process.communicate(timeout=60)
            self.assertEqual(process.returncode, 0, err)
            self.assertTrue(
                out.strip().splitlines()[-1].startswith("STAGE_QA_RESULT status=passed")
            )
        events = self.events()
        fetches = [i for i, line in enumerate(events) if line == "fetch-fetch"]
        downs = [i for i, line in enumerate(events) if line == "compose-down"]
        self.assertEqual((len(fetches), len(downs)), (2, 2), events)
        # Strictly serialized: the second fetch starts only after the first stage was torn down.
        self.assertLess(downs[0], fetches[1])
        self.assertLess(events.index("fetch-current"), events.index("docker-load bytes=11"))

    def test_locks_are_released_when_the_run_ends(self):
        self.run_entry()
        self.assertTrue(lock_is_free(self.stage_lock))
        self.assertTrue(lock_is_free(self.host_lock))


class Teardown(StageWorld):
    def test_sigterm_while_waiting_for_done_tears_the_stage_down_and_keeps_evidence(self):
        process = self.popen(done=False)
        self.ready(process)
        process.send_signal(signal.SIGTERM)
        result = self.finish(process)
        self.assertEqual(result.returncode, 143, result.stderr)
        self.assertRegex(
            result.stdout.strip().splitlines()[-1], r"^STAGE_QA_RESULT status=failed sha=" + SHA
        )
        self.assertTrue(self.has_event("evidence release-logs"))
        self.assertLess(self.index_of("evidence"), self.index_of("compose-down"))
        self.assertTornDown()
        self.assertTrue((self.stage / "evidence" / f"release-stage-{SHA[:12]}").is_dir())
        self.assertTrue(lock_is_free(self.stage_lock))
        self.assertTrue(lock_is_free(self.host_lock))

    def test_no_done_within_the_run_budget_is_the_timeout_path(self):
        self.set_constants(stage_wait=2, stage_slice=1, host_wait=2, host_slice=1, run_timeout=2)
        started = time.monotonic()
        process = self.popen(done=False)
        self.ready(process)
        result = self.finish(process)
        self.assertLess(time.monotonic() - started, 40)
        self.assertOutcome(result, 1, "failed")
        self.assertIn("timed out", result.stderr)
        self.assertTrue(self.has_event("evidence failed"))
        self.assertTornDown()
        self.assertTrue(lock_is_free(self.stage_lock))
        self.assertTrue(lock_is_free(self.host_lock))

    def test_sigterm_while_waiting_for_the_host_lock_removes_the_work_dir(self):
        self.set_constants(stage_wait=60, stage_slice=1, host_wait=60, host_slice=1, run_timeout=60)
        host = HeldLock(self.host_lock)
        self.addCleanup(host.release)
        process = self.popen()
        wait_for(lambda: self.has_event("fetch-fetch"), "fetch")
        time.sleep(0.5)
        process.send_signal(signal.SIGTERM)
        process.communicate(timeout=30)
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(self.leftover_work_dirs(), [])
        self.assertFalse(self.has_event("compose-up"))

    def test_runs_never_delete_logs_or_evidence(self):
        (self.stage / "logs").mkdir(exist_ok=True)
        (self.stage / "logs" / "bot.log").write_text("old")
        old = self.stage / "evidence" / "failed-aaaaaaaaaaaa"
        old.mkdir(parents=True)
        (old / "container.log").write_text("old evidence")
        for rc in (0, 1):
            self.ctl(health_rc=rc)
            self.run_entry()
        self.assertEqual((self.stage / "logs" / "bot.log").read_text(), "old")
        self.assertEqual((old / "container.log").read_text(), "old evidence")


class Hardening(StageWorld):
    def test_teardown_survives_the_stderr_pipe_closing_after_cancel(self):
        # GitHub kills the job's tee/pipes about 10 s after SIGINT while teardown still runs.
        process = self.popen(done=False)
        self.ready(process)
        process.send_signal(signal.SIGTERM)
        process.stderr.close()
        out = process.stdout.read()
        process.wait(timeout=60)
        process.stdout.close()
        close_stdin(process)
        self.assertRegex(out.strip().splitlines()[-1], r"^STAGE_QA_RESULT status=failed sha=" + SHA)
        self.assertTrue(self.has_event("evidence release-logs"), self.events())
        self.assertTornDown()

    def test_run_timeout_counts_from_the_host_lock_not_from_the_start(self):
        self.set_constants(stage_wait=30, stage_slice=1, host_wait=30, host_slice=1, run_timeout=2)
        host = HeldLock(self.host_lock)
        self.addCleanup(host.release)
        process = self.popen()
        wait_for(lambda: self.has_event("fetch-fetch"), "fetch")
        time.sleep(3.5)
        self.assertIsNone(process.poll())
        host.release()
        out, err = process.communicate(timeout=60)
        self.assertEqual(process.returncode, 0, err)
        self.assertRegex(out.strip().splitlines()[-1], r"^STAGE_QA_RESULT status=passed")

    def test_stale_work_dirs_of_a_dead_run_are_removed_by_the_next_run(self):
        stale = self.deploy / f".stage-incoming-{'a' * 40}-1-2"
        (stale / "sub").mkdir(parents=True)
        (stale / "sub" / "image.tar.gz").write_text("old")
        unrelated = self.deploy / ".incoming-release"
        unrelated.mkdir()
        self.assertOutcome(self.run_entry(), 0, "passed")
        self.assertFalse(stale.exists())
        self.assertTrue(unrelated.is_dir())

    def test_leftover_stage_containers_and_images_of_a_killed_run_are_swept_before_loading(self):
        (self.rec / "stale-images").write_text(
            f"{STAGE_IMAGE}:" + "b" * 40 + f"\n{STAGE_IMAGE}:" + "c" * 40 + "\n"
        )
        self.assertOutcome(self.run_entry(), 0, "passed")
        events = self.events()
        self.assertIn("docker-rm rm -f hypercal-bot-stage hypercal-stage-redis", events)
        for tag in ("b" * 40, "c" * 40):
            self.assertIn(f"docker-rmi {STAGE_IMAGE}:{tag}", events)
        sweep = max(
            events.index("docker-rm rm -f hypercal-bot-stage hypercal-stage-redis"),
            events.index(f"docker-rmi {STAGE_IMAGE}:{'c' * 40}"),
        )
        self.assertLess(sweep, self.index_of("docker-load"))

    def test_the_sweep_never_removes_a_production_image_even_if_docker_lists_one(self):
        prod = "ghcr.io/alex-mextner/hypercalendarbot:" + "d" * 40
        (self.rec / "stale-images").write_text(f"{prod}\n{STAGE_IMAGE}:{'b' * 40}\n")
        self.assertOutcome(self.run_entry(), 0, "passed")
        events = self.events()
        self.assertIn(f"docker-rmi {STAGE_IMAGE}:{'b' * 40}", events)
        self.assertNotIn(f"docker-rmi {prod}", events)

    def test_sweep_is_not_reached_when_not_provisioned(self):
        (self.stage / "stage.env").unlink()
        self.run_entry()
        self.assertFalse(self.has_event("docker-rm"))


class StaticChecks(unittest.TestCase):
    def test_scripts_are_strict_bash(self):
        for script in (ENTRY, RUN, INSTALLER):
            with self.subTest(script=script.name):
                lines = script.read_text().splitlines()
                self.assertEqual(lines[0], "#!/usr/bin/env bash")
                self.assertIn("set -euo pipefail", lines)
                self.assertIn("umask 077", lines)
                subprocess.run(["bash", "-n", str(script)], check=True)

    def test_scripts_ignore_sigpipe(self):
        for script in (ENTRY, RUN):
            self.assertIn("trap '' PIPE", script.read_text(), script.name)

    def test_entry_has_no_environment_override_hooks(self):
        for script in (ENTRY, RUN, INSTALLER):
            text = script.read_text()
            self.assertNotRegex(text, r"\$\{(HYPERCAL|STAGE|ODROID)_[A-Z_]*:-", script.name)
            self.assertNotIn("export TOKEN", text)


class Installer(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.src = self.tmp / "checkout"
        (self.src / "scripts").mkdir(parents=True)
        self.lib = self.tmp / "usr/lib/hypercal-stage"
        self.entry_path = self.tmp / "usr/sbin/hypercal-stage-qa"
        self.entry_path.parent.mkdir(parents=True)
        self.lib.parent.mkdir(parents=True)
        self.lock = self.tmp / "stage.lock"
        self.write_checkout("one")
        self.git("init", "-q", "-b", "main")
        self.commit("initial")
        self.publish()
        self.script = self.make_script()

    def make_script(self, euid=None):
        uid, gid = os.getuid(), os.getgid()
        text = rewrite(
            INSTALLER.read_text(),
            [
                (
                    "readonly LIB_DIR=/usr/local/lib/hypercal-stage\n",
                    f"readonly LIB_DIR={self.lib}\n",
                ),
                (
                    "readonly ENTRY_PATH=/usr/local/sbin/hypercal-stage-qa\n",
                    f"readonly ENTRY_PATH={self.entry_path}\n",
                ),
                (
                    "readonly REQUIRED_EUID=0\n",
                    f"readonly REQUIRED_EUID={uid if euid is None else euid}\n",
                ),
                ("readonly INSTALL_OWNER=root:root\n", f"readonly INSTALL_OWNER={uid}:{gid}\n"),
                (
                    "readonly STAGE_LOCK_FILE=/run/lock/hypercal-stage.lock\n",
                    f"readonly STAGE_LOCK_FILE={self.lock}\n",
                ),
                ("readonly STAGE_LOCK_WAIT=60\n", "readonly STAGE_LOCK_WAIT=1\n"),
            ],
        )
        script = self.tmp / "install-stage-qa.sh"
        script.write_text(text)
        script.chmod(0o755)
        return script

    def source_path(self, name):
        if name == "docker-compose.stage.yml":
            return self.src / name
        if name == "odroid-stage-qa.sh":
            return self.src / "scripts" / name
        return self.src / "scripts" / name

    def write_checkout(self, version):
        for name in [*LIB_FILES, "odroid-stage-qa.sh"]:
            path = self.source_path(name)
            path.write_text(f"# {name} {version}\n")
            path.chmod(0o755 if name.endswith((".sh", ".py")) else 0o644)

    def git(self, *args):
        subprocess.run(
            ["git", "-C", str(self.src), "-c", "user.name=t", "-c", "user.email=t@t", *args],
            check=True,
            capture_output=True,
        )

    def publish(self):
        """Point origin/main at HEAD, as a fetch of the reviewed main would."""
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")

    def commit(self, message):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)

    def install(self, *args):
        return subprocess.run(
            [str(self.script), *(args or (str(self.src),))],
            capture_output=True,
            text=True,
            env={"PATH": "/usr/bin:/bin"},
            timeout=60,
            check=False,
        )

    def test_fresh_install_copies_exactly_the_lib_files_and_the_entry(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(p.name for p in self.lib.iterdir()), sorted(LIB_FILES))
        for name in LIB_FILES:
            self.assertEqual((self.lib / name).read_text(), f"# {name} one\n")
        self.assertEqual((self.entry_path).read_text(), "# odroid-stage-qa.sh one\n")
        self.assertEqual(stat.S_IMODE(self.entry_path.stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE(self.lib.stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE((self.lib / "stage-qa-run.sh").stat().st_mode), 0o755)
        self.assertEqual(
            stat.S_IMODE((self.lib / "docker-compose.stage.yml").stat().st_mode), 0o644
        )
        self.assertEqual(
            [p.name for p in self.lib.parent.iterdir() if ".new" in p.name or ".bak" in p.name], []
        )

    def test_cwd_is_the_default_checkout(self):
        result = subprocess.run(
            [str(self.script)],
            cwd=self.src,
            capture_output=True,
            text=True,
            env={"PATH": "/usr/bin:/bin"},
            timeout=60,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.lib / "stage-qa-run.sh").is_file())

    def test_reinstall_backs_up_and_prints_a_rollback_that_restores(self):
        self.assertEqual(self.install().returncode, 0)
        self.write_checkout("two")
        self.commit("second")
        self.publish()
        time.sleep(1.1)
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.lib / "stage-qa-run.sh").read_text(), "# stage-qa-run.sh two\n")
        self.assertEqual(self.entry_path.read_text(), "# odroid-stage-qa.sh two\n")
        lib_backups = sorted(
            p for p in self.lib.parent.iterdir() if p.name.startswith(self.lib.name + ".bak-")
        )
        entry_backups = sorted(
            p
            for p in self.entry_path.parent.iterdir()
            if p.name.startswith(self.entry_path.name + ".bak-")
        )
        self.assertEqual((len(lib_backups), len(entry_backups)), (1, 1))
        self.assertRegex(lib_backups[0].name, r"\.bak-\d{8}T\d{6}Z$")
        self.assertEqual(
            (lib_backups[0] / "stage-qa-run.sh").read_text(), "# stage-qa-run.sh one\n"
        )
        self.assertEqual(entry_backups[0].read_text(), "# odroid-stage-qa.sh one\n")
        rollback = next(
            line for line in result.stdout.splitlines() if line.startswith("rollback: ")
        )
        self.assertIn(lib_backups[0].name, rollback)
        subprocess.run(
            ["bash", "-c", rollback[len("rollback: ") :]], check=True, capture_output=True
        )
        self.assertEqual((self.lib / "stage-qa-run.sh").read_text(), "# stage-qa-run.sh one\n")
        self.assertEqual(self.entry_path.read_text(), "# odroid-stage-qa.sh one\n")

    def test_missing_listed_file_is_refused_and_nothing_is_installed(self):
        (self.src / "scripts" / "deploy-evidence.py").unlink()
        self.commit("remove")
        self.publish()
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("deploy-evidence.py", result.stderr)
        self.assertFalse(self.lib.exists())
        self.assertFalse(self.entry_path.exists())

    def test_dirty_checkout_is_refused_and_the_old_install_stays(self):
        self.assertEqual(self.install().returncode, 0)
        (self.src / "scripts" / "stage-qa-run.sh").write_text("# locally edited\n")
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("uncommitted", result.stderr)
        self.assertEqual((self.lib / "stage-qa-run.sh").read_text(), "# stage-qa-run.sh one\n")

    def test_untracked_listed_file_counts_as_dirty(self):
        path = self.src / "scripts" / "log-retention.py"
        self.git("rm", "-q", "--cached", "scripts/log-retention.py")
        self.assertTrue(path.exists())
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("uncommitted", result.stderr)

    def test_checkout_without_origin_main_is_refused(self):
        self.git("update-ref", "-d", "refs/remotes/origin/main")
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("checkout of main", result.stderr)
        self.assertFalse(self.lib.exists())
        self.assertFalse(self.entry_path.exists())

    def test_head_that_is_not_on_origin_main_is_refused_with_no_override(self):
        self.write_checkout("unreviewed")
        self.commit("local only, never merged")
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not on origin/main", result.stderr)
        self.assertFalse(self.lib.exists())
        self.assertNotIn("override", (result.stdout + result.stderr).lower())

    def test_head_behind_origin_main_is_accepted(self):
        old = subprocess.run(
            ["git", "-C", str(self.src), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=False,
        ).stdout.strip()
        self.write_checkout("two")
        self.commit("second")
        self.publish()
        self.git("checkout", "-q", old)
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.lib / "stage-qa-run.sh").read_text(), "# stage-qa-run.sh one\n")

    def test_non_git_directory_is_refused(self):
        shutil.rmtree(self.src / ".git")
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("git checkout", result.stderr)
        self.assertFalse(self.lib.exists())

    def test_non_root_caller_is_refused(self):
        if os.getuid() == 0:
            self.skipTest("running as root")
        script = self.make_script(euid=0)
        result = subprocess.run(
            [str(script), str(self.src)],
            capture_output=True,
            text=True,
            env={"PATH": "/usr/bin:/bin"},
            timeout=60,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("root", result.stderr)
        self.assertFalse(self.lib.exists())

    def test_an_active_stage_run_blocks_the_install(self):
        self.assertEqual(self.install().returncode, 0)
        held = HeldLock(self.lock)
        self.addCleanup(held.release)
        self.write_checkout("two")
        self.commit("second")
        self.publish()
        result = self.install()
        self.assertEqual(result.returncode, 75, result.stderr)
        self.assertEqual((self.lib / "stage-qa-run.sh").read_text(), "# stage-qa-run.sh one\n")
        self.assertEqual(
            [p.name for p in self.lib.parent.iterdir() if ".bak" in p.name or ".new" in p.name], []
        )

    def test_lib_file_list_matches_the_contract(self):
        text = INSTALLER.read_text()
        for name in LIB_FILES:
            self.assertIn(name, text)


if __name__ == "__main__":
    unittest.main()
