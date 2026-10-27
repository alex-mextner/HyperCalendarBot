import base64
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
GATE = ROOT / "scripts" / "stage-qa-gate.py"
PR_SHIP = ROOT / ".claude" / "scripts" / "pr-ship.sh"

REPO = "alex-mextner/HyperCalendarBot"
HEAD = "a" * 40
OLD = "b" * 40
MAIN = "c" * 40
RUN = 4242
JOB = 9001
REPORT_JOB = 9002
QA_PATH = ".github/workflows/stage-qa.yml"
QA_JOB = "Stage QA run"
QA_STEP = "Run the stage QA through qa-cli"

# Fake gh: serves fixtures keyed by the joined argv; unknown requests fail loudly. A route is
#   {"body": json}                         a JSON API answer
#   {"text": str} | {"b64": str} + "pad"   raw stdout (the job log), then `pad` bytes of filler lines
#   {"error": stderr, "stdout": raw}       a failing call
#   {"bodies": [route, ...]}               the n-th call of the same argv gets the n-th route, the last repeats
FAKE_GH = """#!/usr/bin/env python3
import base64, json, os, sys
path = os.environ["FAKE_GH_ROUTES"]
routes = json.load(open(path))
key = " ".join(sys.argv[1:])
seen = open(path + ".log").read().splitlines().count(key) if os.path.exists(path + ".log") else 0
with open(path + ".log", "a") as log:
    log.write(key + "\\n")
hit = routes.get(key)
if hit is None:
    sys.stderr.write("fake gh: no route for " + key + "\\n")
    sys.exit(1)
if "bodies" in hit:
    hit = hit["bodies"][min(seen, len(hit["bodies"]) - 1)]
if "error" in hit:
    sys.stdout.write(hit.get("stdout", ""))
    sys.stderr.write(hit["error"] + "\\n")
    sys.exit(1)
if "body" in hit:
    print(json.dumps(hit["body"]))
    sys.exit(0)
data = base64.b64decode(hit["b64"]) if "b64" in hit else hit["text"].encode()
filler = b"2026-10-27T09:00:00.0000000Z filler line of the driver output\\n"
try:
    sys.stdout.buffer.write(data)
    for _ in range(hit.get("pad", 0) // len(filler)):
        sys.stdout.buffer.write(filler)
    sys.stdout.buffer.flush()
except BrokenPipeError:
    os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
"""

PR_KEY = f"pr view 7 --repo {REPO} --json state,isDraft,headRefOid,isCrossRepository"
WF_KEY = f"api repos/{REPO}/contents/{QA_PATH}"


def statuses_key(page=1, head=HEAD):
    return f"api repos/{REPO}/commits/{head}/statuses?per_page=100&page={page}"


REPO_KEY = f"api repos/{REPO}"
RUN_KEY = f"api repos/{REPO}/actions/runs/{RUN}"
JOBS_KEY = f"api repos/{REPO}/actions/runs/{RUN}/jobs?per_page=100"
LOG_KEY = f"api --allow-escape-sequences repos/{REPO}/actions/jobs/{JOB}/logs"
REPORT_LOG_KEY = f"api --allow-escape-sequences repos/{REPO}/actions/jobs/{REPORT_JOB}/logs"


def good_status(**over):
    status = {
        "context": "stage-qa",
        "state": "success",
        "creator": {"login": "github-actions[bot]"},
        "description": f"passed cases=12 run={RUN}",
        "target_url": f"https://github.com/{REPO}/actions/runs/{RUN}",
        "created_at": "2026-10-27T08:37:17Z",
    }
    status.update(over)
    return status


def good_run(**over):
    run = {
        "id": RUN,
        "run_attempt": 1,
        "path": QA_PATH,
        "event": "workflow_run",
        "status": "completed",
        "conclusion": "success",
        # A workflow_run run reports the default branch commit as its head_sha, never the tested PR head.
        "head_sha": MAIN,
        "head_branch": "main",
        "repository": {"full_name": REPO},
        "head_repository": {"full_name": REPO},
    }
    run.update(over)
    return run


def good_steps(**qa_over):
    return [
        {"number": 1, "name": "Set up job", "status": "completed", "conclusion": "success"},
        {"number": 2, "name": QA_STEP, "status": "completed", "conclusion": "success", **qa_over},
        {"number": 3, "name": "Complete job", "status": "completed", "conclusion": "success"},
    ]


def good_job(**over):
    job = {
        "id": JOB, "name": QA_JOB, "run_id": RUN, "run_attempt": 1,
        "status": "completed", "conclusion": "success", "steps": good_steps(),
    }
    job.update(over)
    return job


def report_job(**over):
    times = {"started_at": "2026-10-27T08:37:15Z", "completed_at": "2026-10-27T08:37:18Z"}
    return good_job(**{"id": REPORT_JOB, "name": "Post stage-qa", **times, **over})


