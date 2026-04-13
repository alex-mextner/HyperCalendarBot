// src/services/telegram-session/timezone-detector.ts
import ct from 'countries-and-timezones';
import type { Authorization } from './session-bridge.ts';

export interface DetectionResult {
  detectedTimezone: string;
  country: string;
  region: string;
}

/**
 * Multi-timezone countries where the Telegram `region` field can disambiguate.
 * Only needed for countries with >1 IANA timezone — single-tz countries are
 * resolved automatically via `countries-and-timezones`.
 *
 * Each entry: [regionSubstring (case-insensitive), ianaTimezone]. First match wins.
 */
const MULTI_TZ_REGIONS: {
  [country: string]: { regions: Array<[string, string]>; fallback: string };
} = {
  RU: {
    regions: [
      ['Kaliningrad', 'Europe/Kaliningrad'],
      ['Moscow', 'Europe/Moscow'],
      ['Saint Petersburg', 'Europe/Moscow'],
      ['St. Petersburg', 'Europe/Moscow'],
      ['Samara', 'Europe/Samara'],
      ['Ekaterinburg', 'Asia/Yekaterinburg'],
      ['Yekaterinburg', 'Asia/Yekaterinburg'],
      ['Omsk', 'Asia/Omsk'],
      ['Novosibirsk', 'Asia/Novosibirsk'],
      ['Krasnoyarsk', 'Asia/Krasnoyarsk'],
      ['Irkutsk', 'Asia/Irkutsk'],
      ['Chita', 'Asia/Chita'],
      ['Yakutsk', 'Asia/Yakutsk'],
      ['Vladivostok', 'Asia/Vladivostok'],
      ['Sakhalin', 'Asia/Sakhalin'],
      ['Magadan', 'Asia/Magadan'],
      ['Kamchatka', 'Asia/Kamchatka'],
      ['Anadyr', 'Asia/Anadyr'],
    ],
    fallback: 'Europe/Moscow',
  },
  US: {
    regions: [
      ['Hawaii', 'Pacific/Honolulu'],
      ['Alaska', 'America/Anchorage'],
      ['California', 'America/Los_Angeles'],
      ['Washington', 'America/Los_Angeles'],
      ['Oregon', 'America/Los_Angeles'],
      ['Nevada', 'America/Los_Angeles'],
      ['Arizona', 'America/Phoenix'],
      ['Colorado', 'America/Denver'],
      ['Utah', 'America/Denver'],
      ['Montana', 'America/Denver'],
      ['Wyoming', 'America/Denver'],
      ['New Mexico', 'America/Denver'],
      ['Idaho', 'America/Denver'],
      ['Texas', 'America/Chicago'],
      ['Illinois', 'America/Chicago'],
      ['Minnesota', 'America/Chicago'],
      ['Wisconsin', 'America/Chicago'],
      ['Iowa', 'America/Chicago'],
      ['Missouri', 'America/Chicago'],
      ['Oklahoma', 'America/Chicago'],
      ['Kansas', 'America/Chicago'],
      ['Nebraska', 'America/Chicago'],
      ['North Dakota', 'America/Chicago'],
      ['South Dakota', 'America/Chicago'],
      ['Mississippi', 'America/Chicago'],
      ['Louisiana', 'America/Chicago'],
      ['Arkansas', 'America/Chicago'],
      ['Alabama', 'America/Chicago'],
      ['Tennessee', 'America/Chicago'],
      ['Michigan', 'America/Detroit'],
      ['Indiana', 'America/Indiana/Indianapolis'],
      ['Kentucky', 'America/Kentucky/Louisville'],
      ['New York', 'America/New_York'],
      ['Pennsylvania', 'America/New_York'],
      ['Ohio', 'America/New_York'],
      ['New Jersey', 'America/New_York'],
      ['Connecticut', 'America/New_York'],
      ['Massachusetts', 'America/New_York'],
      ['Maryland', 'America/New_York'],
      ['Virginia', 'America/New_York'],
      ['North Carolina', 'America/New_York'],
      ['South Carolina', 'America/New_York'],
      ['Georgia', 'America/New_York'],
      ['Florida', 'America/New_York'],
      ['District of Columbia', 'America/New_York'],
      ['Puerto Rico', 'America/Puerto_Rico'],
    ],
    fallback: 'America/New_York',
  },
  CA: {
    regions: [
      ['British Columbia', 'America/Vancouver'],
      ['Yukon', 'America/Whitehorse'],
      ['Alberta', 'America/Edmonton'],
      ['Saskatchewan', 'America/Regina'],
      ['Manitoba', 'America/Winnipeg'],
      ['Ontario', 'America/Toronto'],
      ['Quebec', 'America/Toronto'],
      ['New Brunswick', 'America/Moncton'],
      ['Nova Scotia', 'America/Halifax'],
      ['Prince Edward Island', 'America/Halifax'],
      ['Newfoundland', 'America/St_Johns'],
    ],
    fallback: 'America/Toronto',
  },
  AU: {
    regions: [
      ['Western Australia', 'Australia/Perth'],
      ['Northern Territory', 'Australia/Darwin'],
      ['South Australia', 'Australia/Adelaide'],
      ['Queensland', 'Australia/Brisbane'],
      ['New South Wales', 'Australia/Sydney'],
      ['Victoria', 'Australia/Melbourne'],
      ['Tasmania', 'Australia/Hobart'],
      ['Australian Capital Territory', 'Australia/Sydney'],
    ],
    fallback: 'Australia/Sydney',
  },
  BR: {
    regions: [
      ['Acre', 'America/Rio_Branco'],
      ['Amazonas', 'America/Manaus'],
      ['Mato Grosso', 'America/Cuiaba'],
      ['Mato Grosso do Sul', 'America/Campo_Grande'],
      ['Sao Paulo', 'America/Sao_Paulo'],
      ['Rio de Janeiro', 'America/Sao_Paulo'],
      ['Brasilia', 'America/Sao_Paulo'],
      ['Bahia', 'America/Bahia'],
      ['Fernando de Noronha', 'America/Noronha'],
    ],
    fallback: 'America/Sao_Paulo',
  },
};

