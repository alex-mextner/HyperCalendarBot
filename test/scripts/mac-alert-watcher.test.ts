// test/scripts/mac-alert-watcher.test.ts
//
// The alert watcher hands production incidents to an unattended omp session.
// The command line is the contract: print mode (the Terminal window must exit
// so the lock is released), auto-approve (nobody is there to approve), no saved
// session, the project as cwd, and the prompt after `--` so alert text can never
// be parsed as a flag.
//
// The real script runs with a stubbed `curl` (one queued alert) and `open`
// (runs the generated session script the way Terminal would, then stops the
// watcher loop). The omp binary is a stub that records its argv.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '../../scripts/mac-alert-watcher.sh');
const ALERT_TEXT = 'Bot DOWN: readiness probe failed (synthetic)';

let work: string;
let watcher: Bun.Subprocess | undefined;

function stub(name: string, body: string): void {
  writeFileSync(join(work, 'bin', name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

/** The script under test, pointed at this run's temp files instead of /tmp. */
function stagedScript(): string {
  const source = readFileSync(SCRIPT, 'utf8')
    .replace('LOG_FILE="/tmp/hypercal-alert-watcher.log"', `LOG_FILE="${join(work, 'watcher.log')}"`)
    .replace('LOCK_FILE="/tmp/hypercal-omp-session.lock"', `LOCK_FILE="${join(work, 'session.lock')}"`)
    .replace('COOLDOWN_FILE="/tmp/hypercal-omp-session.done"', `COOLDOWN_FILE="${join(work, 'session.done')}"`)
    .replace('mktemp /tmp/hypercal-XXXXXX', `mktemp "${join(work, 'session.XXXXXX')}"`);
  // PROJECT_DIR is the script's parent directory, so stage it under work/scripts.
  const path = join(work, 'scripts', 'mac-alert-watcher.sh');
  writeFileSync(path, source, { mode: 0o755 });
  return path;
}

beforeEach(() => {
  // The script resolves PROJECT_DIR with `pwd -P`; macOS tmpdir is a symlink into /private.
  work = realpathSync(mkdtempSync(join(tmpdir(), 'hypercal-alert-watcher-')));
  mkdirSync(join(work, 'bin'));
  mkdirSync(join(work, 'scripts'));
  // First poll returns one alert, every later poll an empty queue.
  stub(
    'curl',
    `if [[ ! -f "$WORK/polled" ]]; then
  touch "$WORK/polled"
  printf '%s\\n200' '{"text":"${ALERT_TEXT}","source":"healthcheck"}'
else
  printf '\\n204'
fi`,
  );
  // macOS /bin/sh is bash, which understands the $'…' quoting printf %q emits.
  // Once the session script has finished, stop the watcher loop (open's parent).
  stub('open', 'printf \'%s\\n\' "$@" > "$WORK/open.args"\nbash "$3"\nkill "$PPID"');
  writeFileSync(join(work, 'omp'), '#!/bin/bash\nprintf \'%s\\0\' "$@" > "$WORK/omp.args"\n', { mode: 0o755 });
});

afterEach(async () => {
  // If the script never reaches `open`, nothing else stops its poll loop.
  watcher?.kill();
  await watcher?.exited;
  watcher = undefined;
  rmSync(work, { recursive: true, force: true });
});

test('an alert launches one unattended omp session and releases the lock when it exits', async () => {
  const proc = Bun.spawn(['bash', stagedScript()], {
    env: {
      PATH: `${join(work, 'bin')}:/usr/bin:/bin`,
      HOME: work,
      WORK: work,
      ADMIN_ALERT_TOKEN: 'synthetic-token',
      ALERT_POLL_INTERVAL: '0.1',
      OMP_BIN: join(work, 'omp'),
    },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  watcher = proc;
  await proc.exited;

  expect(readFileSync(join(work, 'open.args'), 'utf8').split('\n').slice(0, 2)).toEqual(['-a', 'Terminal']);
  const argv = readFileSync(join(work, 'omp.args'), 'utf8').split('\0').slice(0, -1);
  expect(argv.slice(0, 6)).toEqual(['-p', '--auto-approve', '--no-session', '--cwd', work, '--']);
  expect(argv).toHaveLength(7);
  const prompt = argv[6] ?? '';
  expect(prompt).toContain(ALERT_TEXT);
  expect(prompt).toContain('bash scripts/send-tg-report.sh');
  // Session finished: lock released, cooldown started.
  expect(existsSync(join(work, 'session.lock'))).toBe(false);
  expect(existsSync(join(work, 'session.done'))).toBe(true);
});
