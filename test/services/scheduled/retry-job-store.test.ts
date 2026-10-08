import { describe, expect, test } from 'bun:test';
import { createRedisRetryJobStore, type RetryRedisClient } from '../../../src/services/scheduled/retry-job-store.ts';

/**
 * In-memory Redis: GET/SET/DEL, and EVAL as the server would run the store's
 * compare-and-delete script (KEYS[1] deleted only while it equals ARGV[1]).
 */
function fakeRedis() {
  const data = new Map<string, string>();
  const ttls = new Map<string, number>();
  const client: RetryRedisClient = {
    async set(key, value, _ex, seconds) {
      data.set(key, value);
      ttls.set(key, seconds);
      return 'OK';
    },
    async get(key) {
      return data.get(key) ?? null;
    },
    async del(key) {
      return data.delete(key) ? 1 : 0;
    },
    async eval(script, numkeys, key, arg) {
      if (numkeys !== 1 || !script.includes("redis.call('del', KEYS[1])")) throw new Error('unexpected script');
      if (key === undefined || data.get(key) !== arg) return 0;
      data.delete(key);
      return 1;
    },
  };
  return { client, data, ttls };
}

describe('createRedisRetryJobStore', () => {
  test('stores the pointer per user with a TTL that outlives the longest backoff', async () => {
    const redis = fakeRedis();
    const store = createRedisRetryJobStore(redis.client);
    await store.set(1, 'job-A');
    await store.set(2, 'job-B');
    expect(await store.get(1)).toBe('job-A');
    expect(await store.get(2)).toBe('job-B');
    expect(redis.ttls.get('retry:1')).toBeGreaterThan(30 + 60 + 120);
  });

  test('del clears the pointer whatever it names', async () => {
    const store = createRedisRetryJobStore(fakeRedis().client);
    await store.set(1, 'job-A');
    await store.del(1);
    expect(await store.get(1)).toBeNull();
  });

  test('delIfMatch clears a pointer that still names the job', async () => {
    const store = createRedisRetryJobStore(fakeRedis().client);
    await store.set(1, 'job-A');
    await store.delIfMatch(1, 'job-A');
    expect(await store.get(1)).toBeNull();
  });

  test("delIfMatch keeps a newer retry's pointer and other users' pointers", async () => {
    const store = createRedisRetryJobStore(fakeRedis().client);
    await store.set(1, 'job-B');
    await store.set(2, 'job-A');
    await store.delIfMatch(1, 'job-A');
    expect(await store.get(1)).toBe('job-B');
    expect(await store.get(2)).toBe('job-A');
  });
});
