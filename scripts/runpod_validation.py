#!/usr/bin/env python3
"""Plan bounded validation through the existing runpod-run helper; execution is explicit."""
import hashlib
import json
import os
import socket
import uuid
import time
import fcntl
import shutil
import subprocess
import re
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path


@dataclass(frozen=True)
class Config:
    repo: Path
    artifacts: Path
    ledger: Path
    budget: Decimal = Decimal('1')
    reserve: Decimal = Decimal('0.15')
    approved_untracked: tuple[str, ...] = ()
    diagnostic_workers: int = 1
    helper: str = 'runpod-run'
    prior_upper: Decimal = Decimal('0')
    storage_quote_day: str | None = None


def utc_day() -> str:
    import datetime
    return datetime.datetime.now(datetime.timezone.utc).date().isoformat()


def build_plan(config: Config, compute_hour: Decimal = Decimal('0.16'), spent: Decimal = Decimal('0')) -> dict:
    numbers = (config.budget, config.reserve, compute_hour, spent)
    if any(isinstance(value, bool) or not isinstance(value, Decimal) or not value.is_finite() for value in numbers):
        raise ValueError('Budget and quote must be finite')
    if not (0 < config.budget <= 1 and 0 < config.reserve <= Decimal('0.15')) or spent < 0:
        raise ValueError('Invalid cumulative budget/reservation')
    if not 0 < compute_hour <= Decimal('0.16'):
        raise ValueError('Higher-price hardware is not approved')
    if config.diagnostic_workers not in (1, 2):
        raise ValueError('Only an optional two-worker diagnostic is supported')
    hourly = ((compute_hour + Decimal('40') * Decimal('0.10') / 720) * 100).to_integral_value(rounding='ROUND_CEILING') / 100
    reservation = hourly / 2
    if reservation > config.reserve or spent + reservation > config.budget:
        raise ValueError('Cumulative cost exceeds the approved budget')
    return {
        'mode': 'plan', 'helper': config.helper,
        'resources': {'cpu': 'cpu3g-4', 'vcpus': 4, 'ram_gb': 16, 'disk_gb': 40},
        'hourly_upper': str(hourly), 'reservation': str(reservation),
        'overall_seconds': 1800, 'work_seconds': 1200, 'remote_seconds': 600,
        'runs': ['diagnostic', 'canonical'] if config.diagnostic_workers > 1 else ['canonical'],
        'live_price_checked': False, 'storage_gb_month_assumption': '0.10',
        'storage_confirmation_day': config.storage_quote_day,
    }


def payload_manifest(repo: Path, tracked: list[str], approved: tuple[str, ...], ignored: tuple[str, ...] = ()) -> dict:
    """Only approved source files; never follow links or include private runtime material."""
    result = {}
    for name in sorted(set(tracked) | set(approved)):
        path = Path(name)
        if path.is_absolute() or '..' in path.parts or '\\' in name:
            raise ValueError('Payload path must stay within the checkout')
        if name in ignored:
            if name in approved:
                raise ValueError('Ignored files cannot be explicitly uploaded')
            continue
        if (path.name.startswith('.env') and path.name != '.env.example') or path.suffix in ('.pem', '.key', '.db', '.sqlite'):
            raise ValueError('Private configuration/data cannot be uploaded')
        if (path.parts[0] in ('.git', '.ssh', '.aws', '.runpod', 'logs', 'data', 'backups', 'node_modules', '.venv') or path.parts[0].startswith('evidence')) and not (name == 'data/dictionaries/README.md' and name in tracked):
            raise ValueError('Private/runtime directory cannot be uploaded')
        candidate = repo
        for part in path.parts:
            candidate = candidate / part
            if candidate.is_symlink():
                raise ValueError('Payload cannot follow a symbolic link')
        if not candidate.is_file():
            raise ValueError('Payload contains a missing/nonregular file')
        result[name] = {'sha256': hashlib.sha256(candidate.read_bytes()).hexdigest(), 'executable': bool(candidate.stat().st_mode & 0o111)}
    return result


