"""Synthetic runner contract tests: no provider, credential, network or paid execution."""
import sys
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import runpod_validation as validation


class ValidationPlanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.config = validation.Config(root / 'repo', root / 'artifacts', root / 'budget.json')

    def test_default_plan_is_bounded_and_never_invokes_helper(self):
        with mock.patch('subprocess.Popen', side_effect=AssertionError('No helper in plan')):
            plan = validation.build_plan(self.config)
        self.assertEqual(plan.get('resources'), {'cpu': 'cpu3g-4', 'vcpus': 4, 'ram_gb': 16, 'disk_gb': 40})
        self.assertEqual(plan['overall_seconds'], 1800)
        self.assertEqual(plan['remote_seconds'], 600)
        self.assertLessEqual(Decimal(plan['reservation']), self.config.reserve)
        self.assertIn('canonical', plan['runs'])

    def test_cumulative_budget_refuses_before_any_execution(self):
        with self.assertRaises(ValueError):
            validation.build_plan(self.config, spent=Decimal('0.99'))


class PayloadAndReceiptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        (self.repo / 'code.py').write_text('print("anonymous")')
        (self.repo / '.env').write_text('PRIVATE=synthetic')
        (self.repo / 'extra.py').write_text('print("explicitly approved")')

    def test_explicit_approval_never_allows_private_env(self):
        with self.assertRaises(ValueError):
            validation.payload_manifest(self.repo, ['code.py'], ('.env',))

    def test_tracked_symlink_cannot_read_outside_payload(self):
        (self.repo / 'link.py').symlink_to(self.repo / 'code.py')
        with self.assertRaises(ValueError):
            validation.payload_manifest(self.repo, ['link.py'], ())

    def test_untracked_file_requires_explicit_approval(self):
        manifest = validation.payload_manifest(self.repo, ['code.py'], ())
        self.assertNotIn('extra.py', manifest)
        self.assertIn('extra.py', validation.payload_manifest(self.repo, ['code.py'], ('extra.py',)))

    def test_zero_exit_with_skips_is_not_canonical_gate(self):
        text = 'HCB_RUN=canonical\nAll files | 91.71 | 93.87 |\n6933 pass\n16 skip\n0 fail\n24735 expect() calls\nRan 6949 tests across 413 files. [145.27s]\n'
        self.assertFalse(validation.parse_receipt(text, 0)['ok'])

    def test_missing_canonical_output_never_means_success(self):
        self.assertFalse(validation.parse_receipt('download completed', 0)['ok'])

    def test_foreign_pod_cannot_pass_ownership_even_same_hostname(self):
        foreign = {'name': 'rr-home-other', 'env': {'RUNPOD_RUN_OWNER': 'home'}, 'id': 'foreign'}
        with self.assertRaises(ValueError):
            validation.assert_owned(foreign, 'rr-home-this', 'home')


FULL = "HCB_RUN=canonical\nAll files | 91.71 | 93.87 |\n2 pass\n0 fail\n4 expect() calls\nRan 2 tests across 1 files. [1.00s]\nHCB_RESULT=canonical:0\n"

class FakeProvider:
    def __init__(self):
        self.alive = True
        self.foreign = False
        self.reused = False
        self.deleted = []
        self.deletion_fails = False
        self.name = 'rr-home-hcb-validation-testtoken'

    def quote(self):
        return Decimal('0.16')

    def list_pods(self):
        return [{'name': self.name}] if self.reused else []

    def get_pod(self, pod_id):
        if not self.alive:
            return 404, None
        return 200, {'id': pod_id, 'name': 'rr-home-foreign' if self.foreign else self.name,
                     'env': {'RUNPOD_RUN_OWNER': 'home'}, 'cost': 0.16,
                     'cpu': {'id': 'cpu3g', 'vcpuCount': 4, 'memory': 16},
                     'disk': 40, 'mounts': {}, 'networkVolumeId': None}

    def delete_pod(self, pod_id):
        self.deleted.append(pod_id)
        if not self.deletion_fails:
            self.alive = False

    def billing(self, pod_id, started):
        return []

class FakeRunner:
    def __init__(self, provider):
        self.provider = provider
        self.calls = 0
        self.interrupt = False

    def run(self, plan, on_created):
        self.calls += 1
        on_created('synthetic-owned')
        if self.interrupt:
            raise KeyboardInterrupt()
        return {'exit': 0, 'text': FULL}

