"""Refusals, supersede handling and lock ordering of the stage QA root scripts.

Shared fixtures live in odroid_stage_qa_support.py."""

import json
import time
import unittest

from odroid_stage_qa_support import (
    FAKE_TOKEN,
    SHA,
    HeldLock,
    StageWorld,
    lock_is_free,
    wait_for,
)


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


if __name__ == "__main__":
    unittest.main()
