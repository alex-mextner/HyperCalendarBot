import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

test('personal sender normalizes a revoked connection even if cleanup also fails', () => {
  const result = Bun.spawnSync(
    ['python3', '-m', 'unittest', 'discover', '-s', 'test/python', '-p', 'test_personal_connect_failure.py'],
    { cwd: resolve(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe' },
  );
  const output = new TextDecoder().decode(result.stderr);
  expect(output).toContain('Ran 1 test');
  expect(output).toContain('OK');
  expect(result.exitCode).toBe(0);
});