class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.config = validation.Config(root / 'repo', root / 'artifacts', root / 'ledger.json', storage_quote_day=validation.utc_day())
        self.provider = FakeProvider()
        self.runner = FakeRunner(self.provider)
        self.uuid_patch = mock.patch('uuid.uuid4', return_value=mock.Mock(hex='testtoken'))
        self.host_patch = mock.patch('socket.gethostname', return_value='home')
        self.prepare_patch = mock.patch.object(validation, 'prepare_payload', return_value=(root / 'payload', {'test/example.test.ts': {}}))
        self.verify_patch = mock.patch.object(validation, 'verify_payload')
        for patch in (self.uuid_patch, self.host_patch, self.prepare_patch, self.verify_patch):
            patch.start()
            self.addCleanup(patch.stop)

    def test_execute_must_be_explicit_before_helper(self):
        with self.assertRaises(ValueError):
            validation.execute_plan(self.config, self.provider, self.runner)
        self.assertEqual(self.runner.calls, 0)

    def test_reused_name_is_rejected_without_helper(self):
        self.provider.reused = True
        result = validation.execute_plan(self.config, self.provider, self.runner, approved=True)
        self.assertFalse(result['ok'])
        self.assertEqual(self.runner.calls, 0)

    def test_foreign_same_host_identity_is_never_deleted(self):
        self.provider.foreign = True
        result = validation.execute_plan(self.config, self.provider, self.runner, approved=True)
        self.assertFalse(result['ok'])
        self.assertEqual(self.provider.deleted, [])

    def test_helper_exit_zero_is_not_cleanup_evidence(self):
        self.provider.deletion_fails = True
        result = validation.execute_plan(self.config, self.provider, self.runner, approved=True)
        self.assertFalse(result['ok'])
        self.assertFalse(result.get('cleanup_verified', True))

    def test_empty_billing_is_unknown_and_own_pod_removed(self):
        result = validation.execute_plan(self.config, self.provider, self.runner, approved=True)
        self.assertTrue(result['ok'])
        self.assertTrue(result.get('cleanup_verified', False))
        self.assertEqual(result.get('billing_status'), 'UNKNOWN')
        self.assertEqual(self.provider.deleted, ['synthetic-owned'])

    def test_interrupt_always_cleans_only_owned_id(self):
        self.runner.interrupt = True
        try:
            result = validation.execute_plan(self.config, self.provider, self.runner, approved=True)
        except KeyboardInterrupt:
            result = {'ok': False}
        self.assertFalse(result['ok'])
        self.assertEqual(self.provider.deleted, ['synthetic-owned'])
        self.assertTrue(result.get('cleanup_verified', False))


    def test_child_summary_cannot_pass_full_inventory(self):
        self.prepare_patch.stop()
        with mock.patch.object(validation, 'prepare_payload', return_value=(Path(self.tmp.name) / 'payload', {'test/a.test.ts': {}, 'test/b.test.ts': {}})):
            result = validation.execute_plan(self.config, self.provider, self.runner, approved=True)
        self.assertFalse(result['ok'])

    def test_second_attempt_counts_previous_reservation(self):
        from dataclasses import replace
        small = replace(self.config, budget=Decimal('0.10'))
        result = validation.execute_plan(small, self.provider, self.runner, approved=True)
        self.assertTrue(result['ok'])
        with self.assertRaises(ValueError):
            validation.execute_plan(small, self.provider, self.runner, approved=True)
        self.assertEqual(self.runner.calls, 1)

    def test_unresolved_cleanup_blocks_any_next_helper(self):
        self.provider.deletion_fails = True
        validation.execute_plan(self.config, self.provider, self.runner, approved=True)
        with self.assertRaises(ValueError):
            validation.execute_plan(self.config, self.provider, self.runner, approved=True)
        self.assertEqual(self.runner.calls, 1)


    def test_auth_error_is_failed_unknown_not_cleanup_success(self):
        self.provider.get_pod = mock.Mock(side_effect=ValueError('HTTP 403'))
        result = validation.execute_plan(self.config, self.provider, self.runner, approved=True)
        self.assertFalse(result['ok'])
        self.assertFalse(result['cleanup_verified'])
        self.assertEqual(result['billing_status'], 'UNKNOWN')
        self.assertEqual(self.provider.deleted, [])

    def test_ambiguous_creation_never_deletes_a_host_prefix(self):
        self.runner.run = mock.Mock(side_effect=KeyboardInterrupt)
        self.provider.list_pods = mock.Mock(return_value=[{'name': 'rr-home-other-task', 'id': 'foreign'}])
        result = validation.execute_plan(self.config, self.provider, self.runner, approved=True)
        self.assertFalse(result['ok'])
        self.assertFalse(result['cleanup_verified'])
        self.assertEqual(self.provider.deleted, [])

    def test_invalid_actual_price_cleans_verified_owned_pod_and_fails(self):
        original = self.provider.get_pod
        def malformed(pod_id):
            status, pod = original(pod_id)
            if pod:
                pod['cost'] = float('nan')
            return status, pod
        self.provider.get_pod = malformed
        result = validation.execute_plan(self.config, self.provider, self.runner, approved=True)
        self.assertFalse(result['ok'])
        self.assertEqual(self.provider.deleted, ['synthetic-owned'])


    def test_lost_post_with_owned_wrong_shape_still_cleans_owned_compute(self):
        original = self.provider.get_pod
        def wrong_shape(pod_id):
            status, pod = original(pod_id)
            if pod:
                pod['disk'] = 80
            return status, pod
        self.provider.get_pod = wrong_shape
        self.provider.list_pods = mock.Mock(side_effect=[[], [{'name': self.provider.name, 'id': 'synthetic-owned'}]])
        self.runner.run = mock.Mock(side_effect=KeyboardInterrupt)
        result = validation.execute_plan(self.config, self.provider, self.runner, approved=True)
        self.assertFalse(result['ok'])
        self.assertEqual(self.provider.deleted, ['synthetic-owned'])
        self.assertTrue(result['cleanup_verified'])


    def test_real_v2_network_mount_cannot_be_called_storage_absent(self):
        original = self.provider.get_pod
        def mounted(pod_id):
            status, pod = original(pod_id)
            if pod:
                pod['mounts'] = {'network': [{'volumeId': 'foreign-volume', 'path': '/data'}]}
            return status, pod
        self.provider.get_pod = mounted
        result = validation.execute_plan(self.config, self.provider, self.runner, approved=True)
        self.assertFalse(result['ok'])
        self.assertFalse(result['cleanup_verified'])
        self.assertEqual(self.provider.deleted, ['synthetic-owned'])

    def test_unknown_v2_mounts_is_not_storage_absence(self):
        original = self.provider.get_pod
        def unknown(pod_id):
            status, pod = original(pod_id)
            if pod:
                pod.pop('mounts')
            return status, pod
        self.provider.get_pod = unknown
        result = validation.execute_plan(self.config, self.provider, self.runner, approved=True)
        self.assertFalse(result['ok'])
        self.assertFalse(result['cleanup_verified'])

    def test_elapsed_overrun_increases_ledger_upper_and_fails_gate(self):
        with mock.patch('time.time', side_effect=[1000, 900]), mock.patch('time.monotonic', side_effect=[1000, 4600]):
            result = validation.execute_plan(self.config, self.provider, self.runner, approved=True)
        import json
        ledger = json.loads(self.config.ledger.read_text())
        self.assertGreaterEqual(Decimal(ledger['attempts'][-1]['upper']), Decimal('0.17'))
        self.assertFalse(result['ok'])


    def test_stale_storage_quote_refuses_before_helper(self):
        from dataclasses import replace
        config = replace(self.config, storage_quote_day='2000-01-01')
        with self.assertRaises(ValueError):
            validation.execute_plan(config, self.provider, self.runner, approved=True)
        self.assertEqual(self.runner.calls, 0)

