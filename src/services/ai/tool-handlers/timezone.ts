import cityTimezones from 'city-timezones';
import { resolveCity } from '../../timezone/city-resolver.ts';
import type { ToolResult } from '../types.ts';

function getOffsetMinutes(timezone: string, dt: Date): number {
  try {
    return validateAndGetOffset(timezone, dt).offsetMinutes;
  } catch {
    return 0;
  }
}

export function getTimezoneSuggestions(input: string): string[] {
  const prefix = input.includes('/') ? input.split('/')[0] : null;
  const cities = prefix
    ? cityTimezones.cityMapping.filter((c) => c.timezone?.startsWith(`${prefix}/`))
    : cityTimezones.cityMapping;

  const best = new Map<string, { city: string; pop: number }>();
  for (const c of cities) {
    if (!c.timezone) continue;
    const existing = best.get(c.timezone);
    if (!existing || (c.pop ?? 0) > existing.pop) {
      best.set(c.timezone, { city: c.city, pop: c.pop ?? 0 });
    }
  }

  return [...best.entries()]
    .sort(([, a], [, b]) => b.pop - a.pop)
    .slice(0, 30)
    .map(([tz, { city }]) => `${tz} (${city})`);
}

export function validateAndGetOffset(timezone: string, dt: Date): { offsetStr: string; offsetMinutes: number } {
  // throws if timezone is invalid
  const formatter = new Intl.DateTimeFormat('en', { timeZone: timezone, timeZoneName: 'longOffset' });
  const parts = formatter.formatToParts(dt);
  const raw = (parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+0').replace(/^GMT/, '');
  const match = raw.match(/^([+-])(\d{1,2}):(\d{2})$/);
  const offsetStr = match ? `${match[1]}${match[2]!.padStart(2, '0')}:${match[3]}` : '+00:00';
  const offsetMinutes = match
    ? (match[1] === '+' ? 1 : -1) * (Number.parseInt(match[2]!, 10) * 60 + Number.parseInt(match[3]!, 10))
    : 0;
  return { offsetStr, offsetMinutes };
}

function resolveSingle(
  timezone: string,
  dt: Date,
): { offsetStr: string; offsetMinutes: number; dstActive: boolean; localTime: string } {
  const { offsetStr, offsetMinutes } = validateAndGetOffset(timezone, dt); // throws if invalid
  const year = dt.getUTCFullYear();
  const janOffset = getOffsetMinutes(timezone, new Date(Date.UTC(year, 0, 15)));
  const julOffset = getOffsetMinutes(timezone, new Date(Date.UTC(year, 6, 15)));
  const dstActive = janOffset !== julOffset && offsetMinutes === Math.max(janOffset, julOffset);
  const localMs = dt.getTime() + offsetMinutes * 60_000;
  const local = new Date(localMs);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const localTime =
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}${offsetStr}`;
  return { offsetStr, offsetMinutes, dstActive, localTime };
}

function invalidTimezoneError(tz: string): ToolResult {
  const suggestions = getTimezoneSuggestions(tz);
  const hint = suggestions.length > 0 ? `\nLargest cities in this region: ${suggestions.join(', ')}` : '';
  if (!tz.includes('/')) {
    return { success: false, error: `Invalid timezone "${tz}". Use IANA format, e.g. "America/New_York".${hint}` };
  }
  return { success: false, error: `Invalid timezone "${tz}". Check the region name.${hint}` };
}

export function handleGetTimezoneInfo(input: { timezone: string | string[]; at?: string }): ToolResult {
  const dt = input.at ? new Date(input.at) : new Date();
  if (Number.isNaN(dt.getTime())) {
    return { success: false, error: `Invalid datetime: ${input.at}` };
  }

  // Single timezone
  if (typeof input.timezone === 'string') {
    try {
      const { offsetStr, offsetMinutes, dstActive, localTime } = resolveSingle(input.timezone, dt);
      return {
        success: true,
        output: JSON.stringify({
          timezone: input.timezone,
          utc_offset: offsetStr,
          utc_offset_minutes: offsetMinutes,
          dst_active: dstActive,
          local_time: localTime,
        }),
      };
    } catch {
      return invalidTimezoneError(input.timezone);
    }
  }

  // Array of timezones
  const entries: Array<{
    timezone: string;
    utc_offset: string;
    utc_offset_minutes: number;
    dst_active: boolean;
    local_time: string;
  }> = [];
  for (const tz of input.timezone) {
    try {
      const { offsetStr, offsetMinutes, dstActive, localTime } = resolveSingle(tz, dt);
      entries.push({
        timezone: tz,
        utc_offset: offsetStr,
        utc_offset_minutes: offsetMinutes,
        dst_active: dstActive,
        local_time: localTime,
      });
    } catch {
      return invalidTimezoneError(tz);
    }
  }

  // Sort west→east by offset
  entries.sort((a, b) => a.utc_offset_minutes - b.utc_offset_minutes);

  const minOffset = entries[0]!.utc_offset_minutes;
  const maxOffset = entries[entries.length - 1]!.utc_offset_minutes;
  const diffMinutes = maxOffset - minOffset;
  const diffHours = Math.round((diffMinutes / 60) * 10) / 10;

  const mostWest = entries[0]!.timezone;
  const mostEast = entries[entries.length - 1]!.timezone;
  const isTwo = entries.length === 2;
  const ahead = isTwo
    ? `${mostEast} is ${diffHours}h ahead of ${mostWest}`
    : `Ranked west→east: ${entries.map((e) => `${e.timezone} (${e.utc_offset})`).join(', ')}. ${mostEast} is furthest ahead.`;

  const result: Record<string, unknown> = { timezones: entries, ahead };
  if (isTwo) {
    result.difference_minutes = diffMinutes;
    result.difference_hours = diffHours;
  }

  return { success: true, output: JSON.stringify(result) };
}

/**
 * Wraps handleGetTimezoneInfo with city name resolution fallback.
 * When a timezone string is not a valid IANA ID, tries:
 * 1. city-timezones library lookup
 * 2. AI fast model resolution with retries
 */
export async function handleGetTimezoneInfoWithCityFallback(input: {
  timezone: string | string[];
  at?: string;
}): Promise<ToolResult> {
  // Only attempt city resolution for single timezone string
  if (typeof input.timezone !== 'string') return handleGetTimezoneInfo(input);

  // Skip sync IANA check when input is clearly not an IANA ID (no "/")
  // — go straight to city resolution which has dictionary + cache
  if (input.timezone.includes('/')) {
    const syncResult = handleGetTimezoneInfo(input);
    if (syncResult.success) return syncResult;
  }

  const resolved = await resolveCity(input.timezone);
  if (!resolved) return invalidTimezoneError(input.timezone);

  return handleGetTimezoneInfo({ timezone: resolved, at: input.at });
}

export function handleConvertToTimezone(input: { datetime: string; timezone: string }): ToolResult {
  const dt = new Date(input.datetime);
  if (Number.isNaN(dt.getTime())) {
    return { success: false, error: `Invalid datetime: ${input.datetime}` };
  }

  let offsetStr: string;
  let offsetMinutes: number;
  try {
    ({ offsetStr, offsetMinutes } = validateAndGetOffset(input.timezone, dt));
  } catch {
    const suggestions = getTimezoneSuggestions(input.timezone);
    const hint = suggestions.length > 0 ? `\nLargest cities in this region: ${suggestions.join(', ')}` : '';
    if (!input.timezone.includes('/')) {
      return {
        success: false,
        error: `Invalid timezone "${input.timezone}". Use IANA format, e.g. "America/New_York".${hint}`,
      };
    }
    return { success: false, error: `Invalid timezone "${input.timezone}".${hint}` };
  }

  const localMs = dt.getTime() + offsetMinutes * 60_000;
  const local = new Date(localMs);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const localDatetime =
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}${offsetStr}`;

  return {
    success: true,
    output: JSON.stringify({
      timezone: input.timezone,
      local_datetime: localDatetime,
      utc_offset: offsetStr,
    }),
  };
}
