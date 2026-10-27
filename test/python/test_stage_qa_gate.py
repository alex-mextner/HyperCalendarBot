import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GATE = ROOT / "scripts" / "stage-qa-gate.py"
PR_SHIP = ROOT / ".claude" / "scripts" / "pr-ship.sh"

REPO = "alex-mextner/HyperCalendarBot"
HEAD = "a" * 40
OLD = "b" * 40
RUN = 4242
QA_PATH = ".github/workflows/stage-qa.yml"

# Fake gh: serves JSON fixtures keyed by the joined argv; unknown requests fail loudly.
FAKE_GH = """#!/usr/bin/env python3
import json, os, sys
routes = json.load(open(os.environ["FAKE_GH_ROUTES"]))
key = " ".join(sys.argv[1:])
with open(os.environ["FAKE_GH_ROUTES"] + ".log", "a") as log:
    log.write(key + "\\n")
hit = routes.get(key)
if hit is None:
    sys.stderr.write("fake gh: no route for " + key + "\\n")
    sys.exit(1)
if "error" in hit:
    sys.stderr.write(hit["error"] + "\\n")
    sys.exit(1)
print(json.dumps(hit["body"]))
"""

PR_KEY = f"pr view 7 --repo {REPO} --json state,isDraft,headRefOid,isCrossRepository"
WF_KEY = f"api repos/{REPO}/contents/{QA_PATH}"


def statuses_key(page=1, head=HEAD):
    return f"api repos/{REPO}/commits/{head}/statuses?per_page=100&page={page}"


RUN_KEY = f"api repos/{REPO}/actions/runs/{RUN}"
JOBS_KEY = f"api repos/{REPO}/actions/runs/{RUN}/jobs?per_page=100"


def good_status(**over):
    status = {
        "context": "stage-qa",
        "state": "success",
        "creator": {"login": "github-actions[bot]"},
        "description": f"passed cases=12 run={RUN}",
        "target_url": f"https://github.com/{REPO}/actions/runs/{RUN}",
    }
    status.update(over)
    return status


def good_run(**over):
    run = {
        "path": QA_PATH,
        "event": "workflow_run",
        "status": "completed",
        "conclusion": "success",
        "head_sha": HEAD,
        "repository": {"full_name": REPO},
        "head_repository": {"full_name": REPO},
    }
    run.update(over)
    return run


def good_routes():
    return {
        WF_KEY: {"body": {"name": "stage-qa.yml"}},
        PR_KEY: {"body": {"state": "OPEN", "isDraft": False, "headRefOid": HEAD, "isCrossRepository": False}},
        statuses_key(): {"body": [good_status()]},
        RUN_KEY: {"body": good_run()},
        JOBS_KEY: {"body": {"jobs": [{"name": "Stage QA run", "conclusion": "success"}]}},
    }


class GateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        gh = self.tmp / "bin" / "gh"
        gh.parent.mkdir()
        gh.write_text(FAKE_GH)
        gh.chmod(gh.stat().st_mode | stat.S_IXUSR)
        self.routes_file = self.tmp / "routes.json"

    def gate(self, routes):
        self.routes_file.write_text(json.dumps(routes))
        env = dict(os.environ, PATH=f"{self.tmp / 'bin'}:{os.environ['PATH']}", FAKE_GH_ROUTES=str(self.routes_file))
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
            "head_sha": {"head_sha": OLD},
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
            [{"name": "report", "conclusion": "success"}],
            [{"name": "Stage QA run", "conclusion": "failure"}],
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

    def test_green_output_names_head_cases_and_run(self):
        done = self.gate(good_routes())
        self.assertEqual(done.stdout, f"stage-qa gate: green for {HEAD[:12]} cases=12 run={RUN}\n")

    def test_state_and_refusal_messages_are_specific(self):
        url = f"https://github.com/{REPO}/actions/runs/{RUN}"
        cases = {
            "merged": (PR_KEY, {"state": "MERGED", "isDraft": False, "headRefOid": HEAD, "isCrossRepository": False}, "PR #7 is MERGED, not open"),
            "failure with no url": (statuses_key(), [good_status(state="error", target_url=None)], "is error on head " + HEAD[:12] + " ((no run URL))"),
            "creator": (statuses_key(), [good_status(creator=None)], "was posted by None, not github-actions[bot]"),
            "description": (statuses_key(), [good_status(description=None)], "description None is not"),
            "url": (statuses_key(), [good_status(target_url="https://x/y")], f"target_url 'https://x/y' is not {url}"),
        }
        for name, (key, body, message) in cases.items():
            routes = good_routes()
            routes[key] = {"body": body}
            with self.subTest(name):
                done = self.assertNotGreen(routes)
                self.assertIn(message, done.stderr)

    def test_every_run_problem_is_reported_together(self):
        routes = good_routes()
        routes[RUN_KEY] = {"body": good_run(event="push", head_sha=OLD, repository=None, status="queued", conclusion=None)}
        done = self.assertNotGreen(routes, "not a trusted QA run")
        self.assertIn("event is 'push', expected workflow_run; run is queued/None, expected completed/success; ", done.stderr)
        self.assertIn(f"run head_sha {OLD[:12]} differs from PR head {HEAD[:12]}; repository is None, expected {REPO}", done.stderr)
        self.assertIn("Re-run Stage QA from the PR.", done.stderr)

    def test_unusable_responses_are_exit_2_with_a_reason(self):
        cases = {
            "head sha missing": ({**good_routes(), PR_KEY: {"body": {"state": "OPEN", "headRefOid": "nope"}}}, "PR head sha missing"),
            "statuses not a list": ({**good_routes(), statuses_key(): {"body": {"a": 1}}}, "statuses response is not a list"),
            "jobs not a list": ({**good_routes(), JOBS_KEY: {"body": {"jobs": "x"}}}, "jobs response has no jobs list"),
            "jobs not an object": ({**good_routes(), JOBS_KEY: {"body": []}}, "jobs response has no jobs list"),
        }
        for name, (routes, message) in cases.items():
            with self.subTest(name):
                done = self.gate(routes)
                self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
                self.assertIn(message, done.stderr)


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
