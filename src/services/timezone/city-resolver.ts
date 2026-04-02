// src/services/timezone/city-resolver.ts
import type Anthropic from '@anthropic-ai/sdk';
import cityTimezones from 'city-timezones';
import { cmdLogger } from '../../utils/logger.ts';
import { createAnthropicClient } from '../ai/anthropic-client.ts';

const SYSTEM_PROMPT =
  'You are a timezone resolver. Given a city name in any language or format, ' +
  'return the IANA timezone key (e.g. Europe/Belgrade, America/New_York, Asia/Tokyo). ' +
  'Return only the key, nothing else. If you cannot determine it, return UNKNOWN.';

// Common city names and their Russian case forms → IANA timezone
const CITY_ALIASES: { [key: string]: string } = {
  // Moscow
  москва: 'Europe/Moscow',
  москве: 'Europe/Moscow',
  москвы: 'Europe/Moscow',
  москву: 'Europe/Moscow',
  москвой: 'Europe/Moscow',
  мск: 'Europe/Moscow',
  moscow: 'Europe/Moscow',
  // Saint Petersburg
  петербург: 'Europe/Moscow',
  петербурге: 'Europe/Moscow',
  петербурга: 'Europe/Moscow',
  питер: 'Europe/Moscow',
  питере: 'Europe/Moscow',
  спб: 'Europe/Moscow',
  // Kyiv
  киев: 'Europe/Kyiv',
  киеве: 'Europe/Kyiv',
  київ: 'Europe/Kyiv',
  києві: 'Europe/Kyiv',
  // Belgrade
  белград: 'Europe/Belgrade',
  белграде: 'Europe/Belgrade',
  белграда: 'Europe/Belgrade',
  београд: 'Europe/Belgrade',
  београду: 'Europe/Belgrade',
  // New York
  'нью-йорк': 'America/New_York',
  'нью-йорке': 'America/New_York',
  // London
  лондон: 'Europe/London',
  лондоне: 'Europe/London',
  // Paris
  париж: 'Europe/Paris',
  париже: 'Europe/Paris',
  // Berlin
  берлин: 'Europe/Berlin',
  берлине: 'Europe/Berlin',
  // Tokyo
  токио: 'Asia/Tokyo',
  // Istanbul
  стамбул: 'Europe/Istanbul',
  стамбуле: 'Europe/Istanbul',
  // Dubai
  дубай: 'Asia/Dubai',
  дубае: 'Asia/Dubai',
  // Bangkok
  бангкок: 'Asia/Bangkok',
  бангкоке: 'Asia/Bangkok',
  // Miami
  майами: 'America/New_York',
  маями: 'America/New_York',
  miami: 'America/New_York',
  // Los Angeles
  'лос-анджелес': 'America/Los_Angeles',
  'лос-анджелесе': 'America/Los_Angeles',
  // Chicago
  чикаго: 'America/Chicago',
  // Sydney
  сидней: 'Australia/Sydney',
  сиднее: 'Australia/Sydney',
  // Singapore
  сингапур: 'Asia/Singapore',
  сингапуре: 'Asia/Singapore',
  // Hong Kong
  гонконг: 'Asia/Hong_Kong',
  гонконге: 'Asia/Hong_Kong',
  // Mumbai / Delhi
  мумбаи: 'Asia/Kolkata',
  мумбае: 'Asia/Kolkata',
  дели: 'Asia/Kolkata',
  // Beijing / Shanghai
  пекин: 'Asia/Shanghai',
  пекине: 'Asia/Shanghai',
  шанхай: 'Asia/Shanghai',
  шанхае: 'Asia/Shanghai',
  // Tbilisi
  тбилиси: 'Asia/Tbilisi',
  // Yerevan
  ереван: 'Asia/Yerevan',
  ереване: 'Asia/Yerevan',
  // Minsk
  минск: 'Europe/Minsk',
  минске: 'Europe/Minsk',
  // Almaty
  алматы: 'Asia/Almaty',
  // Tashkent
  ташкент: 'Asia/Tashkent',
  ташкенте: 'Asia/Tashkent',
  // Baku
  баку: 'Asia/Baku',
};