# A synthetic job log in the shape the runner writes it (BOM, a timestamp per line, the step header
# with the injected env, then the driver's own output). No real log content is committed.
SETUP_LINES = [
    "Current runner version: '2.0.0'",
    "##[group]GITHUB_TOKEN Permissions",
    "Contents: read",
    "##[endgroup]",
    "Complete job name: Stage QA run",
]
SCRIPT_LINES = ["\x1b[36;1m# synthetic first line\x1b[0m", "\x1b[36;1mset -uo pipefail\x1b[0m"]
DRIVER_LINES = ["STAGE_ARTIFACT archive_sha256=0", "STAGE_QA_RESULT status=passed cases=6 failed=0"]


def header_lines(sha=HEAD, *, env=None, script=SCRIPT_LINES, shell="shell: /usr/bin/bash -e {0}", env_open="env:"):
    env_lines = ["  GH_TOKEN: ***", f"  HEAD_SHA: {sha}"] if env is None else env
    lines = ["##[group]Run # synthetic first line", *script]
    lines += [] if shell is None else [shell]
    lines += [] if env_open is None else [env_open]
    return [*lines, *env_lines, "##[endgroup]"]


def stamped(lines, newline="\n", bom=True):
    body = newline.join(f"2026-10-27T08:23:24.{i:07d}Z {line}" for i, line in enumerate(lines)) + newline
    return ("\ufeff" if bom else "") + body


def qa_log(sha=HEAD, *, header=None, driver=DRIVER_LINES, setup=SETUP_LINES, newline="\n", bom=True, raw_tail=""):
    lines = [*setup, *(header_lines(sha) if header is None else header), *driver, "Evaluate and set job outputs"]
    return stamped(lines, newline, bom) + raw_tail


def good_routes():
    return {
        WF_KEY: {"body": {"name": "stage-qa.yml"}},
        PR_KEY: {"body": {"state": "OPEN", "isDraft": False, "headRefOid": HEAD, "isCrossRepository": False}},
        statuses_key(): {"body": [good_status()]},
        RUN_KEY: {"body": good_run()},
        REPO_KEY: {"body": {"default_branch": "main"}},
        JOBS_KEY: {"body": {"jobs": [good_job(), report_job()]}},
        LOG_KEY: {"text": qa_log()},
    }


