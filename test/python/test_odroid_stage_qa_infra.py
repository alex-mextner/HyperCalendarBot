"""Stage infrastructure that could not run is not a failure of the pull request (#858).

An image-load or compose-up failure on the odroid is the stage host's problem: the root scripts exit
4 and print `status=infra-error`, which the PC driver and the workflow report map to `error` ("could
not run"). The PR-caused outcomes keep their meaning: health failing after a successful start, a case
failing and the run budget running out stay exit 1 / `failed`. Same fake docker world as
test_odroid_stage_qa.py; only the docker stub here can fail `load` and `compose up`.
"""

import unittest

from test_odroid_stage_qa import SHA, STAGE_IMAGE, StageWorld, lock_is_free

FAILING_DOCKER = """#!/bin/bash
REC={rec}
case "$1" in
  load)
    if [ -e "$REC/fail-load" ]; then
      cat >/dev/null
      echo 'docker load: no space left on device' >&2
      exit 1
    fi ;;
  compose)
    for arg in "$@"; do
      if [ "$arg" = up ] && [ -e "$REC/fail-up" ]; then
        echo 'docker compose up: port is already allocated' >&2
        exit 1
      fi
    done ;;
esac
exec {real} "$@"
"""


class InfraWorld(StageWorld):
    def setUp(self):
        super().setUp()
        real = self.bin / "docker.real"
        (self.bin / "docker").rename(real)
        self.write_exec(self.bin / "docker", FAILING_DOCKER.format(rec=self.rec, real=real))

    def break_docker(self, step):
        (self.rec / f"fail-{step}").write_text("")


class InfraFailuresAreNotPullRequestFailures(InfraWorld):
    def test_a_failed_image_load_ends_as_infra_error_not_failed(self):
        self.break_docker("load")
        result = self.run_entry()
        self.assertOutcome(result, 4, "infra-error")
        self.assertIn("docker load failed", result.stderr)
        self.assertFalse(self.has_event("compose-up"))
        self.assertFalse(self.has_event("health"))
        self.assertTrue(self.has_event(f"docker-rmi {STAGE_IMAGE}:{SHA}"), self.events())
        self.assertEqual(self.leftover_work_dirs(), [])
        self.assertNoSecrets(result)

    def test_a_failed_compose_up_ends_as_infra_error_with_evidence_and_teardown(self):
        self.break_docker("up")
        result = self.run_entry()
        self.assertOutcome(result, 4, "infra-error")
        self.assertIn("compose up failed", result.stderr)
        self.assertFalse(self.has_event("health"))
        self.assertFalse(self.has_event("guard"))
        self.assertTrue(self.has_event("evidence failed"))
        self.assertTornDown()

    def test_the_stage_and_host_locks_are_released_after_an_infra_error(self):
        self.break_docker("up")
        self.run_entry()
        self.assertTrue(lock_is_free(self.stage_lock))
        self.assertTrue(lock_is_free(self.host_lock))


class PullRequestCausedOutcomesStayFailures(InfraWorld):
    def test_an_unhealthy_stage_after_a_successful_start_is_still_failed(self):
        self.ctl(health_rc=1)
        result = self.run_entry()
        self.assertOutcome(result, 1, "failed")
        self.assertTrue(self.has_event("compose-up"))
        self.assertTrue(self.has_event("health"))

    def test_a_pass_is_still_a_pass_when_nothing_is_broken(self):
        self.assertOutcome(self.run_entry(), 0, "passed")

    def test_refusals_keep_their_own_exit_code(self):
        self.ctl(guard_rc=64)
        self.assertOutcome(self.run_entry(), 2, "refused")


if __name__ == "__main__":
    unittest.main()
