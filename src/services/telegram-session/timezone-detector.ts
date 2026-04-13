// src/services/telegram-session/timezone-detector.ts
import type { Authorization } from './session-bridge.ts';

export interface DetectionResult {
  detectedTimezone: string;
  country: string;
  region: string;
}

// Single-timezone countries: ISO 3166-1 alpha-2 → IANA timezone
const SINGLE_TZ_COUNTRIES: { [key: string]: string } = {
  AF: 'Asia/Kabul',
  AL: 'Europe/Tirane',
  AM: 'Asia/Yerevan',
  AE: 'Asia/Dubai',
  AT: 'Europe/Vienna',
  AZ: 'Asia/Baku',
  BA: 'Europe/Sarajevo',
  BE: 'Europe/Brussels',
  BG: 'Europe/Sofia',
  BH: 'Asia/Bahrain',
  BY: 'Europe/Minsk',
  CH: 'Europe/Zurich',
  CN: 'Asia/Shanghai',
  CY: 'Asia/Nicosia',
  CZ: 'Europe/Prague',
  DE: 'Europe/Berlin',
  DK: 'Europe/Copenhagen',
  EE: 'Europe/Tallinn',
  EG: 'Africa/Cairo',
  ES: 'Europe/Madrid',
  FI: 'Europe/Helsinki',
  FR: 'Europe/Paris',
  GB: 'Europe/London',
  GE: 'Asia/Tbilisi',
  GR: 'Europe/Athens',
  HR: 'Europe/Zagreb',
  HU: 'Europe/Budapest',
  ID: 'Asia/Jakarta',
  IL: 'Asia/Jerusalem',
  IN: 'Asia/Kolkata',
  IQ: 'Asia/Baghdad',
  IR: 'Asia/Tehran',
  IS: 'Atlantic/Reykjavik',
  IT: 'Europe/Rome',
  JP: 'Asia/Tokyo',
  JO: 'Asia/Amman',
  KE: 'Africa/Nairobi',
  KG: 'Asia/Bishkek',
  KR: 'Asia/Seoul',
  KW: 'Asia/Kuwait',
  KZ: 'Asia/Almaty',
  LB: 'Asia/Beirut',
  LT: 'Europe/Vilnius',
  LV: 'Europe/Riga',
  LY: 'Africa/Tripoli',
  MA: 'Africa/Casablanca',
  MD: 'Europe/Chisinau',
  ME: 'Europe/Podgorica',
  MK: 'Europe/Skopje',
  MT: 'Europe/Malta',
  NG: 'Africa/Lagos',
  NL: 'Europe/Amsterdam',
  NO: 'Europe/Oslo',
  NP: 'Asia/Kathmandu',
  OM: 'Asia/Muscat',
  PK: 'Asia/Karachi',
  PL: 'Europe/Warsaw',
  PT: 'Europe/Lisbon',
  QA: 'Asia/Qatar',
  RO: 'Europe/Bucharest',
  RS: 'Europe/Belgrade',
  SA: 'Asia/Riyadh',
  SE: 'Europe/Stockholm',
  SG: 'Asia/Singapore',
  SI: 'Europe/Ljubljana',
  SK: 'Europe/Bratislava',
  TH: 'Asia/Bangkok',
  TJ: 'Asia/Dushanbe',
  TM: 'Asia/Ashgabat',
  TR: 'Europe/Istanbul',
  TW: 'Asia/Taipei',
  TZ: 'Africa/Dar_es_Salaam',
  UA: 'Europe/Kyiv',
  UZ: 'Asia/Tashkent',
  VN: 'Asia/Ho_Chi_Minh',
  ZA: 'Africa/Johannesburg',
};

// Multi-timezone countries: region substring → IANA timezone (case-insensitive match)
// Each entry is [regionSubstring, ianaTimezone]. First match wins.
const MULTI_TZ_REGIONS: {
  [country: string]: { regions: Array<[string, string]>; default: string };
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
    default: 'Europe/Moscow',
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
      ['North Dakota', 'America/Chicago'],
      ['South Dakota', 'America/Chicago'],
      ['Nebraska', 'America/Chicago'],
      ['Kansas', 'America/Chicago'],
      ['Oklahoma', 'America/Chicago'],
      ['Texas', 'America/Chicago'],
      ['Minnesota', 'America/Chicago'],
      ['Iowa', 'America/Chicago'],
      ['Missouri', 'America/Chicago'],
      ['Wisconsin', 'America/Chicago'],
      ['Illinois', 'America/Chicago'],
      ['Mississippi', 'America/Chicago'],
      ['Louisiana', 'America/Chicago'],
      ['Arkansas', 'America/Chicago'],
      ['Alabama', 'America/Chicago'],
      ['Michigan', 'America/Detroit'],
      ['Indiana', 'America/Indiana/Indianapolis'],
      ['Kentucky', 'America/Kentucky/Louisville'],
      ['Tennessee', 'America/Chicago'],
      ['Ohio', 'America/New_York'],
      ['Pennsylvania', 'America/New_York'],
      ['New York', 'America/New_York'],
      ['New Jersey', 'America/New_York'],
      ['Connecticut', 'America/New_York'],
      ['Massachusetts', 'America/New_York'],
      ['Rhode Island', 'America/New_York'],
      ['Vermont', 'America/New_York'],
      ['New Hampshire', 'America/New_York'],
      ['Maine', 'America/New_York'],
      ['Maryland', 'America/New_York'],
      ['Delaware', 'America/New_York'],
      ['Virginia', 'America/New_York'],
      ['West Virginia', 'America/New_York'],
      ['North Carolina', 'America/New_York'],
      ['South Carolina', 'America/New_York'],
      ['Georgia', 'America/New_York'],
      ['Florida', 'America/New_York'],
      ['District of Columbia', 'America/New_York'],
      ['Puerto Rico', 'America/Puerto_Rico'],
    ],
    default: 'America/New_York',
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
    default: 'America/Toronto',
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
    default: 'Australia/Sydney',
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
    default: 'America/Sao_Paulo',
  },
};

function resolveMultiTz(country: string, region: string): string | null {
  const entry = MULTI_TZ_REGIONS[country];
  if (!entry) return null;

  const regionLower = region.toLowerCase();
  for (const [substr, tz] of entry.regions) {
    if (regionLower.includes(substr.toLowerCase())) {
      return tz;
    }
  }
  // Fall back to country default when region is not recognized
  return entry.default;
}

/**
 * Detects the most likely IANA timezone from a list of Telegram Authorization objects.
 *
 * Returns null when:
 * - No mobile sessions are present (platform must be iOS or Android)
 * - Country is not in the lookup table
 * - Detected timezone equals the user's current timezone
 */
export function detectTimezoneFromAuthorizations(
  authorizations: Authorization[],
  currentTimezone: string,
): DetectionResult | null {
  const mobileSessions = authorizations.filter((a) => a.platform === 'iOS' || a.platform === 'Android');

  if (mobileSessions.length === 0) return null;

  // Most recently active mobile session
  const sorted = [...mobileSessions].sort((a, b) => b.date_active - a.date_active);
  const session = sorted[0];
  if (!session) return null;

  const { country, region } = session;

  let detectedTimezone: string | null = null;

  if (SINGLE_TZ_COUNTRIES[country] !== undefined) {
    detectedTimezone = SINGLE_TZ_COUNTRIES[country];
  } else if (MULTI_TZ_REGIONS[country] !== undefined) {
    detectedTimezone = resolveMultiTz(country, region);
  }

  if (detectedTimezone === null) return null;
  if (detectedTimezone === currentTimezone) return null;

  return { detectedTimezone, country, region };
}
