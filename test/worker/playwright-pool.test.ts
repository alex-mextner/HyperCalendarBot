import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

// Real Chromium must not share a process with unrelated clock/spawn test doubles.
// The original six tests are retained byte-for-byte in the explicit fixture.
const fixture = fileURLToPath(new URL('../fixtures/playwright-pool.integration.ts', import.meta.url));
const child = spawnSync(process.execPath, ['--no-env-file', 'test', fixture], {
  cwd: fileURLToPath(new URL('../../', import.meta.url)),
  encoding: 'utf8',
  timeout: 30_000,
  killSignal: 'SIGKILL',
  env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  maxBuffer: 4 * 1024 * 1024,
});
const output = stripVTControlCharacters(`${child.stdout ?? ''}\n${child.stderr ?? ''}`).trim();
// Coupled to the pinned Bun 1.3.11 reporter; incomplete and skipped child suites fail below.
// Browser absence is not permission to certify a release without real rendering checks.
const count = (kind: 'pass' | 'skip' | 'fail') =>
  Number(output.match(new RegExp(`^\\s*(\\d+) ${kind}\\s*$`, 'm'))?.[1] ?? 0);
test('real browser pool: six isolated acceptance scenarios', () => {
  if (child.error || child.status !== 0) {
    throw new Error(
      `Browser child status=${child.status} signal=${child.signal}: ${child.error?.message ?? ''}\n${output}`,
    );
  }
  expect(count('pass')).toBe(6);
  expect(count('fail')).toBe(0);
  expect(count('skip')).toBe(0);
});
