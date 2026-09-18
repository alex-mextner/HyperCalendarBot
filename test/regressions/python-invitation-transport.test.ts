import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

test('Python invitation transports bind recipient identity and normalize revoked sessions', () => {
  const result = Bun.spawnSync(
    ['python3', '-m', 'unittest', 'discover', '-s', 'test/python', '-p', 'test_*.py', '-v'],
    {
      cwd: resolve(import.meta.dir, '../..'),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
  expect(output).toMatch(/Ran [1-9]\d* tests/);
  expect(output).toContain('OK');
  expect(result.exitCode).toBe(0);
}, 30_000);
