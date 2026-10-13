import type { RetryJobStore } from './types.ts';

/** 5 min covers max backoff (30s + 60s + 120s) + buffer. */
const RETRY_JOB_TTL_S = 300;

/**
 * Deletes the key only while it still holds ARGV[1], in one server-side step: a get-then-del
 * pair could wipe a newer job's id written between the two calls.
 */
const DEL_IF_MATCH_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** The part of Bun.RedisClient the store uses. */
export interface RetryRedisClient {
  set(key: string, value: string, ex: 'EX', seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  eval(script: string, numkeys: number, ...keysAndArgs: string[]): Promise<unknown>;
}

const retryKey = (userId: number) => `retry:${userId}`;

/** Redis-backed pointer from a user to their pending BullMQ retry job. */
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
      await client.eval(DEL_IF_MATCH_SCRIPT, 1, retryKey(userId), jobId);
    },
  };
}
