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
    "stage-qa-driver.py",
    "stage_qa_common.py",
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
