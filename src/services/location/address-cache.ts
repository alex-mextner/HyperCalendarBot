// src/services/location/address-cache.ts
import { z } from 'zod';
import { jsonCodec } from '../../utils/json-codec.ts';
import { botLogger } from '../../utils/logger.ts';

const logger = botLogger.child({ module: 'address-cache' });

/**
 * Persistent Redis cache of the places a user confirmed for typed locations (a tap on a picker
 * candidate, or a pin shared for the event).
 * Key pattern: `addr:{userId}:confirmed_mappings` → JSON array of { input, resolvedAddress, … }
 * Key pattern: `addr:{userId}:confirmed_freq` → JSON object { resolvedAddress → { url, count, lastUsed } }
 *
 * The earlier keys `addr:{userId}:mappings` and `addr:{userId}:freq` are never read: until
 * 2026-09-27 the bot also wrote places it had picked on its own (the incident mapped "Sonder
 * Dorchol" in Belgrade to a Dutch hotel), so they are not confirmations.
 */

export interface AddressMapping {
  input: string;
  resolvedAddress: string;
  googleMapsUrl: string;
  latitude: number;
  longitude: number;
  placeId: string | null;
  venueName?: string | null;
  timestamp: number;
}

export interface AddressFrequency {
  resolvedAddress: string;
  googleMapsUrl: string;
  count: number;
  lastUsed: number;
}

interface RedisLike {
  get(key: string): Promise<string | null>;
  /**
   * Write `value` only while `key` still holds `expected` (null: absent), as one atomic step;
   * false when another write changed the key first.
   */
  compareAndSet(key: string, expected: string | null, value: string): Promise<boolean>;
}

/**
 * SET KEYS[1] to ARGV[1] only while it still holds ARGV[2], or is absent when no ARGV[2] is given
 * (GET answers false for an absent key, and a missing ARGV[2] is nil); 1 when written.
 */