/**
 * Resolves a country code to a single IANA timezone using the
 * `countries-and-timezones` library (backed by IANA tzdata).
 * Returns the timezone if the country has exactly one, or null if it has multiple.
 */
function resolveSingleTzCountry(countryCode: string): string | null {
  const timezones = ct.getTimezonesForCountry(countryCode);
  if (!timezones || timezones.length !== 1) return null;
  return timezones[0]?.name ?? null;
}

function resolveMultiTz(country: string, region: string): string | null {
  const entry = MULTI_TZ_REGIONS[country];
  if (!entry) return null;

  const regionLower = region.toLowerCase();
  for (const [substr, tz] of entry.regions) {
    if (regionLower.includes(substr.toLowerCase())) {
      return tz;
    }
  }
  return entry.fallback;
}

/**
 * Detects the most likely IANA timezone from a list of Telegram Authorization objects.
 *
 * Resolution strategy:
 * 1. Filter for mobile sessions (iOS / Android) — most reliable location signal
 * 2. Pick the most recently active one
 * 3. If the country has exactly 1 timezone (via IANA data) → use it
 * 4. If the country has multiple → use the region hint from the curated map
 * 5. Return null if timezone matches current or country is unknown
 */
export function detectTimezoneFromAuthorizations(
  authorizations: Authorization[],
  currentTimezone: string,
): DetectionResult | null {
  const mobileSessions = authorizations.filter((a) => a.platform === 'iOS' || a.platform === 'Android');

  if (mobileSessions.length === 0) return null;

  const sorted = [...mobileSessions].sort((a, b) => b.date_active - a.date_active);
  const session = sorted[0];
  if (!session) return null;

  const { country, region } = session;

  // Try single-tz country first (covers ~150 countries via IANA data)
  let detectedTimezone = resolveSingleTzCountry(country);

  // Multi-tz country — use region map
  if (detectedTimezone === null) {
    detectedTimezone = resolveMultiTz(country, region);
  }

  if (detectedTimezone === null) return null;
  if (detectedTimezone === currentTimezone) return null;

  return { detectedTimezone, country, region };
}
