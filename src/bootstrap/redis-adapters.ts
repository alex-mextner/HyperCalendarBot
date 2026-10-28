// src/bootstrap/redis-adapters.ts
//
// Adapters from Bun.RedisClient to the narrow store interfaces that services declare. The argument
// order and types of each Redis call are part of the contract with the server (EX/NX flags, TTLs
// passed as numbers or strings as each caller always did), so they live here, testable with a fake
// client, instead of inline in the startup sequence.

import { z } from 'zod';
import type { BroadcastRedis } from '../worker/broadcast-queue.ts';

/** SET with an optional TTL: `{ ex }` becomes `EX <seconds>`; without it the key never expires. */
export function setWithOptionalExpiry(
  redis: Pick<Bun.RedisClient, 'set'>,
  key: string,
  value: string,
  opts?: { ex?: number },
): Promise<'OK'> {
  return opts?.ex ? redis.set(key, value, 'EX', opts.ex) : redis.set(key, value);
}

/** HistorySummarizer caches summaries with the TTL given as a string ("EX", "600"). */
export function createSummarizerRedis(redis: Pick<Bun.RedisClient, 'get' | 'set'>) {
  return {
    get: (key: string) => redis.get(key),
    set: (key: string, value: string, exMode?: string, ttl?: string) =>
      exMode && ttl ? redis.set(key, value, exMode, ttl) : redis.set(key, value),
  };
}

/** Lock client of GoogleOAuthService; prevents concurrent token refreshes (SET key value EX seconds NX). */
export function createOAuthRedisLock(redis: Pick<Bun.RedisClient, 'set' | 'get' | 'del'>) {
  return {
    set: (key: string, value: string, mode: 'NX', expMode: 'EX', seconds: number) =>
      redis.set(key, value, expMode, String(seconds), mode),
    get: (key: string) => redis.get(key),
    del: (key: string) => redis.del(key),
  };
}

export interface OAuthStateStore {
  set(key: string, value: string, ttl: number): Promise<void>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
}

/** OAuth `state` parameter store shared by the bot (writes) and the web server (reads). */
export function createOAuthStateStore(redis: Pick<Bun.RedisClient, 'set' | 'get' | 'del'>): OAuthStateStore {
  return {
    set: async (key: string, value: string, ttl: number) => {
      await redis.set(key, value, 'EX', ttl);
    },
    get: async (key: string) => redis.get(key),
    del: async (key: string) => {
      await redis.del(key);
    },
  };
}

/** Batch tracking for broadcasts, through raw commands so SADD/SMEMBERS/INCR need no typed wrapper. */
export function createBroadcastRedis(redis: Pick<Bun.RedisClient, 'set' | 'get' | 'send'>): BroadcastRedis {
  return {
    set: async (key, value, ex) => {
      await redis.set(key, value, 'EX', ex);
    },
    get: (key) => redis.get(key),
    sadd: async (key, member) => {
      await redis.send('SADD', [key, member]);
    },
    smembers: async (key) => {
      const result = await redis.send('SMEMBERS', [key]);
      return z.array(z.string()).parse(result ?? []);
    },
    incr: async (key) => {
      const result = await redis.send('INCR', [key]);
      return z.number().parse(result);
    },
    del: async (...keys) => {
      await redis.send('DEL', keys);
    },
    expire: async (key, seconds) => {
      await redis.send('EXPIRE', [key, String(seconds)]);
    },
  };
}

/** 5 min covers the longest retry backoff (30s + 60s + 120s) plus a buffer. */
export const RETRY_JOB_TTL_S = 300;

/** Pending AI-retry job ids, so a new user message can cancel the retry that is still queued. */
export function createRetryJobStore(redis: Pick<Bun.RedisClient, 'set' | 'get' | 'del'>) {
  return {
    async set(userId: number, jobId: string): Promise<void> {
      await redis.set(`retry:${userId}`, jobId, 'EX', RETRY_JOB_TTL_S);
    },
    async get(userId: number): Promise<string | null> {
      return redis.get(`retry:${userId}`);
    },
    async del(userId: number): Promise<void> {
      await redis.del(`retry:${userId}`);
    },
  };
}
