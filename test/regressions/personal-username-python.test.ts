import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

test('personal username bridge preserves identity, failure classification and private logs', () => {
  const result = Bun.spawnSync(
    ['python3', '-B', '-m', 'unittest', 'discover', '-s', 'test/python', '-p', 'test_personal_username_resolution.py'],
    { cwd: resolve(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe' },
  );
  const output = new TextDecoder().decode(result.stderr);
  if (result.exitCode !== 0) throw new Error(output);
  expect(output).toMatch(/Ran [1-9]\d* tests/);
  expect(output).toContain('OK');
  expect(new TextDecoder().decode(result.stdout)).toBe('');
});
