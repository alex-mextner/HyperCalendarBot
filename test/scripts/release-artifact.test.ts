import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('real archive checks distinguish manifest/config identity and reject invalid artifacts', () => {
  const result = spawnSync(
    'python3',
    ['-B', '-m', 'unittest', 'discover', '-s', 'test/python', '-p', 'test_*release*.py'],
    {
      cwd: resolve(import.meta.dir, '../..'),
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
  expect({ status: result.status, stderr: result.stderr }).toEqual({
    status: 0,
    stderr: expect.stringContaining('OK'),
  });
});

// Runs 14 real deploy-script executions with dozens of process spawns each. Idle this takes ~9 s,
// but spawns get several times slower on a loaded machine: the slowest measured run was 34 s at
// load average 32 on 14 cores (40 s before the fixture speed-up), over the old 30 s limit (#445).
// Each deploy is still capped at 15 s inside the Python test, so a hung deploy fails fast; this
// outer limit only bounds cumulative slowness.
const PREBUILT_DEPLOY_TIMEOUT_MS = 90_000;

test(
  'prebuilt remote deployment verifies identity and preserves writes on rollback',
  () => {
    const result = spawnSync('python3', ['-B', 'test/python/test_prebuilt_deploy.py'], {
      cwd: resolve(import.meta.dir, '../..'),
      encoding: 'utf8',
      timeout: PREBUILT_DEPLOY_TIMEOUT_MS,
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 0,
      stderr: expect.stringContaining('OK'),
    });
  },
  PREBUILT_DEPLOY_TIMEOUT_MS,
);
