// src/services/location/pending-geo-store.ts
import { z } from 'zod';
import { botLogger } from '../../utils/logger.ts';

const logger = botLogger.child({ module: 'pending-geo-store' });

const KEY_PREFIX = 'pending_geo:';
const TTL_SECONDS = 30 * 60; // 30 minutes

const GeoDataSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
});

export interface PendingGeoStore {
  set(userId: number, data: { latitude: number; longitude: number }): Promise<void>;
  get(userId: number): Promise<{ latitude: number; longitude: number } | null>;
  delete(userId: number): Promise<void>;
}

interface RedisClient {
  set(key: string, value: string, opts?: { ex?: number }): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

export class RedisPendingGeoStore implements PendingGeoStore {
  constructor(private redis: RedisClient) {}

  async set(userId: number, data: { latitude: number; longitude: number }): Promise<void> {
    const key = `${KEY_PREFIX}${userId}`;
    await this.redis.set(key, JSON.stringify(data), { ex: TTL_SECONDS });
  }

  async get(userId: number): Promise<{ latitude: number; longitude: number } | null> {
    const key = `${KEY_PREFIX}${userId}`;
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return GeoDataSchema.parse(JSON.parse(raw));
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
  private store = new Map<number, { latitude: number; longitude: number; expiresAt: number }>();

  async set(userId: number, data: { latitude: number; longitude: number }): Promise<void> {
    this.store.set(userId, { ...data, expiresAt: Date.now() + TTL_SECONDS * 1000 });
  }

  async get(userId: number): Promise<{ latitude: number; longitude: number } | null> {
    const entry = this.store.get(userId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(userId);
      return null;
    }
    return { latitude: entry.latitude, longitude: entry.longitude };
  }

  async delete(userId: number): Promise<void> {
    this.store.delete(userId);
  }
}
