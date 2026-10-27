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

// A module keeps the 30-second limit unless TIMEOUT_MS below gives it its own. Release/OCI suites
// do not spend the invitation-transport suite's deadline or share its Python mocks.
// The deploy harness runs the real remote shell against a fake docker for every case,
// which takes over a minute on a loaded machine.
// The stage QA suites run the real root scripts, the PC driver and a fake ssh, docker or qa per case.
// test_stage_qa_gate.py drives the real gate CLI against a fake gh, one process per gate run plus
// one per API call. On 2026-10-27 its 52 cases made 177 gate runs and took 30-35 s, all process
// spawning bar one 1 s deadline case, which is over the 30 s default on a hosted runner. It gets
// its own budget, not the 3 min of the deploy and stage harnesses; raise it only after re-measuring.
const TIMEOUT_MS: Record<string, number> = {
  'test_prebuilt_deploy.py': 180_000,
  'test_odroid_stage_qa.py': 180_000,
  'test_stage_fetch_artifact.py': 180_000,
  'test_stage_qa_gate.py': 120_000,
  'test_stage_qa_pc.py': 180_000,
  'test_stage_smoke.py': 180_000,
};

test('every per-suite timeout names a Python suite that exists', () => {
  expect(Object.keys(TIMEOUT_MS).filter((suite) => !suites.includes(suite))).toEqual([]);
});

for (const suite of suites) {
  const timeout = TIMEOUT_MS[suite] ?? 30_000;
  test(
    `Python regression suite: ${suite}`,
    () => {
      const result = Bun.spawnSync(['python3', '-m', 'unittest', 'discover', '-s', 'test/python', '-p', suite, '-v'], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
      expect(output).toMatch(/Ran [1-9]\d* tests?\b/);
      expect(output).toContain('OK');
      expect(result.exitCode).toBe(0);
    },
    timeout,
  );
}