def parse_receipt(text: str, exit_code: int) -> dict:
    """A diagnostic, skipped suite, partial output or low coverage cannot replace canonical evidence."""
    canonical = text.rsplit('HCB_RUN=canonical\n', 1)
    if len(canonical) != 2:
        return {'ok': False, 'reason': 'Missing canonical run'}
    body = canonical[1]
    summaries = re.findall(r'(\d+) pass\s*\n(?:\s*(\d+) skip\s*\n)?\s*(\d+) fail\s*\n\s*(\d+) expect\(\) calls\s*\nRan (\d+) tests across (\d+) files\.', body)
    coverage = re.findall(r'^All files\s*\|\s*([0-9.]+)\s*\|\s*([0-9.]+)', body, re.M)
    if not summaries or not coverage or 'HCB_RESULT=canonical:0' not in body:
        return {'ok': False, 'reason': 'Incomplete canonical output/coverage'}
    passed, skipped, failed, assertions, tests, files = summaries[-1]
    receipt = {'passed': int(passed), 'skipped': int(skipped or 0), 'failed': int(failed), 'assertions': int(assertions), 'tests': int(tests), 'files': int(files), 'line_coverage': float(coverage[-1][1])}
    receipt['ok'] = (exit_code == 0 and receipt['passed'] == receipt['tests'] > 0 and receipt['skipped'] == receipt['failed'] == 0 and receipt['line_coverage'] >= 80 and '(fail)' not in body and 'Unhandled error between tests' not in body)
    return receipt


def assert_owned(pod: dict, expected_name: str, actor: str) -> None:
    """Same-host pods from another task are never ours."""
    if pod.get('name') != expected_name or pod.get('env', {}).get('RUNPOD_RUN_OWNER') != actor:
        raise ValueError('Foreign pod identity; no cleanup mutation allowed')


