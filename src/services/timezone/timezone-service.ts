import { readFileSync } from 'node:fs';
import { find } from 'geo-tz';
import { logger } from '../../utils/logger.ts';
import { formatUtcOffset } from '../../utils/telegram.ts';

export function resolveTimezone(latitude: number, longitude: number): string {
  const results = find(latitude, longitude);
  return results[0] ?? 'UTC';
}

export function getTimezoneDisplay(timezone: string): string {
  const offset = formatUtcOffset(timezone);
  return `${timezone} (${offset})`;
}

/** The IANA tz database installed on the system (the `tzdata` package of the Docker image). */
interface TzData {
  /**
   * zone.tab: the zones of each country (ISO 3166-1 alpha-2), including one per country that the
   * database otherwise keeps only as a link (Europe/Podgorica for Montenegro).
   */
  zonesByCountry: Map<string, string[]>;
  countryByZone: Map<string, string>;
  /** tzdata.zi links: a renamed or backward name → its zone (Europe/Kiev → Europe/Kyiv). */
  linkTargets: Map<string, string>;
}

let tzData: TzData | undefined;

/** The first of `paths` that can be read, else null. */
function readFirst(paths: string[]): string | null {
  for (const path of paths) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      // Try the next path
    }
  }
  return null;
}

/**
 * Read once, on first use. A missing file leaves its maps empty: zones and countries are then
 * unknown, never guessed.
 */
function loadTzData(): TzData {
  if (tzData) return tzData;
  tzData = { zonesByCountry: new Map(), countryByZone: new Map(), linkTargets: new Map() };

  const zoneTab = readFirst(['/usr/share/zoneinfo/zone.tab', '/usr/share/lib/zoneinfo/tab/zone_sun.tab']);
  if (zoneTab === null) logger.warn('zone.tab not found: timezone countries are unknown. Install tzdata.');
  for (const line of zoneTab?.split('\n') ?? []) {
    if (line.startsWith('#') || line.trim() === '') continue;
    const [country, , zone] = line.split('\t');
    if (!country || !zone) continue;
    const zones = tzData.zonesByCountry.get(country);
    if (zones) zones.push(zone);
    else tzData.zonesByCountry.set(country, [zone]);
    tzData.countryByZone.set(zone, country);
  }

  const links = readFirst(['/usr/share/zoneinfo/tzdata.zi']);
  if (links === null) logger.warn('tzdata.zi not found: renamed timezone names have no country. Install tzdata.');
  for (const line of links?.split('\n') ?? []) {
    if (!line.startsWith('L ')) continue;
    const [, target, alias] = line.split(' ');
    if (target && alias) tzData.linkTargets.set(alias, target);
  }
  return tzData;
}

/** The zones the tz database lists for a country (ISO 3166-1 alpha-2); empty when unknown. */
export function timezonesOfCountry(countryCode: string): readonly string[] {
  return loadTzData().zonesByCountry.get(countryCode) ?? [];
}

/**
 * The country (ISO 3166-1 alpha-2) of an IANA zone, from the tz database: the zone's zone.tab row,
 * else the row of the zone a renamed or backward name links to (US/Eastern, Asia/Calcutta). Null
 * for zones of no country (UTC, Etc/GMT+5) and unknown names.
 */
export function guessCountryFromTimezone(timezone: string): string | null {
  const { countryByZone, linkTargets } = loadTzData();
  const target = linkTargets.get(timezone);
  return countryByZone.get(timezone) ?? (target ? countryByZone.get(target) : undefined) ?? null;
}
