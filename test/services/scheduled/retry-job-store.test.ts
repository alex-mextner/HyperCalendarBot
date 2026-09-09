import { describe, expect, test } from 'bun:test';
import type { RetryRedisClient } from '../../../src/services/scheduled/retry-job-store.ts';
import { createRedisRetryJobStore } from '../../../src/services/scheduled/retry-job-store.ts';

/**
 * In-memory stand-in for Bun.RedisClient implementing real GET/SET/DEL/EVAL semantics for
 * the store's compare-and-delete script — the same role BullMQ's mocked Queue/Worker play
 * in test/worker/ai-messages-queue.test.ts. This exercises createRedisRetryJobStore's real
 * call sequencing (key format, args passed to eval) against a faithful compare-and-delete,
 * not a reimplementation of the store's own logic.
 */
function makeFakeRedis(): RetryRedisClient {
  const data = new Map<string, string>();
  return {
    async set(key, value) {
      data.set(key, value);
      return 'OK';
    },
    async get(key) {
      return data.get(key) ?? null;
    },
    async del(key) {
      const existed = data.delete(key);
      return existed ? 1 : 0;
    },
    async send(command, args) {
      if (command !== 'EVAL') throw new Error(`unexpected command ${command}`);
      const [, , key, arg] = args;
      if (data.get(key!) === arg) {
        data.delete(key!);
        return 1;
      }
      return 0;
    },
  };
}

describe('createRedisRetryJobStore', () => {
  test('set then get round-trips the job id', async () => {
    const store = createRedisRetryJobStore(makeFakeRedis());
    await store.set(1, 'job-A');
    expect(await store.get(1)).toBe('job-A');
  });

  test('get returns null for a user with no pending retry', async () => {
    const store = createRedisRetryJobStore(makeFakeRedis());
    expect(await store.get(42)).toBeNull();
  });

  test('del clears the entry unconditionally', async () => {
    const store = createRedisRetryJobStore(makeFakeRedis());
    await store.set(1, 'job-A');
    await store.del(1);
    expect(await store.get(1)).toBeNull();
  });

  test('delIfMatch clears the entry when the id matches (success-path cleanup)', async () => {
    const store = createRedisRetryJobStore(makeFakeRedis());
    await store.set(1, 'job-A');
    await store.delIfMatch(1, 'job-A');
    expect(await store.get(1)).toBeNull();
  });

  test('delIfMatch leaves a newer entry untouched when the id no longer matches (the actual race)', async () => {
    const store = createRedisRetryJobStore(makeFakeRedis());
    // Older job (job-A) was scheduled and its id stored.
    await store.set(1, 'job-A');
    // Before job-A's own success-cleanup runs, a concurrently-processed job for the same
    // user (worker concurrency is 5) already re-enqueued a newer retry and overwrote the
    // store with its own id.
    await store.set(1, 'job-B');
    // job-A's cleanup now runs and must not wipe job-B's entry.
    await store.delIfMatch(1, 'job-A');
    expect(await store.get(1)).toBe('job-B');
  });

  test('delIfMatch is a no-op when there is nothing stored for the user', async () => {
    const store = createRedisRetryJobStore(makeFakeRedis());
    await store.delIfMatch(1, 'job-A');
    expect(await store.get(1)).toBeNull();
  });

  test('set namespaces keys per user so different users never collide', async () => {
    const store = createRedisRetryJobStore(makeFakeRedis());
    await store.set(1, 'job-A');
    await store.set(2, 'job-B');
    await store.delIfMatch(1, 'job-A');
    expect(await store.get(1)).toBeNull();
    expect(await store.get(2)).toBe('job-B');
  });
});
