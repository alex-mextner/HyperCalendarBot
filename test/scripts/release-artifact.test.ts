import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// test_prebuilt_deploy.py and the other Python suites run in test/regressions/python-invitation-transport.test.ts.
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