class GateHarness(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        gh = self.tmp / "bin" / "gh"
        gh.parent.mkdir()
        gh.write_text(FAKE_GH)
        gh.chmod(gh.stat().st_mode | stat.S_IXUSR)
        self.routes_file = self.tmp / "routes.json"

    def gate(self, routes, **env):
        self.routes_file.write_text(json.dumps(routes))
        Path(str(self.routes_file) + ".log").unlink(missing_ok=True)
        env = dict(os.environ, PATH=f"{self.tmp / 'bin'}:{os.environ['PATH']}", FAKE_GH_ROUTES=str(self.routes_file), **env)
        return subprocess.run(
            [sys.executable, str(GATE), "--repo", REPO, "--pr", "7"],
            capture_output=True, text=True, env=env,
        )

    def assertNotGreen(self, routes, *words):
        done = self.gate(routes)
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        for word in words:
            self.assertIn(word, done.stderr)
        return done

    def assertCannotEvaluate(self, routes, *words, **env):
        done = self.gate(routes, **env)
        self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
        self.assertNotIn("green", done.stdout)
        for word in words:
            self.assertIn(word, done.stderr)
        return done

    def fetched(self):
        return Path(str(self.routes_file) + ".log").read_text().splitlines()


class GateTest(GateHarness):

    def test_green(self):
        done = self.gate(good_routes())
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("green", done.stdout)

    def test_no_status_says_push(self):
        routes = good_routes()
        routes[statuses_key()] = {"body": [{"context": "ci", "state": "success"}]}
        self.assertNotGreen(routes, "push", "No `stage-qa` status")

    def test_pending_says_wait(self):
        routes = good_routes()
        routes[statuses_key()] = {"body": [good_status(state="pending", description="stage build started", target_url="https://x/y")]}
        self.assertNotGreen(routes, "pending", "wait", "https://x/y")

    def test_failure(self):
        routes = good_routes()
        routes[statuses_key()] = {"body": [good_status(state="failure", description=f"failed run={RUN}")]}
        self.assertNotGreen(routes, "failure")

    def test_status_on_older_head_only_is_stale(self):
        routes = good_routes()
        routes[statuses_key()] = {"body": []}
        routes[statuses_key(head=OLD)] = {"body": [good_status()]}
        self.assertNotGreen(routes, "head")

    def test_newest_status_wins_over_older_success(self):
        routes = good_routes()
        routes[statuses_key()] = {"body": [good_status(state="failure", description=f"failed run={RUN}"), good_status()]}
        self.assertNotGreen(routes, "failure")

    def test_description_mismatch(self):
        for description in ("passed cases=0 run=4242", "passed cases=3 run=4242 extra", "ok", "passed cases=3 run=0"):
            routes = good_routes()
            routes[statuses_key()] = {"body": [good_status(description=description)]}
            with self.subTest(description=description):
                self.assertNotGreen(routes, "description")

    def test_creator_not_actions_bot(self):
        routes = good_routes()
        routes[statuses_key()] = {"body": [good_status(creator={"login": "alex-mextner"})]}
        self.assertNotGreen(routes, "not trusted")

    def test_target_url_other_repo_or_run(self):
        for url in (
            f"https://github.com/evil/fork/actions/runs/{RUN}",
            f"https://github.com/{REPO}/actions/runs/999",
            f"https://github.com/{REPO}/pull/7",
            None,
        ):
            routes = good_routes()
            routes[statuses_key()] = {"body": [good_status(target_url=url)]}
            with self.subTest(url=url):
                self.assertNotGreen(routes, "target_url")

    def test_run_forged_or_mismatched(self):
        cases = {
            "event": {"event": "pull_request"},
            "path": {"path": ".github/workflows/other.yml"},
            "head_branch": {"head_branch": "feature"},
            "run id": {"id": RUN + 1},
            "not completed": {"status": "in_progress", "conclusion": None},
            "conclusion": {"conclusion": "failure"},
            "repository": {"repository": {"full_name": "evil/fork"}},
            "head_repository": {"head_repository": {"full_name": "evil/fork"}},
        }
        for name, over in cases.items():
            routes = good_routes()
            routes[RUN_KEY] = {"body": good_run(**over)}
            with self.subTest(name):
                self.assertNotGreen(routes, "not a trusted QA run")

    def test_qa_job_missing_or_failed(self):
        for jobs in (
            [],
            [report_job()],
            [good_job(conclusion="failure")],
            [good_job(status="in_progress", conclusion=None)],
            [good_job(), good_job(id=JOB + 5)],
        ):
            routes = good_routes()
            routes[JOBS_KEY] = {"body": {"jobs": jobs}}
            with self.subTest(jobs=jobs):
                self.assertNotGreen(routes, "Stage QA run")

    def test_draft_closed_fork(self):
        for over, word in (
            ({"isDraft": True}, "draft"),
            ({"state": "CLOSED"}, "not open"),
            ({"state": "MERGED"}, "not open"),
            ({"isCrossRepository": True}, "fork"),
        ):
            routes = good_routes()
            routes[PR_KEY] = {"body": {"state": "OPEN", "isDraft": False, "headRefOid": HEAD, "isCrossRepository": False, **over}}
            with self.subTest(over=over):
                self.assertNotGreen(routes, word)

    def test_bootstrap_when_workflow_absent(self):
        routes = {WF_KEY: {"error": "gh: Not Found (HTTP 404)"}}
        done = self.gate(routes)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("stage-qa gate inactive", done.stdout)

    def test_an_error_that_merely_contains_404_is_not_a_bootstrap_pass(self):
        for message in ("gh: rate limit, installation 40412 throttled", "gh: Server Error (HTTP 5040)", "gh: remaining: 404 requests"):
            with self.subTest(message):
                done = self.gate({WF_KEY: {"error": message}})
                self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
                self.assertNotIn("gate inactive", done.stdout)

    def test_gh_errors_are_exit_2(self):
        broken = {
            "workflow check": {WF_KEY: {"error": "gh: Server Error (HTTP 500)"}},
            "pr view": {**good_routes(), PR_KEY: {"error": "boom"}},
            "statuses": {**good_routes(), statuses_key(): {"error": "boom"}},
            "run": {**good_routes(), RUN_KEY: {"error": "boom"}},
            "jobs": {**good_routes(), JOBS_KEY: {"error": "boom"}},
            "default branch": {**good_routes(), REPO_KEY: {"error": "boom"}},
            "default branch missing": {**good_routes(), REPO_KEY: {"body": {}}},
            "job log": {**good_routes(), LOG_KEY: {"error": "boom"}},
            "missing route": {WF_KEY: {"body": {}}},
        }
        for name, routes in broken.items():
            with self.subTest(name):
                done = self.gate(routes)
                self.assertEqual(done.returncode, 2, done.stdout + done.stderr)

    def test_gh_missing_is_exit_2(self):
        env = dict(os.environ, PATH="/nonexistent")
        done = subprocess.run([sys.executable, str(GATE), "--repo", REPO, "--pr", "7"], capture_output=True, text=True, env=env)
        self.assertEqual(done.returncode, 2)

    def test_statuses_pagination(self):
        routes = good_routes()
        filler = [{"context": "ci", "state": "success"}] * 100
        routes[statuses_key(1)] = {"body": filler}
        routes[statuses_key(2)] = {"body": [good_status()]}
        done = self.gate(routes)
        self.assertEqual(done.returncode, 0, done.stderr)
        log = Path(str(self.routes_file) + ".log").read_text()
        self.assertIn("page=2", log)


class LogBindingTest(GateHarness):
    """The tested head is bound through the runner's step header in the QA job log (synthetic logs only)."""

    def with_log(self, text=None, **route):
        routes = good_routes()
        routes[LOG_KEY] = route if text is None else {"text": text, **route}
        return routes

    def test_green_reads_the_log_of_the_qa_job_only_once(self):
        # The run's own head_sha is the default branch commit: it is not what binds the tested head.
        self.assertNotEqual(good_run()["head_sha"], HEAD)
        done = self.gate(good_routes())
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout, f"stage-qa gate: green for {HEAD[:12]} cases=12 run={RUN}\n")
        self.assertEqual(done.stderr, "")
        self.assertEqual(self.fetched().count(LOG_KEY), 1)
        self.assertNotIn(REPORT_LOG_KEY, self.fetched())

    def test_line_endings_and_bom_do_not_matter(self):
        for newline in ("\n", "\r\n"):
            for bom in (True, False):
                with self.subTest(newline=newline, bom=bom):
                    done = self.gate(self.with_log(qa_log(newline=newline, bom=bom)))
                    self.assertEqual(done.returncode, 0, done.stderr)

    def test_a_log_of_another_commit_is_refused(self):
        for sha in (OLD, MAIN):
            with self.subTest(sha=sha):
                done = self.assertNotGreen(self.with_log(qa_log(sha)), "tested", sha[:12], f"not the PR head {HEAD[:12]}")
                self.assertNotIn(sha, done.stderr)

    def test_a_head_sha_that_is_not_a_full_lowercase_sha_is_refused(self):
        for value in (HEAD.upper(), HEAD[:39], HEAD + "a", "main", "", HEAD + " ", HEAD + " # x", "0x" + HEAD[2:]):
            with self.subTest(value=value):
                header = header_lines(env=["  GH_TOKEN: ***", f"  HEAD_SHA: {value}"])
                self.assertNotGreen(self.with_log(qa_log(header=header)), "HEAD_SHA")
        for line in (f"   HEAD_SHA: {HEAD}", f" HEAD_SHA: {HEAD}", f"  HEAD_SHA:{HEAD}", f"  head_sha: {HEAD}"):
            with self.subTest(line=line):
                self.assertNotGreen(self.with_log(qa_log(header=header_lines(env=[line]))), "HEAD_SHA")

    def test_a_duplicate_or_missing_head_sha_declaration_is_refused(self):
        ok = f"  HEAD_SHA: {HEAD}"
        cases = {
            "same twice": [ok, ok],
            "wrong then right": [f"  HEAD_SHA: {OLD}", ok],
            "right then wrong": [ok, f"  HEAD_SHA: {OLD}"],
            "none": ["  GH_TOKEN: ***"],
        }
        for name, env in cases.items():
            with self.subTest(name):
                self.assertNotGreen(self.with_log(qa_log(header=header_lines(env=env))), "HEAD_SHA")
        printed_by_the_script = header_lines(script=[*SCRIPT_LINES, f"HEAD_SHA: {HEAD}"])
        self.assertNotGreen(self.with_log(qa_log(header=printed_by_the_script)), "HEAD_SHA")
        only_in_the_script = header_lines(script=[f"HEAD_SHA: {HEAD}"], env=["  GH_TOKEN: ***"])
        self.assertNotGreen(self.with_log(qa_log(header=only_in_the_script)), "HEAD_SHA")

    def test_a_header_without_a_shell_and_env_block_is_refused(self):
        for name, header in {
            "no shell": header_lines(shell=None),
            "no env": header_lines(env_open=None),
            "shell and env swapped": [*header_lines()[:-5], "env:", "shell: /usr/bin/bash -e {0}", *header_lines()[-3:]],
        }.items():
            with self.subTest(name):
                self.assertNotGreen(self.with_log(qa_log(header=header)), "env block")

    def test_a_log_without_a_step_header_is_refused(self):
        for name, log in {
            "setup only": stamped(SETUP_LINES),
            "group not at the line start": stamped([*SETUP_LINES, "x" + header_lines()[0], *header_lines()[1:]]),
            "wrong group name": stamped([*SETUP_LINES, *[line.replace("##[group]Run ", "##[group]Post ") for line in header_lines()]]),
        }.items():
            with self.subTest(name):
                self.assertNotGreen(self.with_log(log), "no step header")

    def test_a_header_printed_later_neither_helps_nor_hurts(self):
        def variants(sha):
            plain = header_lines(sha)
            return {
                "stamped": {"driver": [*DRIVER_LINES, *plain]},
                "ansi": {"driver": [*DRIVER_LINES, *[f"\x1b[36;1m{line}\x1b[0m" for line in plain]]},
                "glued to the endgroup": {"driver": [*DRIVER_LINES, "##[endgroup]", *plain]},
                "unstamped": {"raw_tail": "\n".join(plain) + "\n"},
                "bom and cr": {"raw_tail": "\ufeff" + "\r\n".join(plain) + "\r\n"},
            }

        for name, extra in variants(HEAD).items():
            with self.subTest(f"forged right sha after a real {name} wrong header"):
                self.assertNotGreen(self.with_log(qa_log(OLD, **extra)), "tested", OLD[:12])
        for name, extra in variants(OLD).items():
            with self.subTest(f"forged wrong sha after the real header, {name}"):
                self.assertEqual(self.gate(self.with_log(qa_log(HEAD, **extra))).returncode, 0)

    def test_only_the_first_header_group_of_the_log_counts(self):
        # A second header placed before the real one would be taken for the real one: only the runner
        # (the setup step) could put it there, never the driver, which runs after the real header.
        early = [*SETUP_LINES, *header_lines(OLD), *header_lines(HEAD)]
        self.assertNotGreen(self.with_log(stamped([*early, *DRIVER_LINES])), "tested", OLD[:12])

    def test_the_steps_of_the_job_must_be_the_exact_trusted_ones(self):
        wrong_steps = {
            "step 2 renamed": good_steps(name="Run something else"),
            "step 2 numbered 3": good_steps(number=3),
            "step 2 failed": good_steps(conclusion="failure"),
            "step 2 skipped": good_steps(conclusion="skipped"),
            "step 2 running": good_steps(status="in_progress", conclusion=None),
            "step 1 is not the setup": [{"number": 1, "name": "Run the stage QA through qa-cli"}, *good_steps()[1:]],
            "only the setup": good_steps()[:1],
            "none": [],
            "not a list": "steps",
            "not objects": ["Set up job", QA_STEP],
        }
        for name, steps in wrong_steps.items():
            routes = good_routes()
            routes[JOBS_KEY] = {"body": {"jobs": [good_job(steps=steps)]}}
            with self.subTest(name):
                self.assertNotGreen(routes, "Stage QA run")
                self.assertNotIn(LOG_KEY, self.fetched())

    def test_a_job_of_another_run_or_without_an_id_is_refused(self):
        for name, job in {
            "other run": good_job(run_id=RUN + 1),
            "other attempt": good_job(run_attempt=2),
            "string id": good_job(id=str(JOB)),
            "bool id": good_job(id=True),
            "no id": {k: v for k, v in good_job().items() if k != "id"},
        }.items():
            routes = good_routes()
            routes[JOBS_KEY] = {"body": {"jobs": [job]}}
            with self.subTest(name):
                self.assertNotGreen(routes, "Stage QA run")

    def test_the_log_of_another_job_cannot_stand_in_for_the_qa_job(self):
        routes = self.with_log(qa_log(OLD))
        routes[REPORT_LOG_KEY] = {"text": qa_log(HEAD)}
        self.assertNotGreen(routes, "tested", OLD[:12])
        self.assertNotIn(REPORT_LOG_KEY, self.fetched())
        routes = good_routes()
        routes[JOBS_KEY] = {"body": {"jobs": [report_job()]}}
        routes[REPORT_LOG_KEY] = {"text": qa_log(HEAD)}
        self.assertNotGreen(routes, "Stage QA run")
        self.assertNotIn(REPORT_LOG_KEY, self.fetched())

    def test_a_run_that_is_not_from_the_default_branch_is_refused(self):
        for branch in ("feature", None, "Main", "main "):
            routes = good_routes()
            routes[RUN_KEY] = {"body": good_run(head_branch=branch)}
            with self.subTest(branch=branch):
                self.assertNotGreen(routes, "default branch")
        routes = good_routes()
        routes[REPO_KEY] = {"body": {"default_branch": "trunk"}}
        self.assertNotGreen(routes, "default branch 'trunk'")

    def test_every_log_read_failure_is_exit_2_and_leaks_nothing(self):
        secret = "SECRET-SIG ghs_SECRETTOKEN https://signed.example/blob?sig=SECRET-SIG"
        for status in ("403", "404", "410", "500"):
            with self.subTest(status):
                message = f"gh: failed (HTTP {status}) {secret}"
                done = self.assertCannotEvaluate(
                    self.with_log(error=message, stdout=f'{{"message": "{secret}"}}'), f"HTTP {status}", f"job {JOB}",
                )
                self.assertNotIn("SECRET", done.stdout + done.stderr)
        done = self.assertCannotEvaluate(self.with_log(error=f"gh: unknown flag {secret}"), "gh exit 1")
        self.assertNotIn("SECRET", done.stdout + done.stderr)

    def test_empty_garbage_and_truncated_logs_fail_closed(self):
        cut = stamped([*SETUP_LINES, *header_lines()[:-1]])
        cases = {
            "empty": "",
            "blank lines": "\n\n\n",
            "plain text": "this is not a runner log\nat all\n",
            "binary": None,
            "setup then a line without timestamp": stamped(SETUP_LINES) + "no timestamp here\n" + stamped(header_lines()),
            "short fraction": "2026-10-27T08:23:24.761Z ##[group]Run x\n",
            "header never closed": cut,
            "cut inside the header": stamped([*SETUP_LINES, *header_lines()[:3]])[:-5],
        }
        for name, text in cases.items():
            route = {"b64": base64.b64encode(bytes(range(256)) * 4).decode()} if text is None else {"text": text}
            with self.subTest(name):
                self.assertCannotEvaluate(self.with_log(**route))

    def test_a_huge_driver_output_after_the_header_is_not_read(self):
        done = self.gate(self.with_log(text=qa_log(), pad=8 * 1024 * 1024))
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_a_header_beyond_the_head_of_the_log_cannot_be_evaluated(self):
        padding = ["setup output that goes on and on and on"] * 9000
        done = self.assertCannotEvaluate(self.with_log(stamped([*SETUP_LINES, *padding, *header_lines()])), "no complete step header")
        self.assertIn("256 KiB", done.stderr)

    def test_bytes_that_are_not_utf8_after_the_header_are_ignored(self):
        raw = qa_log().encode() + b"2026-10-27T09:00:00.0000000Z \xff\xfe\x80 driver bytes\n"
        done = self.gate(self.with_log(b64=base64.b64encode(raw).decode()))
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_error_texts_never_echo_log_lines(self):
        marker = "ATTACKER-LINE-TOKEN"
        driver = [*DRIVER_LINES, f"{marker} https://signed.example/?sig={marker}"]
        bad_headers = {
            "wrong sha": header_lines(OLD, script=[*SCRIPT_LINES, marker]),
            "malformed sha": header_lines(env=[f"  HEAD_SHA: {HEAD} {marker}"]),
            "duplicates": header_lines(env=[f"  HEAD_SHA: {HEAD}", f"  HEAD_SHA: {marker}"]),
            "no env": header_lines(script=[marker], env_open=None),
        }
        for name, header in bad_headers.items():
            with self.subTest(name):
                done = self.assertNotGreen(self.with_log(qa_log(header=header, driver=driver)))
                self.assertNotIn(marker, done.stdout + done.stderr)
        for line in (f"{marker} not a timestamp", f"2026-10-27T08:23:24.0000000Z {marker}"):
            with self.subTest(line):
                done = self.gate(self.with_log(stamped(SETUP_LINES) + line + "\n" + stamped(header_lines())))
                self.assertNotIn(marker, done.stdout + done.stderr)

    def test_the_pr_head_moving_while_the_gate_reads_is_refused(self):
        moved = {"state": "OPEN", "isDraft": False, "headRefOid": OLD, "isCrossRepository": False}
        closed = {**moved, "headRefOid": HEAD, "state": "CLOSED"}
        for name, second, word in (("moved", moved, "moved"), ("closed", closed, "not open")):
            routes = good_routes()
            routes[PR_KEY] = {"bodies": [good_routes()[PR_KEY], {"body": second}]}
            with self.subTest(name):
                self.assertNotGreen(routes, word)

    def test_the_local_receipt_is_not_evidence(self):
        receipts = self.tmp / ".local" / "state" / "hypercal-stage-qa" / "receipts"
        receipts.mkdir(parents=True)
        (receipts / f"{HEAD}.json").write_text(json.dumps({"sha": HEAD, "status": "passed"}))
        done = self.gate(self.with_log(qa_log(OLD)), HOME=str(self.tmp))
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)


