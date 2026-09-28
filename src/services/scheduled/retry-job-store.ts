// src/services/scheduled/retry-job-store.ts
import type { RetryJobStore } from './types.ts';

/** 5 min covers max backoff (30s + 60s + 120s) + buffer. */
const RETRY_JOB_TTL_S = 300;

/**
 * Compare-and-delete: clears the key only if it still holds `ARGV[1]`. Runs as a single
 * atomic server-side operation (sent via Bun.RedisClient's raw `send('EVAL', ...)` — the
 * ambient bun-types RedisClient class does not yet declare a typed `eval()` method, though
 * the server supports it) — no get-then-del round-trip race window in which a
 * concurrently-processed job for the same user (worker concurrency is 5) could overwrite the
 * key with a newer job's ID between the read and the delete.
 */
const DEL_IF_MATCH_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** Minimal subset of Bun.RedisClient this store depends on — kept narrow so a fake redis stands in for tests. */
export interface RetryRedisClient {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  send(command: string, args: string[]): Promise<unknown>;
}

const retryKey = (userId: number) => `retry:${userId}`;

/** Redis-backed store of pending BullMQ retry job IDs per user for cancellation bookkeeping. */
export function createRedisRetryJobStore(client: RetryRedisClient): RetryJobStore {
  return {
    async set(userId: number, jobId: string): Promise<void> {
      await client.set(retryKey(userId), jobId, 'EX', RETRY_JOB_TTL_S);
    },
    async get(userId: number): Promise<string | null> {
      return client.get(retryKey(userId));
    },
    async del(userId: number): Promise<void> {
      await client.del(retryKey(userId));
    },
    async delIfMatch(userId: number, jobId: string): Promise<void> {
      await client.send('EVAL', [DEL_IF_MATCH_SCRIPT, '1', retryKey(userId), jobId]);
    },
  };
}