def execute_plan(config: Config, provider, runner, approved: bool = False) -> dict:
    """Admission and cleanup are independent of helper success; no automatic retry."""
    if not approved:
        raise ValueError('Execution requires explicit --execute')
    if config.storage_quote_day != utc_day():
        raise ValueError('Current UTC-day confirmation of storage tariff is required')
    for path in (config.artifacts, config.ledger):
        if path.resolve().is_relative_to(config.repo.resolve()) or path.is_symlink():
            raise ValueError('Private artifacts and shared ledger must be outside source')
    config.ledger.parent.mkdir(parents=True, exist_ok=True)
    lock_path = config.ledger.with_suffix('.lock')
    with lock_path.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        ledger = json.loads(config.ledger.read_text()) if config.ledger.exists() else {'budget': str(config.budget), 'attempts': [{'name': 'earlier-authorized-attempts', 'upper': str(money(config.prior_upper)), 'cleanup_verified': True, 'billing_status': 'UNKNOWN'}]}
        if money(ledger['budget']) != config.budget:
            raise ValueError('Existing ledger budget cannot be reset or increased')
        if any(not item.get('cleanup_verified') or item.get('cost_upper_status') == 'UNKNOWN' for item in ledger['attempts']):
            raise ValueError('An earlier attempt has unresolved cleanup')
        spent = sum((money(item['upper']) for item in ledger['attempts']), Decimal('0'))
        plan = build_plan(config, money(provider.quote()), spent)
        actor = re.sub(r'[^a-z0-9]', '-', socket.gethostname().split('.')[0].lower()) or 'host'
        name = f'rr-{actor}-hcb-validation-{uuid.uuid4().hex}'
        if any(pod.get('name') == name for pod in provider.list_pods()):
            return {'ok': False, 'reason': 'Name reuse is forbidden'}
        config.artifacts.mkdir(parents=True, exist_ok=True, mode=0o700)
        directory = config.artifacts / name
        directory.mkdir(mode=0o700)
        payload, manifest = prepare_payload(config, directory / 'payload')
        verify_payload(payload, manifest)
        expected_files = sum(name.endswith(('.test.ts', '.spec.ts', '.test.js', '.spec.js')) for name in manifest)
        if not expected_files:
            return {'ok': False, 'reason': 'Payload has no canonical test inventory'}
        plan.update({'name': name, 'actor': actor, 'payload': str(payload), 'state': str(directory / 'state'), 'log': str(directory / 'helper.log'), 'workers': config.diagnostic_workers})
        started = time.time()
        monotonic_start = time.monotonic()
        provider.deadline = monotonic_start + plan['overall_seconds']
        attempt = {'name': name, 'started': started, 'upper': plan['reservation'], 'cleanup_verified': False}
        ledger['attempts'].append(attempt)
        save_json(config.ledger, ledger)
        owned_id = None
        no_storage = False
        result = {'exit': 1, 'text': ''}
        error = None

        def on_created(pod_id):
            nonlocal owned_id, no_storage
            status, pod = provider.get_pod(pod_id)
            if status != 200:
                raise ValueError('Cannot verify newly created pod')
            assert_owned(pod, name, actor)
            if pod.get('id') != pod_id:
                raise ValueError('Pod ID mismatch')
            owned_id = pod_id
            attempt['pod_id'] = pod_id
            save_json(config.ledger, ledger)
            no_storage = pod.get('mounts') == {}
            cpu = pod.get('cpu', {})
            if not no_storage or cpu.get('id') != 'cpu3g' or cpu.get('vcpuCount') != 4 or cpu.get('memory') != 16 or pod.get('disk') != 40 or money(pod.get('cost')) > Decimal('0.16'):
                raise ValueError('Live resource/price/storage shape differs from approval')
            attempt['shape_verified'] = True

        try:
            verify_payload(payload, manifest)
            result = runner.run(plan, on_created)
        except (Exception, KeyboardInterrupt) as exc:
            error = type(exc).__name__
        finally:
            try:
                # A lost POST response is reconciled only by this unpredictable exact name.
                if owned_id is None:
                    matches = [pod for pod in provider.list_pods() if pod.get('name') == name]
                    if len(matches) == 1:
                        try:
                            on_created(matches[0]['id'])
                        except ValueError as exc:
                            error = error or type(exc).__name__
                            # Identity capture survives resource refusal; cleanup still runs below.
                if owned_id:
                    status, pod = provider.get_pod(owned_id)
                    if status == 200:
                        assert_owned(pod, name, actor)
                        if pod.get('id') != owned_id:
                            raise ValueError('Cleanup ID mismatch')
                        provider.delete_pod(owned_id)
                        status, _ = provider.get_pod(owned_id)
                    attempt['cleanup_verified'] = status == 404 and no_storage
                    records = provider.billing(owned_id, started)
                    attempt['billing_status'] = 'REPORTED' if records else 'UNKNOWN'
                    if records:
                        actual = sum((money(record['amount']) for record in records), Decimal('0'))
                        attempt['reported_cost'] = str(actual)
                        attempt['upper'] = str(max(actual, money(attempt['upper'])))
            except Exception as exc:
                error = error or type(exc).__name__
            attempt['finished'] = time.time()
            elapsed = max(0, time.monotonic() - monotonic_start)
            attempt['upper'] = str(max(money(attempt['upper']), money(plan['hourly_upper']) * Decimal(str(elapsed)) / 3600))
            attempt['cost_upper_status'] = 'ESTIMATED' if attempt.get('shape_verified') and attempt['cleanup_verified'] else 'UNKNOWN'
            if elapsed > plan['overall_seconds']:
                error = error or 'LifecycleDeadlineExceeded'
            save_json(config.ledger, ledger)
        expected_files = sum(name.endswith(('.test.ts', '.spec.ts', '.test.js', '.spec.js')) for name in manifest)
        receipt = parse_receipt(result['text'], result['exit'])
        if receipt.get('files') != expected_files:
            receipt['ok'] = False
            receipt['reason'] = 'Canonical file count does not match immutable payload'
        report = dict(receipt, cleanup_verified=attempt['cleanup_verified'], billing_status=attempt.get('billing_status', 'UNKNOWN'), error=error, cost_upper_status=attempt['cost_upper_status'], reserved_or_elapsed_upper=attempt['upper'])
        report['ok'] = bool(receipt['ok'] and attempt['cleanup_verified'] and not error)
        save_json(directory / 'receipt.json', report)
        return report