const COMPARE_AND_SET_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current ~= (ARGV[2] or false) then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
return 1`;

/** `compareAndSet` on a Redis client: one Lua script, which Redis runs atomically. */
export function redisCompareAndSet(redis: {
  eval(script: string, numkeys: number, ...keysAndArgs: string[]): Promise<unknown>;
}): (key: string, expected: string | null, value: string) => Promise<boolean> {
  return async (key, expected, value) =>
    (await redis.eval(COMPARE_AND_SET_SCRIPT, 1, key, value, ...(expected === null ? [] : [expected]))) === 1;
}

/**
 * Most attempts of one read-modify-write racing other writers of the same key. Of the writers that
 * read the same value exactly one commits, so N concurrent writers all finish within N attempts,
 * far more than one user's taps; the bound only stops a compare-and-set that can never succeed.
 */
const MAX_WRITE_ATTEMPTS = 10;

const MAPPINGS_KEY = (userId: number) => `addr:${userId}:confirmed_mappings`;
const FREQ_KEY = (userId: number) => `addr:${userId}:confirmed_freq`;

const AddressMappingSchema = z.object({
  input: z.string(),
  resolvedAddress: z.string(),
  googleMapsUrl: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  placeId: z.string().nullable(),
  // Optional for backward compat with pre-052 cache entries (will be null after parse).
  venueName: z.string().nullable().optional(),
  timestamp: z.number(),
});

const MappingArraySchema = z.array(AddressMappingSchema);

const FreqEntrySchema = z.object({
  url: z.string(),
  count: z.number(),
  lastUsed: z.number(),
});

const FreqMapSchema = z.record(z.string(), FreqEntrySchema);

export class AddressCache {
  constructor(private redis: RedisLike) {}

  /** Normalize input for fuzzy matching: lowercase, trim, collapse whitespace, strip punctuation */
  private normalize(input: string): string {
    return input
      .toLowerCase()
      .trim()
      .replace(/[.,;:!?()]/g, '')
      .replace(/\s+/g, ' ');
  }

  /** Record an address mapping for a user */
  async recordMapping(
    userId: number,
    input: string,
    mapping: Omit<AddressMapping, 'input' | 'timestamp'>,
  ): Promise<void> {
    try {
      await this.readModifyWrite(MAPPINGS_KEY(userId), (raw) => {
        const mappings = raw ? MappingArraySchema.parse(JSON.parse(raw)) : [];

        const normalized = this.normalize(input);
        const existing = mappings.findIndex((m) => this.normalize(m.input) === normalized);
        const entry: AddressMapping = {
          input,
          resolvedAddress: mapping.resolvedAddress,
          googleMapsUrl: mapping.googleMapsUrl,
          latitude: mapping.latitude,
          longitude: mapping.longitude,
          placeId: mapping.placeId,
          venueName: mapping.venueName ?? null,
          timestamp: Date.now(),
        };

        if (existing >= 0) {
          mappings[existing] = entry;
        } else {
          mappings.push(entry);
        }

        // Keep max 500 mappings per user
        if (mappings.length > 500) {
          mappings.splice(0, mappings.length - 500);
        }

        return JSON.stringify(mappings);
      });

      // Update frequency
      await this.incrementFrequency(userId, mapping.resolvedAddress, mapping.googleMapsUrl);
    } catch (err) {
      logger.warn({ err, userId }, 'Failed to record address mapping');
    }
  }

  /** Increment frequency counter for a resolved address */
  private async incrementFrequency(userId: number, resolvedAddress: string, googleMapsUrl: string): Promise<void> {
    await this.readModifyWrite(FREQ_KEY(userId), (raw) => {
      const freq = raw ? FreqMapSchema.parse(JSON.parse(raw)) : {};

      const entry = freq[resolvedAddress] ?? { url: googleMapsUrl, count: 0, lastUsed: 0 };
      entry.count += 1;
      entry.lastUsed = Date.now();
      entry.url = googleMapsUrl;
      freq[resolvedAddress] = entry;

      return JSON.stringify(freq);
    });
  }

  /**
   * Read `key`, compute its new value with `change` (null: leave it as it is) and write it only if
   * the key was not written since the read; otherwise start over from the newer value. Concurrent
   * callbacks of one user (a keep tap on one event, a candidate tap on another) share the same
   * per-user keys, and a plain GET then SET would let the later write drop the other's change.
   * Throws when the key kept changing for `MAX_WRITE_ATTEMPTS` rounds.
   */
  private async readModifyWrite(key: string, change: (raw: string | null) => string | null): Promise<void> {
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
      const raw = await this.redis.get(key);
      const next = change(raw);
      if (next === null || (await this.redis.compareAndSet(key, raw, next))) return;
    }
    throw new Error(`${key} kept changing during ${MAX_WRITE_ATTEMPTS} attempts to write it`);
  }

  /** Find a cached mapping by fuzzy-matching input text */
  async findMapping(userId: number, input: string): Promise<AddressMapping | null> {
    try {
      const key = MAPPINGS_KEY(userId);
      const raw = await this.redis.get(key);
      if (!raw) return null;

      const parsed = jsonCodec(MappingArraySchema).safeParse(raw);
      if (!parsed.success) {
        logger.warn({ err: parsed.error, userId }, 'Stored address mappings are unreadable');
        return null;
      }
      return this.match(parsed.data, input);
    } catch (err) {
      logger.warn({ err, userId }, 'Failed to find address mapping');
      return null;
    }
  }

  /**
   * Forget the mapping `findMapping` returns for this input after the user rejected it, but only
   * while it is still the `rejected` place (same address, place id and coordinates): a place
   * confirmed for the input since then replaced it and stays.
   */
  async forgetMapping(
    userId: number,
    input: string,
    rejected: Pick<AddressMapping, 'resolvedAddress' | 'placeId' | 'latitude' | 'longitude'>,
  ): Promise<void> {
    await this.readModifyWrite(MAPPINGS_KEY(userId), (raw) => {
      if (!raw) return null;

      const parsed = jsonCodec(MappingArraySchema).safeParse(raw);
      if (!parsed.success) {
        logger.warn({ err: parsed.error, userId }, 'Stored address mappings are unreadable; nothing forgotten');
        return null;
      }
      const current = this.match(parsed.data, input);
      if (
        !current ||
        current.resolvedAddress !== rejected.resolvedAddress ||
        current.placeId !== rejected.placeId ||
        current.latitude !== rejected.latitude ||
        current.longitude !== rejected.longitude
      ) {
        return null;
      }

      return JSON.stringify(parsed.data.filter((m) => m !== current));
    });
  }

  private match(mappings: AddressMapping[], input: string): AddressMapping | null {
    const normalized = this.normalize(input);

    // Exact normalized match
    const exact = mappings.find((m) => this.normalize(m.input) === normalized);
    if (exact) return exact;

    // Substring containment (for typo tolerance at word level)
    const words = normalized.split(' ').filter((w) => w.length > 2);
    if (words.length === 0) return null;

    let bestMatch: AddressMapping | null = null;
    let bestScore = 0;

    for (const m of mappings) {
      const mNorm = this.normalize(m.input);
      let score = 0;
      for (const word of words) {
        if (mNorm.includes(word)) score++;
      }
      const ratio = score / words.length;
      if (ratio > 0.7 && score > bestScore) {
        bestScore = score;
        bestMatch = m;
      }
    }

    return bestMatch;
  }

  /** Get the N most recent mappings for a user */
  async getRecent(userId: number, limit = 30): Promise<AddressMapping[]> {
    try {
      const key = MAPPINGS_KEY(userId);
      const raw = await this.redis.get(key);
      if (!raw) return [];

      const mappings = MappingArraySchema.parse(JSON.parse(raw));
      return mappings.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    } catch (err) {
      logger.warn({ err, userId }, 'Failed to get recent mappings');
      return [];
    }
  }

  /** Get the N most frequently used addresses for a user */
  async getFrequent(userId: number, limit = 30): Promise<AddressFrequency[]> {
    try {
      const key = FREQ_KEY(userId);
      const raw = await this.redis.get(key);
      if (!raw) return [];

      const freq = FreqMapSchema.parse(JSON.parse(raw));
      return Object.entries(freq)
        .map(([address, data]) => ({
          resolvedAddress: address,
          googleMapsUrl: data.url,
          count: data.count,
          lastUsed: data.lastUsed,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
    } catch (err) {
      logger.warn({ err, userId }, 'Failed to get frequent addresses');
      return [];
    }
  }

  /** Get combined address context for system prompt (recent + frequent, deduplicated) */
  async getAddressContext(userId: number): Promise<{ recent: AddressMapping[]; frequent: AddressFrequency[] }> {
    const [recent, frequent] = await Promise.all([this.getRecent(userId, 30), this.getFrequent(userId, 30)]);
    return { recent, frequent };
  }
}
