import { expect, test } from 'bun:test';
import { runWithDeadline } from '../helpers/run-with-deadline.ts';

test('a hung child is killed at the deadline even when a grandchild holds its pipes open', () => {
  const started = Date.now();
  const run = runWithDeadline(['sh', '-c', 'echo partial-output; (sleep 12) & wait'], '/', 500);
  expect(run.timedOut).toBe(true);
  expect(run.signal).toBe('SIGKILL');
  expect(run.exitCode).toBeNull();
  expect(run.output).toContain('partial-output');
  expect(Date.now() - started).toBeLessThan(4_000);
});

test('a child that finishes in time reports its real exit code and no timeout', () => {
  const run = runWithDeadline(['sh', '-c', 'echo done; exit 3'], '/', 10_000);
  expect(run).toEqual({ output: 'done\n', exitCode: 3, signal: null, timedOut: false });
});
