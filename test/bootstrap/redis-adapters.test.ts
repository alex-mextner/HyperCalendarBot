import { describe, expect, test } from 'bun:test';
import {
  createBroadcastRedis,
  createOAuthRedisLock,
  createOAuthStateStore,
  createRetryJobStore,
  createSummarizerRedis,
  RETRY_JOB_TTL_S,
  setWithOptionalExpiry,
} from '../../src/bootstrap/redis-adapters.ts';

type Call = [string, ...unknown[]];

/** What a raw RESP command can answer in these tests: a member list, a counter, a string or nil. */
type RawReply = string[] | number | string | null;

/**
 * A Bun.RedisClient stand-in recording every command it receives. `get` answers `getReply`; raw
 * `send` commands answer `sendReplies[command]`.
 */
function fakeRedis(replies: { get?: string | null; send?: { [command: string]: RawReply } } = {}) {
  const calls: Call[] = [];
  const redis = {
    set: async (...args: unknown[]) => {
      calls.push(['set', ...args]);
      return 'OK' as const;
    },
    get: async (...args: unknown[]) => {
      calls.push(['get', ...args]);
      return replies.get ?? null;
    },
    del: async (...args: unknown[]) => {
      calls.push(['del', ...args]);
      return 1;
    },
    send: async (command: string, args: string[]) => {
      calls.push([command, args]);
      return replies.send?.[command];
    },
  };
  return { calls, redis };
}

describe('setWithOptionalExpiry', () => {
  test('uses EX when a TTL is given', async () => {
    const { calls, redis } = fakeRedis();
    await setWithOptionalExpiry(redis, 'k', 'v', { ex: 30 });
    expect(calls).toEqual([['set', 'k', 'v', 'EX', 30]]);
  });

  test('sets without expiry when no TTL or a zero TTL is given', async () => {
    const { calls, redis } = fakeRedis();
    await setWithOptionalExpiry(redis, 'k', 'v');
    await setWithOptionalExpiry(redis, 'k2', 'v2', { ex: 0 });
    expect(calls).toEqual([
      ['set', 'k', 'v'],
      ['set', 'k2', 'v2'],
    ]);
  });
});

describe('createSummarizerRedis', () => {
  test('passes the string TTL through only when both mode and ttl are present', async () => {
    const { calls, redis } = fakeRedis();
    const store = createSummarizerRedis(redis);
    await store.set('a', '1', 'EX', '600');
    await store.set('b', '2', 'EX');
    await store.set('c', '3');
    await store.get('a');
    expect(calls).toEqual([
      ['set', 'a', '1', 'EX', '600'],
      ['set', 'b', '2'],
      ['set', 'c', '3'],
      ['get', 'a'],
    ]);
  });
});

describe('createOAuthRedisLock', () => {
  test('maps the lock call to SET key value EX <seconds as string> NX', async () => {
    const { calls, redis } = fakeRedis();
    await createOAuthRedisLock(redis).set('lock:u', 'token', 'NX', 'EX', 30);
    expect(calls).toEqual([['set', 'lock:u', 'token', 'EX', '30', 'NX']]);
  });
});

describe('createOAuthStateStore', () => {
  test('writes state with a TTL and resolves to void', async () => {
    const { calls, redis } = fakeRedis({ get: 'v' });
    const store = createOAuthStateStore(redis);
    expect(await store.set('s', 'u', 600)).toBeUndefined();
    expect(await store.get('s')).toBe('v');
    expect(await store.del('s')).toBeUndefined();
    expect(calls).toEqual([
      ['set', 's', 'u', 'EX', 600],
      ['get', 's'],
      ['del', 's'],
    ]);
  });
});

describe('createBroadcastRedis', () => {
  test('issues raw commands with stringified TTLs', async () => {
    const { calls, redis } = fakeRedis({ send: { SMEMBERS: ['a', 'b'], INCR: 3 } });
    const store = createBroadcastRedis(redis);

    await store.set('k', 'v', 60);
    await store.sadd('s', 'm');
    expect(await store.smembers('s')).toEqual(['a', 'b']);
    expect(await store.incr('n')).toBe(3);
    await store.del('x', 'y');
    await store.expire('k', 90);

    expect(calls).toEqual([
      ['set', 'k', 'v', 'EX', 60],
      ['SADD', ['s', 'm']],
      ['SMEMBERS', ['s']],
      ['INCR', ['n']],
      ['DEL', ['x', 'y']],
      ['EXPIRE', ['k', '90']],
    ]);
  });

  test('a missing member set reads as empty, a non-numeric INCR is rejected', async () => {
    const store = createBroadcastRedis(fakeRedis({ send: { SMEMBERS: null, INCR: 'oops' } }).redis);
    expect(await store.smembers('s')).toEqual([]);
    await expect(store.incr('n')).rejects.toThrow();
  });
});

describe('createRetryJobStore', () => {
  test('keys retry jobs per user with the 5 minute TTL', async () => {
    const { calls, redis } = fakeRedis({ get: 'job-1' });
    const store = createRetryJobStore(redis);
    await store.set(12, 'job-1');
    expect(await store.get(12)).toBe('job-1');
    await store.del(12);
    expect(calls).toEqual([
      ['set', 'retry:12', 'job-1', 'EX', RETRY_JOB_TTL_S],
      ['get', 'retry:12'],
      ['del', 'retry:12'],
    ]);
    expect(RETRY_JOB_TTL_S).toBe(300);
  });
});