// In-memory cache for AI-resolved cities (survives restarts via bot lifetime)
const resolveCache = new Map<string, string>();
const CACHE_MAX_SIZE = 500;

function lookupDictionary(input: string): string | null {
  return CITY_ALIASES[input.toLowerCase()] ?? null;
}

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

function getSuggestions(tzPrefix: string): string {
  return Intl.supportedValuesOf('timeZone')
    .filter((z) => z.startsWith(`${tzPrefix}/`))
    .slice(0, 15)
    .join(', ');
}

function cacheResult(key: string, tz: string): void {
  if (resolveCache.size >= CACHE_MAX_SIZE) {
    const firstKey = resolveCache.keys().next().value;
    if (firstKey !== undefined) resolveCache.delete(firstKey);
  }
  resolveCache.set(key, tz);
}

/** Clear the in-memory resolve cache (for tests). */
export function clearResolveCache(): void {
  resolveCache.clear();
}

export async function resolveCity(input: string, model?: string): Promise<string | null> {
  const trimmed = input.trim();
  const startMs = performance.now();

  // 1. Direct IANA input
  if (trimmed.includes('/') && validateTimezone(trimmed)) return trimmed;

  // 2. Dictionary lookup (Russian case forms, abbreviations)
  const dictResult = lookupDictionary(trimmed);
  if (dictResult) {
    cmdLogger.debug(
      { city: trimmed, resolved: dictResult, source: 'dictionary', ms: performance.now() - startMs },
      'City resolved',
    );
    return dictResult;
  }

  // 3. In-memory cache (previous AI resolutions)
  const cacheKey = trimmed.toLowerCase();
  const cached = resolveCache.get(cacheKey);
  if (cached) {
    cmdLogger.debug(
      { city: trimmed, resolved: cached, source: 'cache', ms: performance.now() - startMs },
      'City resolved',
    );
    return cached;
  }

  // 4. Library lookup
  const libResult = lookupLibrary(trimmed);
  if (libResult && validateTimezone(libResult)) {
    cacheResult(cacheKey, libResult);
    cmdLogger.debug(
      { city: trimmed, resolved: libResult, source: 'library', ms: performance.now() - startMs },
      'City resolved',
    );
    return libResult;
  }

  // 5. AI with retry loop (max 3 calls)
  cmdLogger.info({ city: trimmed }, 'City resolver: falling back to AI');
  const client = createAnthropicClient();
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: trimmed }];

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await client.messages.create({
      model: model ?? 'claude-haiku-4-5-20251001',
      max_tokens: 64,
      system: SYSTEM_PROMPT,
      messages,
    });

    const raw = response.content[0];
    if (!raw || !('text' in raw)) break;
    const tz = raw.text.trim();

    if (tz === 'UNKNOWN') return null;

    // Try library with AI result as city name
    const libFallback = lookupLibrary(tz);
    if (libFallback && validateTimezone(libFallback)) {
      cacheResult(cacheKey, libFallback);
      cmdLogger.info(
        { city: trimmed, resolved: libFallback, source: 'ai', attempt: attempt + 1, ms: performance.now() - startMs },
        'City resolved',
      );
      return libFallback;
    }

    // Direct IANA from AI
    if (validateTimezone(tz)) {
      cacheResult(cacheKey, tz);
      cmdLogger.info(
        { city: trimmed, resolved: tz, source: 'ai', attempt: attempt + 1, ms: performance.now() - startMs },
        'City resolved',
      );
      return tz;
    }

    // Build retry context
    const prefix = tz.split('/')[0] ?? '';
    const suggestions = prefix ? getSuggestions(prefix) : '';
    messages.push({ role: 'assistant', content: tz });
    messages.push({
      role: 'user',
      content: `"${tz}" is not a valid IANA timezone.${suggestions ? ` Valid zones in that region: ${suggestions}.` : ''} Return the correct IANA key for: "${trimmed}"`,
    });
  }

  cmdLogger.warn({ city: trimmed, ms: performance.now() - startMs }, 'City resolver: AI exhausted, returning null');
  return null;
}
