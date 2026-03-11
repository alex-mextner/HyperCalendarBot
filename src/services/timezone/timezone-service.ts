import { find } from 'geo-tz';
import { formatUtcOffset } from '../../utils/telegram.ts';

export function resolveTimezone(latitude: number, longitude: number): string {
  const results = find(latitude, longitude);
  return results[0] ?? 'UTC';
}

export function getTimezoneDisplay(timezone: string): string {
  const offset = formatUtcOffset(timezone);
  return `${timezone} (${offset})`;
}

export function guessCountryFromTimezone(timezone: string): string | null {
  const tzToCountry: Record<string, string> = {
    'Europe/Moscow': 'RU',
    'Europe/Kiev': 'UA',
    'Europe/London': 'GB',
    'Europe/Paris': 'FR',
    'Europe/Berlin': 'DE',
    'Europe/Istanbul': 'TR',
    'Europe/Warsaw': 'PL',
    'Europe/Rome': 'IT',
    'Europe/Madrid': 'ES',
    'Europe/Belgrade': 'RS',
    'Europe/Helsinki': 'FI',
    'Europe/Amsterdam': 'NL',
    'Asia/Dubai': 'AE',
    'Asia/Kolkata': 'IN',
    'Asia/Bangkok': 'TH',
    'Asia/Singapore': 'SG',
    'Asia/Tokyo': 'JP',
    'Asia/Seoul': 'KR',
    'Asia/Shanghai': 'CN',
    'Asia/Hong_Kong': 'HK',
    'Asia/Almaty': 'KZ',
    'Asia/Tbilisi': 'GE',
    'Asia/Yerevan': 'AM',
    'Asia/Tashkent': 'UZ',
    'America/New_York': 'US',
    'America/Chicago': 'US',
    'America/Denver': 'US',
    'America/Los_Angeles': 'US',
    'America/Toronto': 'CA',
    'America/Sao_Paulo': 'BR',
    'America/Mexico_City': 'MX',
    'America/Buenos_Aires': 'AR',
    'Africa/Cairo': 'EG',
    'Africa/Lagos': 'NG',
    'Africa/Johannesburg': 'ZA',
    'Africa/Nairobi': 'KE',
    'Australia/Sydney': 'AU',
    'Pacific/Auckland': 'NZ',
  };
  return tzToCountry[timezone] ?? null;
}
