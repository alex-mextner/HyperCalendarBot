// src/services/timezone/city-resolver.ts
import cityTimezones from 'city-timezones';
import { cmdLogger } from '../../utils/logger.ts';
import { aiStreamRound } from '../ai/streaming.ts';
import { matchCity } from './russian-city-matcher.ts';

const SYSTEM_PROMPT =
  'You are a timezone resolver. Given a city name in any language or format, ' +
  'return the IANA timezone key (e.g. Europe/Belgrade, America/New_York, Asia/Tokyo). ' +
  'Return only the key, nothing else. If you cannot determine it, return UNKNOWN.';

function validateTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function lookupLibrary(input: string): string | null {
  let results = cityTimezones.lookupViaCity(input);
  if (!results.length) results = cityTimezones.findFromCityStateProvince(input);
  if (!results.length) return null;
  results.sort((a, b) => ((b as { pop?: number }).pop ?? 0) - ((a as { pop?: number }).pop ?? 0));
  return (results[0] as { timezone?: string }).timezone ?? null;
}

// Redis cache interface — set externally via initCityResolverCache()
let redisCache: {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
} | null = null;

const REDIS_PREFIX = 'city:tz:';

/** Initialize Redis cache for city resolver. Call once at startup if Redis is available. */
export function initCityResolverCache(redis: {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<unknown>;
}): void {
  redisCache = {
    get: (key) => redis.get(`${REDIS_PREFIX}${key}`),
    set: async (key, value) => {
      await redis.set(`${REDIS_PREFIX}${key}`, value);
    },
  };
}

async function cacheGet(key: string): Promise<string | null> {
  if (!redisCache) return null;
  try {
    return await redisCache.get(key);
  } catch (err) {
    cmdLogger.warn({ err, key }, 'Redis cache get failed');
    return null;
  }
}

async function cacheSet(key: string, value: string): Promise<void> {
  if (!redisCache) return;
  try {
    await redisCache.set(key, value);
  } catch (err) {
    cmdLogger.warn({ err, key }, 'Redis cache set failed');
  }
}

/**
 * Resolve a city name or IANA timezone identifier to a canonical IANA key.
 *
 * @param input - user input (IANA, English, Russian, fuzzy)
 * @param streamImpl - injection point used by tests to stub the AI fallback.
 *                     In production the function uses the shared aiStreamRound
 *                     that fan-outs across the fast provider chain.
 */
export async function resolveCity(
  input: string,
  streamImpl: typeof aiStreamRound = aiStreamRound,
): Promise<string | null> {
  const trimmed = input.trim();
  const startMs = performance.now();

  // 1. Direct IANA input
  if (trimmed.includes('/') && validateTimezone(trimmed)) return trimmed;

  const cacheKey = trimmed.toLowerCase();

  // 2. Redis cache (persistent across restarts)
  const cached = await cacheGet(cacheKey);
  if (cached) {
    cmdLogger.debug(
      { city: trimmed, resolved: cached, source: 'redis', ms: performance.now() - startMs },
      'City resolved',
    );
    return cached;
  }

  // 3. Russian city matcher (stemming + fuzzy match, ~200 cities)
  const matchResult = matchCity(trimmed);
  if (matchResult) {
    await cacheSet(cacheKey, matchResult);
    cmdLogger.debug(
      { city: trimmed, resolved: matchResult, source: 'matcher', ms: performance.now() - startMs },
      'City resolved',
    );
    return matchResult;
  }

  // 4. city-timezones library (English names, ~40k cities)
  const libResult = lookupLibrary(trimmed);
  if (libResult && validateTimezone(libResult)) {
    await cacheSet(cacheKey, libResult);
    cmdLogger.debug(
      { city: trimmed, resolved: libResult, source: 'library', ms: performance.now() - startMs },
      'City resolved',
    );
    return libResult;
  }

  // 5. AI fallback via the fast provider chain (z.ai flash → Gemini flash → HF Llama).
  //    aiStreamRound handles provider selection, retries, and fallback internally.
  cmdLogger.info({ city: trimmed }, 'City resolver: falling back to AI');

  try {
    const result = await streamImpl({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: trimmed },
      ],
      maxTokens: 64,
      fast: true,
    });

    const tz = result.text.trim();
    if (!tz || tz === 'UNKNOWN') return null;

    // Try library with AI result as city name
    const libFallback = lookupLibrary(tz);
    if (libFallback && validateTimezone(libFallback)) {
      await cacheSet(cacheKey, libFallback);
      cmdLogger.info(
        { city: trimmed, resolved: libFallback, source: 'ai', ms: performance.now() - startMs },
        'City resolved',
      );
      return libFallback;
    }

    // Direct IANA from AI
    if (validateTimezone(tz)) {
      await cacheSet(cacheKey, tz);
      cmdLogger.info({ city: trimmed, resolved: tz, source: 'ai', ms: performance.now() - startMs }, 'City resolved');
      return tz;
    }

    cmdLogger.warn({ city: trimmed, aiResult: tz, ms: performance.now() - startMs }, 'AI returned invalid timezone');
  } catch (err) {
    cmdLogger.error({ err, city: trimmed, ms: performance.now() - startMs }, 'AI city resolution failed');
  }

  return null;
}
