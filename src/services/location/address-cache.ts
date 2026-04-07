// src/services/location/address-cache.ts
import { botLogger } from '../../utils/logger.ts';

const logger = botLogger.child({ module: 'address-cache' });

/**
 * Persistent Redis cache for user address mappings.
 * Key pattern: `addr:{userId}:mappings` → JSON hash { normalizedInput → resolvedAddress }
 * Key pattern: `addr:{userId}:freq` → JSON hash { resolvedAddress → useCount }
 * Key pattern: `addr:{userId}:recent` → JSON array of { input, resolved, timestamp }
 */

export interface AddressMapping {
  input: string;
  resolvedAddress: string;
  googleMapsUrl: string;
  latitude: number;
  longitude: number;
  placeId: string | null;
  timestamp: number;
}

export interface AddressFrequency {
  resolvedAddress: string;
  googleMapsUrl: string;
  count: number;
  lastUsed: number;
}

export interface AddressCacheEntry {
  mappings: AddressMapping[];
  frequent: AddressFrequency[];
}

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}

const MAPPINGS_KEY = (userId: number) => `addr:${userId}:mappings`;
const FREQ_KEY = (userId: number) => `addr:${userId}:freq`;

const MappingArraySchema = {
  parse(raw: string): AddressMapping[] {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr as AddressMapping[];
  },
};

const FreqMapSchema = {
  parse(raw: string): { [resolved: string]: { url: string; count: number; lastUsed: number } } {
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return {};
    return obj as { [resolved: string]: { url: string; count: number; lastUsed: number } };
  },
};

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
      const key = MAPPINGS_KEY(userId);
      const raw = await this.redis.get(key);
      const mappings = raw ? MappingArraySchema.parse(raw) : [];

      const normalized = this.normalize(input);
      const existing = mappings.findIndex((m) => this.normalize(m.input) === normalized);
      const entry: AddressMapping = {
        input,
        resolvedAddress: mapping.resolvedAddress,
        googleMapsUrl: mapping.googleMapsUrl,
        latitude: mapping.latitude,
        longitude: mapping.longitude,
        placeId: mapping.placeId,
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

      await this.redis.set(key, JSON.stringify(mappings));

      // Update frequency
      await this.incrementFrequency(userId, mapping.resolvedAddress, mapping.googleMapsUrl);
    } catch (err) {
      logger.warn({ err, userId }, 'Failed to record address mapping');
    }
  }

  /** Increment frequency counter for a resolved address */
  private async incrementFrequency(userId: number, resolvedAddress: string, googleMapsUrl: string): Promise<void> {
    const key = FREQ_KEY(userId);
    const raw = await this.redis.get(key);
    const freq = raw ? FreqMapSchema.parse(raw) : {};

    const entry = freq[resolvedAddress] ?? { url: googleMapsUrl, count: 0, lastUsed: 0 };
    entry.count += 1;
    entry.lastUsed = Date.now();
    entry.url = googleMapsUrl;
    freq[resolvedAddress] = entry;

    await this.redis.set(key, JSON.stringify(freq));
  }

  /** Find a cached mapping by fuzzy-matching input text */
  async findMapping(userId: number, input: string): Promise<AddressMapping | null> {
    try {
      const key = MAPPINGS_KEY(userId);
      const raw = await this.redis.get(key);
      if (!raw) return null;

      const mappings = MappingArraySchema.parse(raw);
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
    } catch (err) {
      logger.warn({ err, userId }, 'Failed to find address mapping');
      return null;
    }
  }

  /** Get the N most recent mappings for a user */
  async getRecent(userId: number, limit = 30): Promise<AddressMapping[]> {
    try {
      const key = MAPPINGS_KEY(userId);
      const raw = await this.redis.get(key);
      if (!raw) return [];

      const mappings = MappingArraySchema.parse(raw);
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

      const freq = FreqMapSchema.parse(raw);
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
