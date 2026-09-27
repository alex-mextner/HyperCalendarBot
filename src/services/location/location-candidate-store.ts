// src/services/location/location-candidate-store.ts
import { z } from 'zod';
import { jsonCodec } from '../../utils/json-codec.ts';
import { botLogger } from '../../utils/logger.ts';
import type { GeocodedLocation } from './geocoding-service.ts';

const logger = botLogger.child({ module: 'location-candidate-store' });

const KEY_PREFIX = 'loc_candidates:';
// Every typed location waits for the creator's tap on the picker, so it stays answerable for weeks.
const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;

export const GeocodedLocationSchema = z.object({
  formattedAddress: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  countryCode: z.string().nullable().optional(),
  placeId: z.string().nullable(),
  googleMapsUrl: z.string(),
  venueName: z.string().nullable().optional(),
});

const PickerSchema = z.object({
  id: z.string(),
  location: z.string(),
  candidates: z.array(GeocodedLocationSchema),
  remembered: z.boolean(),
  placeDropped: z.boolean(),
});

/** The places offered in one picker message; `id` is in its buttons, so a tap on an older picker is recognised. */
export interface LocationPicker {
  id: string;
  /** The typed location the candidates were found for: a tap counts only while the event still has this text. */
  location: string;
  candidates: GeocodedLocation[];
  /** The only candidate is the place the creator confirmed earlier for this text (address cache), not a search result. */
  remembered: boolean;
  /** Opening the picker dropped a resolved place from the event, which delivered invitation cards may still show. */
  placeDropped: boolean;
}

interface RedisClient {
  set(key: string, value: string, opts?: { ex?: number }): Promise<string | null>;
  del(key: string): Promise<number>;
  eval(script: string, numkeys: number, ...keysAndArgs: string[]): Promise<unknown>;
}

/** GET, and DEL only when the stored picker has this id, in one atomic step; returns the picker JSON or nil. */
const TAKE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return false end
local ok, picker = pcall(cjson.decode, raw)
if not ok or type(picker) ~= 'table' or picker.id ~= ARGV[1] then return false end
redis.call('DEL', KEYS[1])
return raw`;

/** The open location picker of each event; a new picker replaces the previous one. */
export interface LocationCandidateStore {
  set(eventId: number, picker: LocationPicker): Promise<void>;
  /**
   * Answer the event's open picker: removes and returns it only when its id is `pickerId`, atomically,
   * so of two concurrent taps only one gets it, and a tap on an older picker never touches the newer one.
   */
  take(eventId: number, pickerId: string): Promise<LocationPicker | null>;
  del(eventId: number): Promise<void>;
}

export class RedisLocationCandidateStore implements LocationCandidateStore {
  constructor(
    private redis: RedisClient,
    private ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ) {}

  async set(eventId: number, picker: LocationPicker): Promise<void> {
    const key = `${KEY_PREFIX}${eventId}`;
    await this.redis.set(key, JSON.stringify(picker), { ex: this.ttlSeconds });
  }

  async take(eventId: number, pickerId: string): Promise<LocationPicker | null> {
    const raw = await this.redis.eval(TAKE_SCRIPT, 1, `${KEY_PREFIX}${eventId}`, pickerId);
    if (typeof raw !== 'string') return null;

    const parsed = jsonCodec(PickerSchema).safeParse(raw);
    if (!parsed.success) {
      logger.warn({ err: parsed.error, eventId }, 'Failed to parse stored location picker');
      return null;
    }
    return parsed.data;
  }

  async del(eventId: number): Promise<void> {
    const key = `${KEY_PREFIX}${eventId}`;
    await this.redis.del(key);
  }
}

export class InMemoryLocationCandidateStore implements LocationCandidateStore {
  private store = new Map<number, { picker: LocationPicker; expiresAt: number }>();

  constructor(private ttlSeconds: number = DEFAULT_TTL_SECONDS) {}

  async set(eventId: number, picker: LocationPicker): Promise<void> {
    this.store.set(eventId, {
      picker,
      expiresAt: Date.now() + this.ttlSeconds * 1000,
    });
  }

  /** The open picker without answering it. */
  async get(eventId: number): Promise<LocationPicker | null> {
    return this.current(eventId);
  }

  async take(eventId: number, pickerId: string): Promise<LocationPicker | null> {
    // Read and delete without an await in between, so concurrent takes cannot both succeed
    const picker = this.current(eventId);
    if (picker?.id !== pickerId) return null;
    this.store.delete(eventId);
    return picker;
  }

  async del(eventId: number): Promise<void> {
    this.store.delete(eventId);
  }

  private current(eventId: number): LocationPicker | null {
    const entry = this.store.get(eventId);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(eventId);
      return null;
    }

    return entry.picker;
  }
}