class StatusFromReportJobTest(GateHarness):
    """Any PR workflow can post a status as github-actions[bot]; the gate ties it to the run's report job."""

    def with_status(self, **over):
        routes = good_routes()
        routes[statuses_key()] = {"body": [good_status(**over)]}
        return routes

    def test_a_status_created_outside_the_report_job_is_refused(self):
        for created in ("2026-10-27T08:37:14Z", "2026-10-27T08:37:19Z", "2026-10-27T08:00:00Z", "2026-10-28T08:37:16Z"):
            with self.subTest(created=created):
                self.assertNotGreen(self.with_status(created_at=created), "outside its run time")
                self.assertNotIn(LOG_KEY, self.fetched())

    def test_the_window_of_the_report_job_includes_its_first_and_last_second(self):
        for created in ("2026-10-27T08:37:15Z", "2026-10-27T08:37:18Z"):
            with self.subTest(created=created):
                self.assertEqual(self.gate(self.with_status(created_at=created)).returncode, 0)

    def test_a_status_or_job_without_a_usable_time_cannot_be_evaluated(self):
        for created in (None, "", "yesterday", "2026-10-27T08:37:17", "2026-13-45T08:37:17Z", "2026-10-27T08:37:17.000Z", 1788000000):
            with self.subTest(created=created):
                self.assertCannotEvaluate(self.with_status(created_at=created), "timestamp")
        for over in ({"started_at": None}, {"completed_at": None}, {"started_at": "soon"}):
            routes = good_routes()
            routes[JOBS_KEY] = {"body": {"jobs": [good_job(), report_job(**over)]}}
            with self.subTest(over=over):
                self.assertCannotEvaluate(routes, "timestamp")

    def test_the_report_job_must_exist_once_and_have_succeeded(self):
        for name, jobs in {
            "missing": [good_job()],
            "failed": [good_job(), report_job(conclusion="failure")],
            "running": [good_job(), report_job(status="in_progress", conclusion=None)],
            "twice": [good_job(), report_job(), report_job(id=REPORT_JOB + 1)],
            "other run": [good_job(), report_job(run_id=RUN + 1)],
        }.items():
            routes = good_routes()
            routes[JOBS_KEY] = {"body": {"jobs": jobs}}
            with self.subTest(name):
                self.assertNotGreen(routes, "Post stage-qa")
                self.assertNotIn(LOG_KEY, self.fetched())

    def test_a_report_only_rerun_keeps_the_earlier_qa_job(self):
        routes = good_routes()
        routes[RUN_KEY] = {"body": good_run(run_attempt=2)}
        routes[JOBS_KEY] = {"body": {"jobs": [good_job(run_attempt=1), report_job(run_attempt=2)]}}
        self.assertEqual(self.gate(routes).returncode, 0)

    def test_job_attempts_outside_the_run_are_refused(self):
        for attempt in (3, 0, -1, "1", None, True, 1.0):
            routes = good_routes()
            routes[RUN_KEY] = {"body": good_run(run_attempt=2)}
            routes[JOBS_KEY] = {"body": {"jobs": [good_job(run_attempt=attempt), report_job(run_attempt=2)]}}
            with self.subTest(attempt=attempt):
                self.assertNotGreen(routes, "attempt")

    def test_a_run_and_jobs_without_a_valid_attempt_are_refused(self):
        absent_run = {k: v for k, v in good_run().items() if k != "run_attempt"}
        absent_job = {k: v for k, v in good_job().items() if k != "run_attempt"}
        absent_report = {k: v for k, v in report_job().items() if k != "run_attempt"}
        cases = {
            "both absent": (absent_run, [absent_job, absent_report]),
            "run absent": (absent_run, [good_job(), report_job()]),
            "run bool": (good_run(run_attempt=True), [good_job(), report_job()]),
            "run zero": (good_run(run_attempt=0), [good_job(run_attempt=0), report_job(run_attempt=0)]),
        }
        for name, (run, jobs) in cases.items():
            routes = good_routes()
            routes[RUN_KEY] = {"body": run}
            routes[JOBS_KEY] = {"body": {"jobs": jobs}}
            with self.subTest(name):
                self.assertNotGreen(routes, "attempt")
                self.assertNotIn(LOG_KEY, self.fetched())