def money(value) -> Decimal:
    """No JSON booleans, NaN, infinity or negative currency values."""
    if isinstance(value, bool):
        raise ValueError('Boolean is not currency')
    try:
        parsed = Decimal(str(value))
    except Exception as exc:
        raise ValueError('Invalid currency') from exc
    if not parsed.is_finite() or parsed < 0:
        raise ValueError('Currency must be finite and nonnegative')
    return parsed


def save_json(path: Path, data: dict) -> None:
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def prepare_payload(config: Config, destination: Path) -> tuple[Path, dict]:
    """Freeze explicitly admitted source and fail closed if the secret scanner is absent."""
    def git_files(*args):
        return subprocess.check_output(['git', '-C', str(config.repo), 'ls-files', '-z', *args]).decode().rstrip('\0').split('\0')
    tracked = [name for name in git_files() if name]
    ignored = tuple(name for name in git_files('--others', '--ignored', '--exclude-standard') + git_files('--cached', '--ignored', '--exclude-standard') if name)
    manifest = payload_manifest(config.repo, tracked, config.approved_untracked, ignored)
    destination.mkdir(mode=0o700)
    for name, details in manifest.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((config.repo / name).read_bytes())
        target.chmod(0o755 if details['executable'] else 0o644)
    if payload_manifest(destination, list(manifest), ()) != manifest or payload_manifest(config.repo, tracked, config.approved_untracked, ignored) != manifest:
        raise ValueError('Source changed while freezing payload')
    subprocess.run(['gitleaks', 'dir', '--redact', '--no-banner', str(destination)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
    subprocess.run(['git', 'init', '-q', str(destination)], check=True, timeout=10)
    subprocess.run(['git', '-C', str(destination), 'add', '-A'], check=True, timeout=10)
    save_json(destination.parent / 'manifest.json', manifest)
    frozen = destination.parent / 'frozen'
    shutil.copytree(destination, frozen)
    verify_payload(frozen, manifest)
    for path in sorted(frozen.rglob('*'), key=lambda item: len(item.parts), reverse=True):
        path.chmod(0o555 if path.is_dir() or path.stat().st_mode & 0o111 else 0o444)
    frozen.chmod(0o555)
    # rsync -a preserves modes: its execution copy must permit git/dependency writes.
    destination.chmod(0o755)
    return destination, manifest

def verify_payload(payload: Path, manifest: dict) -> None:
    """Reject content drift and additions before the helper can sync untracked files."""
    names = []
    for path in payload.rglob('*'):
        name = path.relative_to(payload)
        if name.parts[0] == '.git':
            continue
        if path.is_symlink():
            raise ValueError('Snapshot acquired a symlink')
        if path.is_file():
            names.append(str(name))
    if set(names) != set(manifest) or payload_manifest(payload, names, ()) != manifest:
        raise ValueError('Immutable snapshot changed before upload')

COMPOSE_SHA = '40343e21ca777173e69cff5dbafeb37c6f81f3b0d57d9e597f036e95eb63e76a'
COMPOSE_URL = 'https://github.com/docker/compose/releases/download/v5.6.0/docker-compose-linux-x86_64'
APT = 'nodejs,ffmpeg,libasound2t64,libatk-bridge2.0-0t64,libatk1.0-0t64,libatspi2.0-0t64,libcairo2,libcups2t64,libdbus-1-3,libdrm2,libgbm1,libglib2.0-0t64,libnspr4,libnss3,libpango-1.0-0,libx11-6,libxcb1,libxcomposite1,libxdamage1,libxext6,libxfixes3,libxkbcommon0,libxrandr2'
BOOTSTRAP = f'''set -eu
curl --fail --location --max-time 90 {COMPOSE_URL} -o /usr/local/bin/docker-compose
printf '%s  %s\\n' {COMPOSE_SHA} /usr/local/bin/docker-compose | sha256sum --check --status
chmod 755 /usr/local/bin/docker-compose
curl --fail --location --max-time 90 https://bun.com/install -o /tmp/install-bun.sh
BUN_INSTALL=/opt/bun bash /tmp/install-bun.sh bun-v1.4.2
'''


def remote_command(workers: int) -> str:
    """An optional diagnostic always precedes the unchanged canonical gate."""
    setup = '''set -eu
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 2)'
docker-compose version
bun install --frozen-lockfile
bunx playwright install chromium-headless-shell
set +e
'''
    diagnostic = ''
    if workers > 1:
        diagnostic = '''printf 'HCB_RUN=diagnostic\\n'
bun --no-env-file test --parallel=2 --max-concurrency=1 --isolate
printf 'HCB_RESULT=diagnostic:%s\\n' "$?"
'''
    return setup + diagnostic + '''printf 'HCB_RUN=canonical\\n'
bun --no-env-file test
result=$?
printf 'HCB_RESULT=canonical:%s\\n' "$result"
exit "$result"
'''


class Provider:
    """Existing credentials are loaded only after explicit execution, never logged."""
    def __init__(self):
        import tomllib
        self.key = os.environ.get('RUNPOD_API_KEY', '')
        if not self.key:
            with (Path.home() / '.runpod/config.toml').open('rb') as source:
                self.key = tomllib.load(source).get('apikey', '')
        if not self.key:
            raise ValueError('Existing Runpod authentication is required')
        if os.environ.get('RUNPOD_API_URL', 'https://api.runpod.io/v2') != 'https://api.runpod.io/v2':
            raise ValueError('API override is not permitted')
        if any(character in self.key for character in ('\n', '\r', '"', '\\')):
            raise ValueError('Malformed existing authentication')

    def request(self, method: str, path: str):
        """curl total-transfer timeout + subprocess timeout bounds slow trickling bodies."""
        import tempfile
        remaining = getattr(self, 'deadline', float('inf')) - time.monotonic()
        duration = min(20, remaining)
        if duration <= 0:
            raise TimeoutError('Overall lifecycle deadline reached')
        if method not in ('GET', 'DELETE') or not path.startswith('/') or any(character in path for character in ('"', '\\', '\n', '\r')):
            raise ValueError('Invalid provider request')
        config = f'url = "https://api.runpod.io/v2{path}"\nrequest = "{method}"\nheader = "Authorization: Bearer {self.key}"\n'
        # Authentication travels through stdin only, never argv, output or a disk config.
        command = ['curl', '--disable', '--silent', '--show-error', '--config', '-', '--proto', '=https', '--max-redirs', '0', '--max-time', str(duration), '--max-filesize', '2097152', '--write-out', '\n%{http_code}']
        with tempfile.TemporaryFile() as output:
            completed = subprocess.run(command, input=config, text=True, stdout=output, stderr=subprocess.DEVNULL, timeout=duration)
            if completed.returncode:
                raise ValueError('Provider transport failed')
            output.seek(0)
            raw = output.read(2097157)
        if len(raw) > 2097156:
            raise ValueError('Provider response exceeds limit')
        body, status_text = raw.rsplit(b'\n', 1)
        status = int(status_text)
        if status == 404:
            return status, None
        if not 200 <= status < 300:
            raise ValueError(f'Runpod HTTP {status}')
        return status, json.loads(body, parse_float=Decimal) if body else None

    def quote(self):
        _, data = self.request('GET', '/catalog/cpus')
        rows = [row for row in data['cpus'] if row['id'] == 'cpu3g']
        if len(rows) != 1:
            raise ValueError('CPU quote is missing or ambiguous')
        return money(rows[0]['price']['securePerVcpu']) * 4

    def list_pods(self):
        from urllib.parse import quote
        result, cursor = [], ''
        for _ in range(50):
            _, data = self.request('GET', '/pods' + ('?cursor=' + quote(cursor, safe='') if cursor else ''))
            result.extend(data['pods'])
            pagination = data.get('pagination', {})
            if not pagination.get('hasNextPage'):
                return result
            next_cursor = pagination.get('nextCursor')
            if not next_cursor or next_cursor == cursor:
                break
            cursor = next_cursor
        raise ValueError('Cannot prove complete pod inventory')

    def get_pod(self, pod_id):
        if not re.fullmatch(r'[a-zA-Z0-9_-]+', pod_id):
            raise ValueError('Invalid pod ID')
        return self.request('GET', '/pods/' + pod_id)

    def delete_pod(self, pod_id):
        if not re.fullmatch(r'[a-zA-Z0-9_-]+', pod_id):
            raise ValueError('Invalid pod ID')
        status, _ = self.request('DELETE', '/pods/' + pod_id)
        if status not in (200, 204, 404):
            raise ValueError('Cleanup was not accepted')

    def billing(self, pod_id, started):
        import datetime
        from urllib.parse import urlencode
        start = datetime.datetime.fromtimestamp(started, datetime.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        end = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=1)
        end = end.replace(hour=0, minute=0, second=0, microsecond=0)
        query = urlencode({'podId': pod_id, 'bucketSize': 'day', 'startTime': start.isoformat(), 'endTime': end.isoformat()})
        _, data = self.request('GET', '/billing/pods?' + query)
        records = []
        for record in data['records']:
            if record['podId'] != pod_id:
                raise ValueError('Billing record belongs to a different pod')
            amount = money(record['totalAmount'])
            components = sum((money(record[field]) for field in ('cpuAmount', 'gpuAmount', 'diskAmount')), Decimal('0'))
            if abs(amount - components) > Decimal('0.00000001'):
                raise ValueError('Billing components disagree')
            records.append({'amount': str(amount)})
        return records


class HelperRunner:
    """Existing lifecycle helper runs in a fresh state under an overall timeout."""
    def run(self, plan: dict, on_created):
        import selectors
        import signal
        command = ['timeout', '--signal=TERM', '--kill-after=600', '1200', plan['helper'], '--cpu', 'cpu3g-4', '--disk', '40', '--timeout', '600', '--name', plan['name'], '--sync-dir', plan['payload'], '--apt', APT, '--bootstrap', BOOTSTRAP, '--', 'bash', '-c', remote_command(plan['workers'])]
        environment = os.environ.copy()
        environment['RUNPOD_RUN_STATE'] = plan['state']
        state = Path(plan['state'])
        state.mkdir(mode=0o700)
        curl_home = state / 'curl-home'
        curl_home.mkdir(mode=0o700)
        curl_config = curl_home / '.curlrc'
        curl_config.write_text('')
        curl_config.chmod(0o600)
        environment['CURL_HOME'] = str(curl_home)
        deadline, pending = time.monotonic() + 1740, b''
        verified, killed, selector = False, False, None
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=environment, start_new_session=True)
        try:
            selector = selectors.DefaultSelector()
            selector.register(process.stdout, selectors.EVENT_READ)
            with Path(plan['log']).open('wb') as output:
                while selector.get_map():
                    if time.monotonic() >= deadline:
                        raise TimeoutError('Overall lifecycle deadline reached')
                    for key, _ in selector.select(timeout=1):
                        chunk = os.read(key.fileobj.fileno(), 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        output.write(chunk)
                        output.flush()
                        pending += chunk
                        while b'\n' in pending:
                            line, pending = pending.split(b'\n', 1)
                            match = re.search(rb'runpod-run: pod ([a-zA-Z0-9_-]+) created', line)
                            if match:
                                os.killpg(process.pid, signal.SIGSTOP)
                                try:
                                    on_created(match.group(1).decode())
                                except BaseException:
                                    # The shared helper's EXIT trap is unsafe before identity proof.
                                    os.killpg(process.pid, signal.SIGKILL)
                                    killed = True
                                    process.wait(timeout=10)
                                    raise
                                verified = True
                                os.killpg(process.pid, signal.SIGCONT)
                        if len(pending) > 1048576:
                            raise ValueError('Helper emitted an oversized unterminated line')
            code = process.wait(timeout=max(1, deadline - time.monotonic()))
        except BaseException:
            if not killed:
                try:
                    os.killpg(process.pid, signal.SIGTERM if verified else signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=min(600, max(1, deadline - time.monotonic())) if verified else 10)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait(timeout=10)
            raise
        finally:
            if selector is not None:
                selector.close()
            process.stdout.close()
        return {'exit': code, 'text': Path(plan['log']).read_text(errors='replace')}


def main(argv=None) -> int:
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path.cwd())
    parser.add_argument('--artifacts', type=Path, required=True)
    parser.add_argument('--ledger', type=Path, required=True, help='Shared cumulative budget ledger; never reset between attempts')
    parser.add_argument('--budget', type=money, default=Decimal('1'))
    parser.add_argument('--reserve', type=money, default=Decimal('0.15'))
    parser.add_argument('--approve-untracked', action='append', default=[])
    parser.add_argument('--workers', type=int, choices=(1, 2), default=1, help='2 adds a diagnostic before the mandatory unflagged canonical run')
    parser.add_argument('--prior-upper', type=money, help='Required for a new ledger: conservative cumulative cost of earlier authorized attempts, including disks (explicit 0 only when none)')
    parser.add_argument('--confirm-storage-quote-day', help='UTC YYYY-MM-DD attestation: operator checked official ephemeral disk tariff is at most $0.10/GB-month today')
    parser.add_argument('--execute', action='store_true', help='Deliberately authorize one paid helper attempt')
    args = parser.parse_args(argv)
    config = Config(args.repo, args.artifacts, args.ledger, args.budget, args.reserve, tuple(args.approve_untracked), args.workers, prior_upper=args.prior_upper or Decimal('0'), storage_quote_day=args.confirm_storage_quote_day)
    try:
        if not args.execute:
            spent = config.prior_upper
            if config.ledger.exists():
                ledger = json.loads(config.ledger.read_text())
                if money(ledger['budget']) != config.budget:
                    raise ValueError('Existing budget binding differs')
                spent = sum((money(item['upper']) for item in ledger['attempts']), Decimal('0'))
            print(json.dumps(build_plan(config, spent=spent), indent=2))
            return 0
        if not config.ledger.exists() and args.prior_upper is None:
            raise ValueError('New execution ledger requires explicit --prior-upper')
        if config.storage_quote_day != utc_day():
            raise ValueError('Current storage tariff confirmation is required before authentication')
        import signal
        def interrupted(signum, frame):
            raise KeyboardInterrupt
        old_handlers = {number: signal.signal(number, interrupted) for number in (signal.SIGTERM, signal.SIGHUP)}
        try:
            report = execute_plan(config, Provider(), HelperRunner(), approved=True)
        finally:
            for number, handler in old_handlers.items():
                signal.signal(number, handler)
        print(json.dumps(report, indent=2))
        return 0 if report['ok'] else 1
    except (Exception, KeyboardInterrupt) as exc:
        print(json.dumps({'ok': False, 'error': type(exc).__name__}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
