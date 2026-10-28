"""The PC driver passes the odroid's "stage infrastructure could not run" (exit 4) through (#858).

The wrapper's exit status is the verdict, so exit 4 must reach the workflow as exit 4 with
`status=infra-error`, run no case and still be a different outcome from exit 1 (the PR is wrong).
Codes the driver does not know stay a failure, exactly as before: that is what a driver does when
a newer wrapper adds a code it was not installed with.
"""

import unittest

from test_stage_qa_pc import SHA, DriverCase


class InfraExitCode(DriverCase):
    def test_a_wrapper_that_could_not_run_the_stage_is_infra_error_and_no_case_runs(self):
        self.set_ssh(
            mode="result_only", rc=4, sha=SHA, stderr_lines=["stage-qa-run: docker load failed"]
        )
        rc, out, err = self.run_driver()
        self.assertEqual(rc, 4, err)
        self.assert_result(out, "infra-error")
        self.assertIn("docker load failed", err)
        self.assertFalse(self.smoke_record.exists())

    def test_the_wrapper_exit_1_is_still_a_failure_of_the_pull_request(self):
        self.set_ssh(mode="result_only", rc=1, sha=SHA)
        rc, out, err = self.run_driver()
        self.assertEqual(rc, 1, err)
        self.assert_result(out, "failed")

    def test_codes_the_driver_does_not_know_still_collapse_to_failure(self):
        for wrapper_rc in (5, 6, 64, 69, 70, 77):
            with self.subTest(wrapper_rc=wrapper_rc):
                self.set_ssh(mode="result_only", rc=wrapper_rc, sha=SHA)
                rc, out, err = self.run_driver()
                self.assertEqual(rc, 1, err)
                self.assert_result(out, "failed")
                self.assertIn(f"exit status {wrapper_rc}", err)

    def test_a_case_failure_after_a_healthy_start_is_still_a_failure_not_infra(self):
        self.set_smoke(rc=1, final=f"STAGE_SMOKE_FAILED sha={SHA} bot=@x cases=5 failed=1")
        rc, out, err = self.run_driver()
        self.assertEqual(rc, 1, err)
        self.assertIn("status=failed", out)
        self.assertNotIn("infra-error", out)


if __name__ == "__main__":
    unittest.main()
