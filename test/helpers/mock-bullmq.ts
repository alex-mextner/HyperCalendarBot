import { mock } from 'bun:test';
import * as bullmq from 'bullmq';

/**
 * Replaces bullmq's `Queue` and `Worker` for the rest of the test process while keeping every
 * other real export. `mock.module` is process-wide in Bun and leaks into later test files, so a
 * factory that returned only `Queue` and `Worker` made `import { DelayedError } from 'bullmq'`
 * (src/services/notification/queue.ts) fail with "Export named 'DelayedError' not found" in
 * whichever file loaded afterwards.
 */
export function mockBullmq(replacements: { Queue: unknown; Worker: unknown }): void {
  mock.module('bullmq', () => ({ ...bullmq, ...replacements }));
}
