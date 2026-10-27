import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { runWithDeadline } from '../helpers/run-with-deadline.ts';

const root = resolve(import.meta.dir, '../..');
const suites = readdirSync(resolve(root, 'test/python'))
  .filter((file) => /^test_[a-zA-Z0-9_]+\.py$/.test(file))
  .sort();

test('Python regression suite discovery is nonempty', () => {
  expect(suites.length).toBeGreaterThan(0);
});

// Each independent module retains the same 30-second limit. Release/OCI suites
// do not spend the invitation-transport suite's deadline or share its Python mocks.
// The deploy harness runs the real remote shell against a fake docker for every case,
// which takes over a minute on a loaded machine.
// The stage QA suites run the real root scripts, the PC driver and a fake ssh, docker or qa per case;
// the gate suite (~50 cases, each a real gate process with a fake gh) runs 24-39 s, so it gets its
// own limit like the others.
const TIMEOUT_MS: Record<string, number> = {
  'test_prebuilt_deploy.py': 180_000,
  'test_odroid_stage_qa.py': 180_000,
  'test_stage_fetch_artifact.py': 180_000,
  'test_stage_qa_gate.py': 180_000,
  'test_stage_qa_pc.py': 180_000,
  'test_stage_smoke.py': 180_000,
};
// The child's deadline sits this far inside the test's own limit, so a hang is reported by the helper.
const CHILD_MARGIN_MS = 5_000;
for (const suite of suites) {
  const timeout = TIMEOUT_MS[suite] ?? 30_000;
  test(
    `Python regression suite: ${suite}`,
    () => {
      const run = runWithDeadline(
        ['python3', '-m', 'unittest', 'discover', '-s', 'test/python', '-p', suite, '-v'],
        root,
        timeout - CHILD_MARGIN_MS,
      );
      expect(run.timedOut).toBe(false);
      expect(run.signal).toBeNull();
      expect(run.output).toMatch(/Ran [1-9]\d* tests?\b/);
      expect(run.output).toMatch(/^OK(?: \(.*\))?$/m);
      expect(run.exitCode).toBe(0);
    },
    timeout,
  );
}
