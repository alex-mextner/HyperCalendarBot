import json
import unittest
from pathlib import Path

from post_ship_deploy_support import (
    SHA,
    Scripted,
    completed,
    in_order,
    module,
)


class HostedActionDecisionTests(unittest.TestCase):
    """Every branch of the hosted-run classification, each refusing for its own stated reason."""

    def action(self, workflow, jobs=None):
        return module.hosted_action(workflow, jobs)

    def refuses(self, reason, workflow, jobs=None):
        with self.assertRaisesRegex(module.DeploymentError, reason):
            self.action(workflow, jobs)

    def failed_run(self, jobs):
        return self.action({"status": "completed", "conclusion": "failure"}, jobs)

    def job(self, **fields):
        return {
            "status": "completed",
            "conclusion": "failure",
            "runner_id": 0,
            "steps": [],
            **fields,
        }

    def test_no_workflow_means_local(self):
        self.assertEqual(self.action(None), "local")

    def test_non_object_workflow_is_invalid_metadata(self):
        for workflow in ["x", [], 5, False]:
            with self.subTest(workflow=workflow):
                self.refuses("invalid workflow metadata", workflow)

    def test_unfinished_runs_are_pending_whatever_the_jobs_say(self):
        for status in ["queued", "in_progress", "waiting", "requested", "pending"]:
            with self.subTest(status=status):
                self.assertEqual(
                    self.action({"status": status, "conclusion": "failure"}, "ignored"),
                    "hosted_pending",
                )

    def test_unknown_status_is_refused(self):
        for workflow in [{}, {"status": None}, {"status": "stale"}, {"status": "COMPLETED"}]:
            with self.subTest(workflow=workflow):
                self.refuses("unknown workflow state", workflow)

    def test_completed_success_is_hosted_success(self):
        self.assertEqual(
            self.action({"status": "completed", "conclusion": "success"}), "hosted_success"
        )

    def test_other_conclusions_and_unusable_job_lists_do_not_establish_unavailability(self):
        good = [self.job()]
        for conclusion in [None, "cancelled", "timed_out", "neutral"]:
            with self.subTest(conclusion=conclusion):
                self.refuses(
                    "workflow did not establish runner unavailability",
                    {"status": "completed", "conclusion": conclusion},
                    good,
                )
        for jobs in [None, [], "jobs", {"jobs": good}, 0]:
            with self.subTest(jobs=jobs):
                self.refuses(
                    "workflow did not establish runner unavailability",
                    {"status": "completed", "conclusion": "failure"},
                    jobs,
                )

    def test_malformed_jobs_are_invalid_metadata(self):
        malformed = {
            "not an object": "x",
            "steps not a list": self.job(steps=None),
            "not completed": self.job(status="in_progress"),
            "no status": {"conclusion": "failure", "runner_id": 0, "steps": []},
            "no runner_id key": {"status": "completed", "conclusion": "failure", "steps": []},
        }
        for label, job in malformed.items():
            with self.subTest(label):
                self.refuses(
                    "invalid job metadata", {"status": "completed", "conclusion": "failure"}, [job]
                )

    def test_jobs_that_ran_steps_or_hold_a_runner_name_forbid_the_override(self):
        for label, job in {
            "steps ran": self.job(steps=[{"name": "x"}]),
            "named runner": self.job(runner_name="odroid"),
            "steps on a skipped job": self.job(
                conclusion="skipped", runner_id=None, steps=[{"name": "x"}]
            ),
        }.items():
            with self.subTest(label):
                self.refuses(
                    "hosted executable steps ran",
                    {"status": "completed", "conclusion": "failure"},
                    [job],
                )

    def test_empty_or_missing_runner_name_does_not_count_as_a_runner(self):
        for name in [None, ""]:
            self.assertEqual(self.failed_run([self.job(runner_name=name)]), "local")

    def test_only_known_runner_less_shapes_pass(self):
        refused = {
            "skipped on a real runner": self.job(conclusion="skipped", runner_id=5),
            "skipped with false runner": self.job(conclusion="skipped", runner_id=False),
            "failure without runner key value": self.job(runner_id=None),
            "failure on a real runner": self.job(runner_id=3),
            "success": self.job(conclusion="success"),
            "cancelled": self.job(conclusion="cancelled", runner_id=None),
            "failure with string zero": self.job(runner_id="0"),
        }
        for label, job in refused.items():
            with self.subTest(label):
                self.refuses(
                    "job did not establish runner unavailability",
                    {"status": "completed", "conclusion": "failure"},
                    [job],
                )

    def test_skipped_jobs_alone_never_establish_unavailability(self):
        skipped = self.job(conclusion="skipped", runner_id=None)
        for jobs in [[skipped], [skipped, dict(skipped, runner_id=0)]]:
            with self.subTest(jobs=len(jobs)):
                self.refuses(
                    "skipped jobs alone", {"status": "completed", "conclusion": "failure"}, jobs
                )

    def test_a_failed_runner_less_job_among_skipped_ones_means_local(self):
        skipped = self.job(conclusion="skipped", runner_id=None)
        self.assertEqual(self.failed_run([skipped, self.job(), skipped]), "local")

    def test_every_job_is_checked_even_after_the_proof_was_found(self):
        self.refuses(
            "invalid job metadata",
            {"status": "completed", "conclusion": "failure"},
            [self.job(), {"runner_id": 0}],
        )
        self.refuses(
            "hosted executable steps ran",
            {"status": "completed", "conclusion": "failure"},
            [self.job(), self.job(steps=[{"name": "x"}])],
        )


