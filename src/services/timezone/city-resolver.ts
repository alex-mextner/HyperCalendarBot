// src/services/timezone/city-resolver.ts
import Anthropic from '@anthropic-ai/sdk';
import cityTimezones from 'city-timezones';

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

function getSuggestions(tzPrefix: string): string {
  return Intl.supportedValuesOf('timeZone')
    .filter((z) => z.startsWith(`${tzPrefix}/`))
    .slice(0, 15)
    .join(', ');
}

export async function resolveCity(input: string): Promise<string | null> {
  const trimmed = input.trim();

  // 1. Direct IANA input
  if (trimmed.includes('/') && validateTimezone(trimmed)) return trimmed;

  // 2. Library lookup
  const libResult = lookupLibrary(trimmed);
  if (libResult && validateTimezone(libResult)) return libResult;

  // 3. AI with retry loop (max 3 calls)
  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: trimmed }];

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 64,
      system: SYSTEM_PROMPT,
      messages,
    });

    const tz = (response.content[0] as { text: string }).text.trim();

    if (tz === 'UNKNOWN') return null;

    // Try library with AI result as city name
    const libFallback = lookupLibrary(tz);
    if (libFallback && validateTimezone(libFallback)) return libFallback;

    // Direct IANA from AI
    if (validateTimezone(tz)) return tz;

    // Build retry context
    const prefix = tz.split('/')[0] ?? '';
    const suggestions = prefix ? getSuggestions(prefix) : '';
    messages.push({ role: 'assistant', content: tz });
    messages.push({
      role: 'user',
      content: `"${tz}" is not a valid IANA timezone.${suggestions ? ` Valid zones in that region: ${suggestions}.` : ''} Return the correct IANA key for: "${trimmed}"`,
    });
  }

  return null;
}
