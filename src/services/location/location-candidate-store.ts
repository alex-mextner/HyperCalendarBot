// src/services/location/location-candidate-store.ts
import { z } from 'zod';
import { botLogger } from '../../utils/logger.ts';
import type { GeocodedLocation } from './geocoding-service.ts';

const logger = botLogger.child({ module: 'location-candidate-store' });

const KEY_PREFIX = 'loc_candidates:';
const DEFAULT_TTL_SECONDS = 30 * 60; // 30 minutes

export const GeocodedLocationSchema = z.object({
  formattedAddress: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  placeId: z.string().nullable(),
  googleMapsUrl: z.string(),
  venueName: z.string().nullable().optional(),
});

const CandidatesSchema = z.array(GeocodedLocationSchema);

interface RedisClient {
  set(key: string, value: string, opts?: { ex?: number }): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

export interface LocationCandidateStore {
  set(eventId: number, candidates: GeocodedLocation[]): Promise<void>;
  get(eventId: number): Promise<GeocodedLocation[] | null>;
  del(eventId: number): Promise<void>;
}

export class RedisLocationCandidateStore implements LocationCandidateStore {
  constructor(
    private redis: RedisClient,
    private ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ) {}

  async set(eventId: number, candidates: GeocodedLocation[]): Promise<void> {
    const key = `${KEY_PREFIX}${eventId}`;
    await this.redis.set(key, JSON.stringify(candidates), { ex: this.ttlSeconds });
  }

  async get(eventId: number): Promise<GeocodedLocation[] | null> {
    const key = `${KEY_PREFIX}${eventId}`;
    const raw = await this.redis.get(key);
    if (!raw) return null;

    try {
      const parsed: unknown = JSON.parse(raw);
      return CandidatesSchema.parse(parsed);
    } catch (err) {
      logger.warn({ err, eventId }, 'Failed to parse stored location candidates');
      return null;
    }
  }

  async del(eventId: number): Promise<void> {
    const key = `${KEY_PREFIX}${eventId}`;
    await this.redis.del(key);
  }
}

export class InMemoryLocationCandidateStore implements LocationCandidateStore {
  private store = new Map<number, { candidates: GeocodedLocation[]; expiresAt: number }>();

  constructor(private ttlSeconds: number = DEFAULT_TTL_SECONDS) {}

  async set(eventId: number, candidates: GeocodedLocation[]): Promise<void> {
    this.store.set(eventId, {
      candidates,
      expiresAt: Date.now() + this.ttlSeconds * 1000,
    });
  }

  async get(eventId: number): Promise<GeocodedLocation[] | null> {
    const entry = this.store.get(eventId);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(eventId);
      return null;
    }

    return entry.candidates;
  }

  async del(eventId: number): Promise<void> {
    this.store.delete(eventId);
  }
}