class InspectHostedTests(unittest.TestCase):
    """Fetching the hosted run: retries, identity checks, and the jobs lookup for failed runs."""

    NAME = "test/repo"
    RUNS = ("gh", "run", "list")
    JOBS = ("gh", "api")

    def inspect(self, call, sleeps=None):
        pause = (lambda seconds: sleeps.append(seconds)) if sleeps is not None else (lambda _: None)
        return module.inspect_hosted(Path("/repo"), self.NAME, SHA, call, pause)

    def runs(self, *replies):
        return Scripted().on(self.RUNS, in_order(*replies))

    def jobs_payload(self, jobs, total=None):
        return json.dumps({"jobs": jobs, "total_count": len(jobs) if total is None else total})

    def test_lists_the_latest_ci_run_for_the_commit(self):
        call = self.runs(json.dumps([completed("success")]))
        self.assertEqual(self.inspect(call), "hosted_success")
        args, _kw = call.calls[0]
        self.assertEqual(
            args,
            [
                "gh",
                "run",
                "list",
                "--repo",
                self.NAME,
                "--workflow",
                "CI/CD",
                "--commit",
                SHA,
                "--limit",
                "1",
                "--json",
                "databaseId,headSha,status,conclusion",
            ],
        )
        self.assertEqual(len(call.calls), 1)

    def test_a_run_that_has_not_appeared_is_retried_twice_then_means_local(self):
        sleeps = []
        call = self.runs("[]", "[]", "[]")
        self.assertEqual(self.inspect(call, sleeps), "local")
        self.assertEqual(len(call.calls), 3)
        self.assertEqual(sleeps, [5, 5])

    def test_a_run_appearing_on_a_retry_is_used(self):
        sleeps = []
        call = self.runs("[]", json.dumps([completed("success")]))
        self.assertEqual(self.inspect(call, sleeps), "hosted_success")
        self.assertEqual(len(call.calls), 2)
        self.assertEqual(sleeps, [5])

    def test_a_non_list_collection_is_refused_without_retrying(self):
        sleeps = []
        for payload in ["{}", '"x"', "null", "5"]:
            with (
                self.subTest(payload=payload),
                self.assertRaisesRegex(module.DeploymentError, "invalid workflow collection"),
            ):
                self.inspect(self.runs(payload), sleeps)
        self.assertEqual(sleeps, [])

    def test_undecodable_and_oversized_metadata_are_refused(self):
        with self.assertRaisesRegex(module.DeploymentError, "invalid deployment metadata"):
            self.inspect(self.runs("not json"))
        with self.assertRaisesRegex(module.DeploymentError, "oversized deployment metadata"):
            self.inspect(self.runs("[" + " " * 2_000_001 + "]"))

    def test_a_run_for_another_commit_is_refused(self):
        for workflow in [
            "x",
            {"headSha": "c" * 40, "status": "completed", "conclusion": "success"},
            {"status": "completed"},
        ]:
            with (
                self.subTest(workflow=workflow),
                self.assertRaisesRegex(module.DeploymentError, "workflow SHA mismatch"),
            ):
                self.inspect(self.runs(json.dumps([workflow])))

    def test_only_completed_failures_fetch_jobs(self):
        for workflow, expected in [
            (completed("success"), "hosted_success"),
            ({**completed(None), "status": "in_progress"}, "hosted_pending"),
            ({**completed("failure"), "status": "in_progress"}, "hosted_pending"),
        ]:
            with self.subTest(workflow=workflow):
                call = self.runs(json.dumps([workflow]))
                self.assertEqual(self.inspect(call), expected)
                self.assertEqual(len(call.calls), 1)
        with self.assertRaisesRegex(
            module.DeploymentError, "did not establish runner unavailability"
        ):
            self.inspect(self.runs(json.dumps([completed("cancelled")])))

    def test_failed_run_jobs_are_fetched_by_run_id_and_decide_the_action(self):
        job = {"status": "completed", "conclusion": "failure", "runner_id": 0, "steps": []}
        call = self.runs(json.dumps([completed("failure", databaseId=99)])).on(
            self.JOBS, self.jobs_payload([job])
        )
        self.assertEqual(self.inspect(call), "local")
        self.assertEqual(
            call.calls[1][0], ["gh", "api", "repos/test/repo/actions/runs/99/jobs?per_page=100"]
        )
        ran = dict(job, steps=[{"name": "x"}], runner_id=4)
        call = self.runs(json.dumps([completed("failure")])).on(self.JOBS, self.jobs_payload([ran]))
        with self.assertRaisesRegex(module.DeploymentError, "hosted executable steps ran"):
            self.inspect(call)

    def test_failed_run_needs_a_positive_integer_run_id(self):
        for run_id in [None, 0, -1, True, "7", 1.0]:
            with self.subTest(run_id=run_id):
                call = self.runs(json.dumps([completed("failure", databaseId=run_id)]))
                with self.assertRaisesRegex(
                    module.DeploymentError, "invalid workflow run identifier"
                ):
                    self.inspect(call)
                self.assertEqual(len(call.calls), 1)

    def test_incomplete_job_listings_are_refused(self):
        job = {"status": "completed", "conclusion": "failure", "runner_id": 0, "steps": []}
        cases = {
            "payload is a list": ("[]", "incomplete job metadata"),
            "no total_count": (json.dumps({"jobs": [job]}), "incomplete job metadata"),
            "boolean total_count": (
                json.dumps({"jobs": [job], "total_count": True}),
                "incomplete job metadata",
            ),
            "more than one page": (self.jobs_payload([job], total=101), "incomplete job metadata"),
            "jobs not a list": (
                json.dumps({"jobs": {}, "total_count": 0}),
                "incomplete job collection",
            ),
            "jobs missing": (json.dumps({"total_count": 0}), "incomplete job collection"),
            "jobs shorter than total": (
                self.jobs_payload([job], total=2),
                "incomplete job collection",
            ),
        }
        for label, (payload, reason) in cases.items():
            with self.subTest(label):
                call = self.runs(json.dumps([completed("failure")])).on(self.JOBS, payload)
                with self.assertRaisesRegex(module.DeploymentError, reason):
                    self.inspect(call)

    def test_a_listing_of_exactly_one_hundred_jobs_is_accepted(self):
        job = {"status": "completed", "conclusion": "skipped", "runner_id": None, "steps": []}
        failed = dict(job, conclusion="failure", runner_id=0)
        jobs = [failed] + [job] * 99
        call = self.runs(json.dumps([completed("failure")])).on(self.JOBS, self.jobs_payload(jobs))
        self.assertEqual(self.inspect(call), "local")

    def test_command_failures_propagate(self):
        with self.assertRaisesRegex(module.DeploymentError, "gh command failed"):
            self.inspect(self.runs(module.DeploymentError("gh command failed (1)")))