class CliAndBackendTests(unittest.TestCase):
    def test_plan_cli_never_loads_credentials_or_provider(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(validation, 'Provider', side_effect=AssertionError('No auth in plan')), mock.patch('builtins.print'):
                self.assertEqual(validation.main(['--artifacts', directory + '/artifacts', '--ledger', directory + '/ledger']), 0)

    def test_currency_rejects_boolean_nan_negative(self):
        for value in (True, False, 'NaN', 'Infinity', '-1', None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validation.money(value)

    def test_canonical_default_and_optional_diagnostic_are_distinct(self):
        command = validation.remote_command(1)
        self.assertNotIn('--parallel', command)
        self.assertNotIn('--isolate', command)
        self.assertIn('bun --no-env-file test\n', command)
        command = validation.remote_command(2)
        self.assertLess(command.index('HCB_RUN=diagnostic'), command.index('HCB_RUN=canonical'))
        self.assertIn('set +e', command)
        self.assertIn('bun --no-env-file test --parallel=2', command)

    def test_missing_scanner_fails_before_payload_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / 'repo'
            repo.mkdir()
            (repo / 'code.py').write_text('anonymous = True')
            config = validation.Config(repo, root / 'artifacts', root / 'ledger')
            with mock.patch('subprocess.check_output', side_effect=[b'code.py\0', b'', b'']), mock.patch('subprocess.run', side_effect=FileNotFoundError('scanner absent')):
                with self.assertRaises(FileNotFoundError):
                    validation.prepare_payload(config, root / 'payload')

    def test_empty_payload_is_not_full_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = validation.Config(root / 'repo', root / 'artifacts', root / 'ledger', storage_quote_day=validation.utc_day())
            provider = FakeProvider()
            with mock.patch('uuid.uuid4', return_value=mock.Mock(hex='testtoken')), mock.patch('socket.gethostname', return_value='home'), mock.patch.object(validation, 'prepare_payload', return_value=(root / 'payload', {})), mock.patch.object(validation, 'verify_payload'):
                result = validation.execute_plan(config, provider, FakeRunner(provider), approved=True)
                self.assertFalse(result['ok'])



    def test_new_execution_ledger_requires_explicit_history_before_auth(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(validation, 'Provider', side_effect=AssertionError('No key read')), mock.patch('builtins.print'):
                self.assertEqual(validation.main(['--execute', '--artifacts', directory + '/artifacts', '--ledger', directory + '/ledger']), 1)

    def test_backend_uses_existing_helper_deadlines_fresh_state_and_exact_callback(self):
        import io
        import selectors
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan = validation.build_plan(validation.Config(root / 'repo', root / 'artifacts', root / 'ledger'))
            plan.update(name='rr-home-hcb-validation-token', actor='home', payload=str(root / 'payload'), state=str(root / 'state'), log=str(root / 'helper.log'), workers=1)
            process = mock.Mock(pid=9999, stdout=mock.Mock(fileno=mock.Mock(return_value=9)), wait=mock.Mock(return_value=0))
            selector = mock.Mock()
            selector.get_map.side_effect = [True, True, False]
            selector.select.return_value = [(mock.Mock(fileobj=process.stdout), selectors.EVENT_READ)]
            callback = mock.Mock()
            with mock.patch('subprocess.Popen', return_value=process) as popen, mock.patch('selectors.DefaultSelector', return_value=selector), mock.patch('os.read', side_effect=[('runpod-run: pod synthetic-owned created\n'+FULL).encode(), b'']), mock.patch('os.killpg') as kill:
                result = validation.HelperRunner().run(plan, callback)
            args = popen.call_args.args[0]
            self.assertEqual(args[:5], ['timeout', '--signal=TERM', '--kill-after=600', '1200', 'runpod-run'])
            self.assertEqual(args[args.index('--timeout')+1], '600')
            self.assertNotIn('--ttl', args)
            self.assertNotIn('--keep', args)
            self.assertNotIn('--root', args)
            self.assertNotIn('--status', args)
            self.assertEqual(popen.call_args.kwargs['env']['RUNPOD_RUN_STATE'], plan['state'])
            curl_home = Path(popen.call_args.kwargs['env']['CURL_HOME'])
            self.assertEqual((curl_home / '.curlrc').read_text(), '')
            self.assertTrue(curl_home.is_relative_to(Path(plan['state'])))
            callback.assert_called_once_with('synthetic-owned')
            self.assertEqual(kill.call_count, 2)
            self.assertEqual(result['exit'], 0)



    def test_added_private_file_is_refused_before_helper_sync(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'code.py').write_text('anonymous = True')
            manifest = validation.payload_manifest(root, ['code.py'], ())
            (root / 'private.txt').write_text('unapproved material')
            with self.assertRaises(ValueError):
                validation.verify_payload(root, manifest)

    def test_backend_provider_timeout_is_bounded_by_remaining_lifecycle(self):
        provider = validation.Provider.__new__(validation.Provider)
        provider.key = 'synthetic-not-a-real-key'
        provider.deadline = 1005
        with mock.patch('time.monotonic', return_value=1000), mock.patch('subprocess.run', side_effect=__import__('subprocess').TimeoutExpired('curl', 5)) as run:
            with self.assertRaises(__import__('subprocess').TimeoutExpired):
                provider.request('GET', '/pods/synthetic')
        self.assertEqual(run.call_args.kwargs['timeout'], 5)
        self.assertNotIn(provider.key, str(run.call_args.args))
        with mock.patch('time.monotonic', return_value=1006), mock.patch('subprocess.run') as run:
            with self.assertRaises(TimeoutError):
                provider.request('GET', '/pods/synthetic')
        run.assert_not_called()

    def test_forced_tracked_ignored_file_never_enters_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / 'repo'
            repo.mkdir()
            (repo / 'code.py').write_text('anonymous = True')
            (repo / 'forced.py').write_text('ignored runtime material')
            config = validation.Config(repo, root / 'artifacts', root / 'ledger')
            def listings(args):
                if '--cached' in args:
                    return b'forced.py\0'
                if '--others' in args:
                    return b''
                return b'code.py\0forced.py\0'
            with mock.patch('subprocess.check_output', side_effect=listings), mock.patch('subprocess.run'):
                payload, manifest = validation.prepare_payload(config, root / 'payload')
            self.assertNotIn('forced.py', manifest)
            for path in payload.rglob('*'):
                path.chmod(0o755 if path.is_dir() else 0o644)
            payload.chmod(0o755)



    def test_transport_http_403_never_becomes_resource_absence(self):
        provider = validation.Provider.__new__(validation.Provider)
        provider.key = 'synthetic-token'
        provider.deadline = 1020
        def response(command, **kwargs):
            kwargs['stdout'].write(b'{}\n403')
            return mock.Mock(returncode=0)
        with mock.patch('time.monotonic', return_value=1000), mock.patch('subprocess.run', side_effect=response) as run:
            with self.assertRaises(ValueError):
                provider.get_pod('synthetic-owned')
        command = run.call_args.args[0]
        self.assertNotIn('--location', command)
        self.assertIn('--max-filesize', command)
        self.assertNotIn(provider.key, ' '.join(command))
        self.assertEqual(command[:2], ['curl', '--disable'])

    def test_transport_explicit_404_is_independent_cleanup_receipt(self):
        provider = validation.Provider.__new__(validation.Provider)
        provider.key = 'synthetic-token'
        def response(command, **kwargs):
            kwargs['stdout'].write(b'{}\n404')
            return mock.Mock(returncode=0)
        with mock.patch('subprocess.run', side_effect=response):
            self.assertEqual(provider.get_pod('synthetic-owned'), (404, None))



    def test_helper_rsync_preserved_execution_modes_allow_runner_git_and_install(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / 'repo'
            repo.mkdir()
            (repo / 'code.py').write_text('anonymous = True')
            config = validation.Config(repo, root / 'artifacts', root / 'ledger')
            with mock.patch('subprocess.check_output', side_effect=[b'code.py\0', b'', b'']), mock.patch('subprocess.run'):
                payload, manifest = validation.prepare_payload(config, root / 'payload')
            try:
                self.assertTrue(payload.stat().st_mode & 0o200)
                self.assertTrue((payload / 'code.py').stat().st_mode & 0o200)
                self.assertFalse((root / 'frozen' / 'code.py').stat().st_mode & 0o200)
                validation.verify_payload(payload, manifest)
            finally:
                for path in root.rglob('*'):
                    if not path.is_symlink():
                        path.chmod(0o755 if path.is_dir() else 0o644)



    def test_unverified_callback_never_resumes_or_runs_helper_exit_trap(self):
        import selectors
        import signal
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan = validation.build_plan(validation.Config(root / 'repo', root / 'artifacts', root / 'ledger'))
            plan.update(name='rr-home-hcb-validation-token', actor='home', payload=str(root / 'payload'), state=str(root / 'state'), log=str(root / 'helper.log'), workers=1)
            process = mock.Mock(pid=9999, stdout=mock.Mock(fileno=mock.Mock(return_value=9)), wait=mock.Mock(return_value=0))
            selector = mock.Mock()
            selector.get_map.return_value = True
            selector.select.return_value = [(mock.Mock(fileobj=process.stdout), selectors.EVENT_READ)]
            callback = mock.Mock(side_effect=ValueError('unverified foreign metadata'))
            with mock.patch('subprocess.Popen', return_value=process), mock.patch('selectors.DefaultSelector', return_value=selector), mock.patch('os.read', return_value=b'runpod-run: pod synthetic-foreign created\n'), mock.patch('os.killpg') as kill:
                with self.assertRaises(ValueError):
                    validation.HelperRunner().run(plan, callback)
            self.assertEqual([call.args[1] for call in kill.call_args_list], [signal.SIGSTOP, signal.SIGKILL])

    def test_interrupt_before_creation_cannot_trigger_unverified_helper_trap(self):
        import signal
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan = validation.build_plan(validation.Config(root / 'repo', root / 'artifacts', root / 'ledger'))
            plan.update(name='rr-home-hcb-validation-token', actor='home', payload=str(root / 'payload'), state=str(root / 'state'), log=str(root / 'helper.log'), workers=1)
            process = mock.Mock(pid=9999, stdout=mock.Mock(fileno=mock.Mock(return_value=9)), wait=mock.Mock(return_value=0))
            selector = mock.Mock()
            selector.get_map.return_value = True
            selector.select.side_effect = KeyboardInterrupt
            with mock.patch('subprocess.Popen', return_value=process), mock.patch('selectors.DefaultSelector', return_value=selector), mock.patch('os.killpg') as kill:
                with self.assertRaises(KeyboardInterrupt):
                    validation.HelperRunner().run(plan, mock.Mock())
            self.assertEqual([call.args[1] for call in kill.call_args_list], [signal.SIGKILL])



    def test_post_spawn_selector_failure_is_inside_unverified_guard(self):
        import signal
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan = validation.build_plan(validation.Config(root / 'repo', root / 'artifacts', root / 'ledger'))
            plan.update(name='rr-home-hcb-validation-token', actor='home', payload=str(root / 'payload'), state=str(root / 'state'), log=str(root / 'helper.log'), workers=1)
            process = mock.Mock(pid=9999, stdout=mock.Mock(fileno=mock.Mock(return_value=9)), wait=mock.Mock(return_value=0))
            with mock.patch('subprocess.Popen', return_value=process), mock.patch('selectors.DefaultSelector', side_effect=ValueError('selector construction failed')), mock.patch('os.killpg') as kill:
                with self.assertRaises(ValueError):
                    validation.HelperRunner().run(plan, mock.Mock())
            self.assertEqual([call.args[1] for call in kill.call_args_list], [signal.SIGKILL])



    def test_public_tracked_dictionary_readme_is_admitted_without_runtime_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'data/dictionaries').mkdir(parents=True)
            (root / 'data/dictionaries/README.md').write_text('# Public dictionary format')
            manifest = validation.payload_manifest(root, ['data/dictionaries/README.md'], ())
            self.assertIn('data/dictionaries/README.md', manifest)
            with self.assertRaises(ValueError):
                validation.payload_manifest(root, [], ('data/dictionaries/README.md',))
            for name in ('data/dictionaries/runtime.json', 'data/private.md', 'data/user.db'):
                target = root / name
                target.write_text('synthetic runtime material')
                with self.subTest(name=name), self.assertRaises(ValueError):
                    validation.payload_manifest(root, [name], ())

    def test_remote_setup_mirrors_documented_ffmpeg_and_chromium_dependencies(self):
        agents = (Path(__file__).resolve().parents[2] / 'AGENTS.md').read_text()
        line = next(line for line in agents.splitlines() if line.startswith('HCB_APT='))
        required = set(line.split('=', 1)[1].split(','))
        self.assertTrue(required.issubset(set(validation.APT.split(','))))
        self.assertIn('nodejs', validation.APT.split(','))


if __name__ == '__main__':
    unittest.main()
