import importlib.util
import unittest
from pathlib import Path

PATH = Path(__file__).parents[2] / 'scripts/model-quality/expanded-report.py'
spec = importlib.util.spec_from_file_location('expanded_report', PATH)
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)

class ExpandedSummaryTests(unittest.TestCase):
    def row(self, **changes):
        value = dict(caseId='a', rounds=1, error=None, pass_=True, critical=False, durationMs=100)
        value['pass'] = value.pop('pass_')
        value.update(changes)
        return value

    def test_budget_stop_is_not_a_model_failure(self):
        r = report.summary([self.row(), self.row(rounds=0, error='EXPERIMENT_BUDGET', **{'pass':False})])
        self.assertEqual((r['scorable'], r['attempted'], r['budgetCensored'], r['passedStrict']), (1,1,1,1))

    def test_partial_budget_stop_remains_counted_as_attempt(self):
        r = report.summary([self.row(rounds=2, error='EXPERIMENT_BUDGET', **{'pass':False})])
        self.assertEqual((r['attempted'],r['scorable'],r['budgetCensored']),(1,0,1))

    def test_http_failure_is_not_erased(self):
        r = report.summary([self.row(error='HTTP_429', **{'pass':False})])
        self.assertEqual((r['scorable'],r['httpErrors'],r['passedStrict']),(1,1,0))

    def test_percentile_is_observation_not_interpolated_fiction(self):
        self.assertEqual(report.p([40,10,30,20]),20)
        self.assertEqual(report.p([40,10,30,20],.95),40)
        self.assertIsNone(report.p([]))

if __name__ == '__main__':
    unittest.main()
