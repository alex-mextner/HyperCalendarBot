import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const suites = readdirSync(resolve(root, 'test/python'))
  .filter((file) => /^test_[a-zA-Z0-9_]+\.py$/.test(file))
  .sort();

test('Python regression suite discovery is nonempty', () => {
  expect(suites.length).toBeGreaterThan(0);
});

// Each independent module retains the same 30-second limit. Release/OCI suites
// do not spend the invitation-transport suite's deadline or share its Python mocks.
for (const suite of suites) {
  test(`Python regression suite: ${suite}`, () => {
    const result = Bun.spawnSync(['python3', '-m', 'unittest', 'discover', '-s', 'test/python', '-p', suite, '-v'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(output).toMatch(/Ran [1-9]\d* tests?\b/);
    expect(output).toContain('OK');
    expect(result.exitCode).toBe(0);
  }, 30_000);
}