def load_gate():
    spec = importlib.util.spec_from_file_location("stage_qa_gate_under_test", GATE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LogReaderTest(unittest.TestCase):
    def test_a_gh_that_never_finishes_is_killed_and_refused(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        gh = tmp / "gh"
        gh.write_text("#!/bin/sh\nexec sleep 30\n")
        gh.chmod(0o755)
        gate = load_gate()
        gate.LOG_DEADLINE_SECONDS = 1
        with (
            mock.patch.dict(os.environ, {"PATH": f"{tmp}:{os.environ['PATH']}"}),
            self.assertRaisesRegex(gate.CannotEvaluate, "did not finish within 1s"),
        ):
            gate.read_job_log_head(REPO, JOB)


class WorkflowAssumptionsTest(unittest.TestCase):
    """The log binding is only as good as the workflow it reads: pin what it relies on."""

    def test_the_qa_job_has_one_step_and_it_gets_only_the_token_and_the_head_sha(self):
        text = (ROOT / ".github" / "workflows" / "stage-qa.yml").read_text()
        qa_job = text.split("\n  qa:\n", 1)[1].split("\n  report:\n", 1)[0]
        steps = qa_job.split("\n    steps:\n", 1)[1]
        self.assertEqual(len(re.findall(r"^      - ", steps, re.MULTILINE)), 1)
        self.assertIsNone(re.search(r"^\s*(- )?uses:", qa_job, re.MULTILINE))
        self.assertIn("- name: Run the stage QA through qa-cli", steps)
        env = steps.split("        env:\n", 1)[1].split("        run:", 1)[0]
        self.assertEqual(
            dict(re.findall(r"^          ([A-Z_]+): (.*)$", env, re.MULTILINE)),
            {"GH_TOKEN": "${{ secrets.GITHUB_TOKEN }}", "HEAD_SHA": "${{ github.event.workflow_run.head_sha }}"},
        )


class PrShipTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.log = self.tmp / "calls.log"
        repo = self.tmp / "repo"
        (repo / ".claude" / "scripts").mkdir(parents=True)
        (repo / "scripts").mkdir()
        shutil.copy(PR_SHIP, repo / ".claude" / "scripts" / "pr-ship.sh")
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        self.repo = repo
        self.shared = self.tmp / "tools" / "ci" / "ship" / "ship.sh"
        self.shared.parent.mkdir(parents=True)
        self.write_exec(self.shared, f'#!/usr/bin/env bash\necho "ship $*" >> "{self.log}"\n')
        self.write_exec(self.tmp / "bin" / "gh", f'#!/usr/bin/env bash\nif [[ "$1 $2" == "repo view" ]]; then echo {REPO}; exit 0; fi\nexit 1\n')
        self.set_gate(0)

    def write_exec(self, path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        path.chmod(0o755)

    def commit_gate_on_main(self, body):
        # The gate that ships is origin/main's copy: commit it and point refs/remotes/origin/main at it.
        self.write_exec(self.repo / "scripts" / "stage-qa-gate.py", body)
        git = ["git", "-C", str(self.repo), "-c", "user.name=t", "-c", "user.email=t@example.test"]
        subprocess.run([*git, "add", "scripts/stage-qa-gate.py"], check=True)
        subprocess.run([*git, "commit", "-qm", "gate"], check=True)
        subprocess.run([*git, "update-ref", "refs/remotes/origin/main", "HEAD"], check=True)

    def set_gate(self, code):
        # Records cwd and args so the test can assert where and how the gate ran.
        self.commit_gate_on_main(
            f'import os, sys\nopen("{self.log}", "a").write("gate cwd=" + os.getcwd() + " " + " ".join(sys.argv[1:]) + "\\n")\n'
            f'sys.stderr.write("gate says no\\n") if {code} else None\nsys.exit({code})\n',
        )

    def run_ship(self, *args):
        env = dict(
            os.environ,
            HOME=str(self.tmp),
            XDG_CONFIG_HOME=str(self.tmp / "cfg"),
            AGENT_TOOLS_ROOT=str(self.tmp / "tools"),
            PATH=f"{self.tmp / 'bin'}:{os.environ['PATH']}",
        )
        self.write_exec(self.tmp / "tools" / "ci" / "ship" / "ship.sh", self.shared.read_text())
        return subprocess.run(
            ["bash", str(self.repo / ".claude" / "scripts" / "pr-ship.sh"), *args],
            cwd=self.repo, capture_output=True, text=True, env=env,
        )

    def calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def test_gate_runs_before_shared_ship_in_checkout_root(self):
        self.run_ship("7")
        calls = self.calls()
        self.assertEqual(len(calls), 2, calls)
        self.assertTrue(calls[0].startswith("gate cwd="), calls)
        self.assertIn(os.path.realpath(self.repo), calls[0])
        self.assertIn(f"--repo {REPO} --pr 7", calls[0])
        self.assertEqual(calls[1], "ship 7")

    def test_failing_gate_stops_ship_with_message(self):
        self.set_gate(1)
        done = self.run_ship("7")
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("gate says no", done.stderr)
        self.assertEqual([c for c in self.calls() if c.startswith("ship")], [])

    def test_dry_run_skips_gate(self):
        self.set_gate(1)
        done = self.run_ship("7", "--dry-run")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.calls(), ["ship 7 --dry-run"])

    def test_a_checkout_that_edits_its_own_gate_cannot_wave_itself_through(self):
        self.set_gate(1)
        self.write_exec(self.repo / "scripts" / "stage-qa-gate.py", "import sys\nsys.exit(0)\n")
        done = self.run_ship("7")
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("gate says no", done.stderr)
        self.assertEqual([c for c in self.calls() if c.startswith("ship")], [])

    def test_bootstrap_when_main_has_no_gate_script_yet_says_so_and_ships(self):
        subprocess.run(["git", "-C", str(self.repo), "update-ref", "-d", "refs/remotes/origin/main"], check=True)
        done = self.run_ship("7")
        self.assertIn("stage-qa-gate.py is not on origin/main", done.stderr)
        self.assertIn("NOT enforced", done.stderr)
        self.assertEqual(self.calls(), ["ship 7"])


if __name__ == "__main__":
    unittest.main()
