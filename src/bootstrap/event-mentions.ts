// src/bootstrap/event-mentions.ts
//
// Startup phase: the event-mention store and the Redis-backed stores that come with it.
//
// Ordering invariants:
//  - With REDIS_URL this phase also installs the persistent city-resolver cache and sets
//    `webServerDeps.healthCheck` (a Redis ping) on the already-listening web server. Without Redis
//    the store is in-memory and /ready has no Redis dependency to check.
//  - It runs after the speech phase and before createBot(), which takes the store as an input.
//  - Modules are imported lazily (runtime-selected by configuration).

import type { EventMentionStore } from '../services/intent/event-mention-store.ts';
import { botLogger } from '../utils/logger.ts';
import { setWithOptionalExpiry } from './redis-adapters.ts';
import type { StartupContext } from './runtime.ts';

async function createRedisEventMentionStore(ctx: StartupContext, redisUrl: string): Promise<EventMentionStore> {
  const { RedisEventMentionStore } = await import('../services/intent/event-mention-store.ts');
  const bunRedis = new Bun.RedisClient(redisUrl);
  const store = new RedisEventMentionStore({
    set: (key: string, value: string, opts?: { ex?: number }) => setWithOptionalExpiry(bunRedis, key, value, opts),
    get: (key: string) => bunRedis.get(key),
  });
  // City resolver cache — persistent timezone lookups
  const { initCityResolverCache } = await import('../services/timezone/city-resolver.ts');
  initCityResolverCache({ get: (k) => bunRedis.get(k), set: (k, v) => bunRedis.set(k, v) });
  botLogger.info('City resolver cache: Redis');
  ctx.webServerDeps.healthCheck = () => bunRedis.ping().then(() => {});
  botLogger.info('Event mention store: Redis (7-day TTL)');
  return store;
}

export async function initEventMentionStore(ctx: StartupContext): Promise<EventMentionStore> {
  const { config } = ctx;
  if (config.REDIS_URL) return createRedisEventMentionStore(ctx, config.REDIS_URL);

  const { InMemoryEventMentionStore } = await import('../services/intent/event-mention-store.ts');
  botLogger.info('Event mention store: in-memory (no REDIS_URL)');
  return new InMemoryEventMentionStore();
}
