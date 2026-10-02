"""Cross-language contract regressions: the actual TypeScript server uses numeric IDs."""
import importlib.util
import sys
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('worker_contract',ROOT/'scripts/intent-worker.py')
w=importlib.util.module_from_spec(spec);sys.modules[spec.name]=w;spec.loader.exec_module(w)

class ServerContractTests(unittest.TestCase):
    def claim(self):
        return {'jobId':23,'leaseToken':'synthetic-lease-xxxxxxxxxxxxxxxx','stage':'generate','round':1,
          'model':'claude-opus-5','permissionMode':'auto','deadlineAt':4000000000000,
          'payload':{'samples':[],'activeIntents':[],'instructionsVersion':'1'}}
    def test_numeric_job_id_survives_in_lease_body(self):
        job=w.parse_claim(self.claim());self.assertEqual(job.lease_body()['jobId'],23)
    def test_server_proposal_hash_is_authoritative_not_reserialized_envelope(self):
        data=self.claim();data['stage']='verify';data['payload']['proposal']={'id':8,'hash':'a'*64,'summary':'change','operations':[],'comparisons':[]}
        self.assertEqual(w.proposal_hash(w.parse_claim(data)),'a'*64)
    def test_worker_errors_map_to_the_server_failure_enum(self):
        expected={'model_unavailable':'auth','transient':'server','spawn_failed':'server','truncated':'invalid_output',
                  'refusal':'invalid_output','invalid_artifact':'invalid_output','max_turns':'invalid_output','quota':'quota','network':'network'}
        for value,wire in expected.items():self.assertEqual(w.wire_error_class(value),wire)
    def test_prompt_matches_server_artifact_field_types(self):
        self.assertIn('"sampleId":integer',w.GENERATE_RULES)
        self.assertIn('"findings":[str]',w.VERIFY_RULES)
if __name__=='__main__':unittest.main()
