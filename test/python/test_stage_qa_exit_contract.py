"""One exit-code table across the stage QA layers (#858): wrapper, PC driver, workflow report, runbook.

Exit 4 = the stage infrastructure could not run (docker load / compose up failed) -> status `error`.
Exit 1 = the pull request is wrong (health after a successful start, the run budget, a case) ->
status `failure`. The layers are installed separately (the workflow comes from main, the driver and
the wrapper are installed by hand), so a drifting table would post a wrong verdict.
"""

import importlib.util
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUN = (ROOT / "scripts/stage-qa-run.sh").read_text()
WORKFLOW = (ROOT / ".github/workflows/stage-qa.yml").read_text()
RUNBOOK = (ROOT / "docs/reference/deploy-runbook.md").read_text()
SPEC = importlib.util.spec_from_file_location("stage_qa_pc", ROOT / "scripts/stage-qa-pc.py")
driver = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(driver)


def result_status_table(script):
    body = re.search(r"result_status\(\) \{\n  case .*?\n  esac\n\}", script, re.DOTALL).group(0)
    return {
        int(code): name
        for code, name in re.findall(r"^\s+(\d+)\) echo ([a-z-]+) ;;$", body, re.MULTILINE)
    }


class ExitCodeTable(unittest.TestCase):
    def test_the_run_script_and_the_driver_name_every_exit_code_the_same_way(self):
        self.assertEqual(result_status_table(RUN), driver.STATUS_BY_CODE)
        self.assertEqual(driver.STATUS_BY_CODE[4], "infra-error")

    def test_a_status_the_driver_does_not_know_is_a_failure(self):
        self.assertEqual(driver.status_for(1), "failed")
        self.assertEqual(driver.status_for(5), "failed")

    def test_the_driver_passes_exit_4_through_and_collapses_unknown_codes_to_failure(self):
        self.assertEqual(driver.wrapper_code(4), 4)
        for unknown in (5, 77, 255):
            self.assertEqual(driver.wrapper_code(unknown), driver.EXIT_FAILED)

    def test_the_workflow_report_posts_error_for_4_and_failure_only_for_1(self):
        self.assertRegex(
            WORKFLOW,
            r'failure:4\) post error "could not run: stage infrastructure failed \(image load or compose up\)',
        )
        self.assertRegex(WORKFLOW, r'failure:1\) post failure "failed run=')
        self.assertEqual(len(re.findall(r"post failure", WORKFLOW)), 2)  # build failed, qa rc 1

    def test_the_runbook_documents_exit_4_and_the_rollout_order(self):
        self.assertIn("4 the stage infrastructure could not run", RUNBOOK)
        self.assertIn("Rollout order", RUNBOOK)


if __name__ == "__main__":
    unittest.main()
