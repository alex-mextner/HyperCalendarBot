import { describe, expect, mock, test } from 'bun:test';
import { waitForAbort, withinProviderDeadline } from '../../../src/services/ai/provider-deadline.ts';

describe('provider deadline ownership', () => {
  test('stalled headers are aborted without waiting for the producer', async () => {
    let seen: AbortSignal | undefined;
    await expect(
      withinProviderDeadline(async (signal) => {
        seen = signal;
        return new Promise<never>(() => {});
      }, 15),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(seen?.aborted).toBe(true);
  });
  test('already aborted parent never starts a producer', async () => {
    const parent = new AbortController();
    parent.abort();
    const run = mock(async () => 'not started');
    await expect(withinProviderDeadline(run, 100, parent.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(run).not.toHaveBeenCalled();
  });
  test('normal completion disarms the producer signal', async () => {
    let seen: AbortSignal | undefined;
    expect(
      await withinProviderDeadline(async (signal) => {
        seen = signal;
        return 7;
      }, 100),
    ).toBe(7);
    expect(seen?.aborted).toBe(true);
  });
  test('synchronous abort and throw does not lose cancellation ownership', async () => {
    const parent = new AbortController();
    await expect(
      waitForAbort(() => {
        parent.abort(new Error('caller cancelled'));
        throw new Error('producer failed');
      }, parent.signal),
    ).rejects.toThrow();
    expect(parent.signal.aborted).toBe(true);
  });
});
