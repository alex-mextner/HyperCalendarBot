import { expect, test } from 'bun:test';

test('production Python keepalive distinguishes revoked sessions from transient failures', () => {
  const p = Bun.spawnSync(
    ['python3', '-m', 'unittest', 'discover', '-s', 'test/python', '-p', 'test_keepalive_error.py'],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const out = new TextDecoder().decode(p.stderr);
  expect(out).toContain('Ran 7 tests');
  expect(out).toContain('OK');
  expect(p.exitCode).toBe(0);
});
