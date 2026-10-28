"""Teardown, cancellation and hardening of the stage QA root scripts.

Shared fixtures live in odroid_stage_qa_support.py."""

import signal
import time
import unittest

from odroid_stage_qa_support import (
    SHA,
    STAGE_IMAGE,
    HeldLock,
    StageWorld,
    close_stdin,
    lock_is_free,
    wait_for,
)


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


if __name__ == "__main__":
    unittest.main()
