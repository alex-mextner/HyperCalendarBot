// src/services/location/area-cache.ts
import { z } from 'zod';
import { jsonCodec } from '../../utils/json-codec.ts';
import { botLogger } from '../../utils/logger.ts';
import type { GeocodedArea, GeocodingService } from './geocoding-service.ts';

const logger = botLogger.child({ module: 'area-cache' });

const KEY_PREFIX = 'geo_area:';
// Cities and countries do not move; the bound only lets Google's own corrections reach us.
const TTL_SECONDS = 30 * 24 * 60 * 60;

/** Every field of `GeocodedArea`, so a cached area equals the located one. */
const AreaCodec = jsonCodec(
  z.object({
    latitude: z.number(),
    longitude: z.number(),
    countryCode: z.string().nullable(),
    bounds: z.object({ south: z.number(), west: z.number(), north: z.number(), east: z.number() }),
  }),
);

interface AreaCacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts: { ex: number }): Promise<unknown>;
}

/**
 * The geocoder with `locateArea` answers cached in Redis for a bounded time. Every location check
 * locates the creator's home city and/or country (1-2 paid Geocoding requests) and the answer
 * depends only on the city and country asked for, so it is shared by every user with the same
 * home area; a changed `users.city`, `country_code` or timezone asks for another area. Only found
 * areas are cached: `locateArea` also answers null when the request fails, and that must not stick.
 * A cache that cannot be read or written falls through to the geocoder.
 */
export function withCachedAreas(geocoder: GeocodingService, redis: AreaCacheStore): GeocodingService {
  return {
    ...geocoder,
    async locateArea(area) {
      // The country code goes to Google as given (`region`), so it keys the entry as given; a city
      // query does not depend on its letter case or surrounding spaces
      const key = `${KEY_PREFIX}${area.countryCode ?? ''}:${(area.city ?? '').trim().toLowerCase()}`;
      const cached = await redis.get(key).catch((err: unknown) => {
        logger.warn({ err, key }, 'Failed to read the cached area');
        return null;
      });
      if (cached) {
        const parsed = AreaCodec.safeParse(cached);
        if (parsed.success) return parsed.data;
        logger.warn({ err: parsed.error, key }, 'Cached area is unreadable; locating it again');
      }

      const located: GeocodedArea | null = await geocoder.locateArea(area);
      if (located) {
        await redis.set(key, JSON.stringify(located), { ex: TTL_SECONDS }).catch((err: unknown) => {
          logger.warn({ err, key }, 'Failed to cache the located area');
        });
      }
      return located;
    },
  };
}
