// src/services/location/pending-geo-store.ts
import { z } from 'zod';
import { botLogger } from '../../utils/logger.ts';

const logger = botLogger.child({ module: 'pending-geo-store' });

const KEY_PREFIX = 'pending_geo:';
const TTL_SECONDS = 30 * 60; // 30 minutes

const SharedLocationSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  // Pins stored before venues were kept have no venue
  venue: z
    .object({ title: z.string(), address: z.string(), googlePlaceId: z.string().nullable() })
    .nullable()
    .default(null),
});

/** A venue the user picked in Telegram's place search: the name and address they chose. */
export interface SharedVenue {
  title: string;
  address: string;
  googlePlaceId: string | null;
}

/** A location the user shared in the chat: a plain pin (`venue` null) or a Telegram venue. */
export interface SharedLocation {
  latitude: number;
  longitude: number;
  venue: SharedVenue | null;
}

export interface PendingGeoStore {
  set(userId: number, data: SharedLocation): Promise<void>;
  get(userId: number): Promise<SharedLocation | null>;
  delete(userId: number): Promise<void>;
}

interface RedisClient {
  set(key: string, value: string, opts?: { ex?: number }): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

export class RedisPendingGeoStore implements PendingGeoStore {
  constructor(private redis: RedisClient) {}

  async set(userId: number, data: SharedLocation): Promise<void> {
    const key = `${KEY_PREFIX}${userId}`;
    await this.redis.set(key, JSON.stringify(data), { ex: TTL_SECONDS });
  }

  async get(userId: number): Promise<SharedLocation | null> {
    const key = `${KEY_PREFIX}${userId}`;
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return SharedLocationSchema.parse(JSON.parse(raw));
    } catch (err) {
      logger.warn({ err, userId }, 'Failed to parse pending geo data');
      return null;
    }
  }

  async delete(userId: number): Promise<void> {
    const key = `${KEY_PREFIX}${userId}`;
    await this.redis.del(key);
  }
}

export class InMemoryPendingGeoStore implements PendingGeoStore {
  private store = new Map<number, { data: SharedLocation; expiresAt: number }>();

  constructor(private ttlSeconds: number = TTL_SECONDS) {}

  async set(userId: number, data: SharedLocation): Promise<void> {
    this.store.set(userId, { data, expiresAt: Date.now() + this.ttlSeconds * 1000 });
  }

  async get(userId: number): Promise<SharedLocation | null> {
    const entry = this.store.get(userId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(userId);
      return null;
    }
    return entry.data;
  }

  async delete(userId: number): Promise<void> {
    this.store.delete(userId);
  }
}
