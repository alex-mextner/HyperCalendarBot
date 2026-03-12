import Holidays from 'date-holidays';
import type { HolidayRepository, HolidaySubscriptionRow } from '../../database/repositories/holiday.repository.ts';

export interface HolidayEntry {
  date: string;
  name: string;
  type: string;
  countryCode: string;
  countryName: string;
}

export class HolidayService {
  private hd: Holidays;

  constructor(private repo: HolidayRepository) {
    this.hd = new Holidays();
  }

  refreshCountryHolidays(countryCode: string, year: number): void {
    this.hd.init(countryCode);
    const holidays = this.hd.getHolidays(year);

    const countryData = this.hd.getCountries();
    const countryName = countryData[countryCode] ?? countryCode;
    const region = this.guessRegion(countryCode);
    this.repo.upsertCountry(countryCode, countryName, region);

    this.repo.deleteHolidaysByYear(countryCode, year);
    this.repo.insertHolidays(
      holidays
        .filter((h) => h.type === 'public' || h.type === 'bank')
        .map((h) => ({
          country_code: countryCode,
          date: h.date.slice(0, 10),
          name: h.name,
          type: h.type,
          year,
        })),
    );
  }

  refreshOnStartup(): void {
    const currentYear = new Date().getFullYear();
    const allCountries = new Set<string>();

    const regions = this.repo.getAllRegions();
    if (regions.length === 0) return;

    for (const region of regions) {
      const countries = this.repo.getCountriesByRegion(region);
      for (const c of countries) {
        allCountries.add(c.code);
      }
    }

    for (const code of allCountries) {
      this.refreshCountryHolidays(code, currentYear);
      this.refreshCountryHolidays(code, currentYear + 1);
    }
  }

  subscribeUser(userId: number, countryCode: string, isPrimary: boolean): void {
    const currentYear = new Date().getFullYear();
    this.refreshCountryHolidays(countryCode, currentYear);
    this.refreshCountryHolidays(countryCode, currentYear + 1);
    this.repo.subscribe(userId, countryCode, isPrimary);
  }

  unsubscribeUser(userId: number, countryCode: string): void {
    this.repo.unsubscribe(userId, countryCode);
  }

  getHolidaysForDate(userId: number, date: string): HolidayEntry[] {
    const dateStr = date.slice(0, 10);
    const rows = this.repo.getHolidaysForUserDate(userId, dateStr);
    return rows.map((r) => ({
      date: r.date,
      name: r.name,
      type: r.type,
      countryCode: r.country_code,
      countryName: r.country_name,
    }));
  }

  isDayOff(userId: number, date: string): boolean {
    const dateStr = date.slice(0, 10);

    const override = this.repo.getOverride(userId, dateStr);
    if (override) return override.is_day_off === 1;

    const primaryCountry = this.repo.getPrimaryCountry(userId);
    if (!primaryCountry) return false;

    const holidays = this.repo.getHolidaysForRange(primaryCountry, dateStr, dateStr);
    return holidays.some((h) => h.type === 'public' || h.type === 'bank');
  }

  getUpcomingHolidays(userId: number, limit = 10): HolidayEntry[] {
    const today = new Date().toISOString().slice(0, 10);
    const endDate = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    const subs = this.repo.getSubscriptions(userId);

    const all: HolidayEntry[] = [];
    for (const sub of subs) {
      const country = this.repo.getCountry(sub.country_code);
      const holidays = this.repo.getHolidaysForRange(sub.country_code, today, endDate);
      for (const h of holidays) {
        all.push({
          date: h.date,
          name: h.name,
          type: h.type,
          countryCode: h.country_code,
          countryName: country?.name ?? h.country_code,
        });
      }
    }

    return all.sort((a, b) => a.date.localeCompare(b.date)).slice(0, limit);
  }

  getAvailableRegions(): string[] {
    const countries = this.hd.getCountries();
    const regionSet = new Set<string>();
    for (const code of Object.keys(countries)) {
      regionSet.add(this.guessRegion(code));
    }
    return [...regionSet].sort();
  }

  getCountriesForRegion(region: string): { code: string; name: string }[] {
    const allCountries = this.hd.getCountries();
    const result: { code: string; name: string }[] = [];
    for (const [code, name] of Object.entries(allCountries)) {
      if (this.guessRegion(code) === region) {
        result.push({ code, name: name as string });
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  getCountryName(countryCode: string): string {
    const country = this.repo.getCountry(countryCode);
    if (country) return country.name;
    const allCountries = this.hd.getCountries();
    return (allCountries[countryCode] as string) ?? countryCode;
  }

  getSubscription(userId: number, countryCode: string): HolidaySubscriptionRow | null {
    return this.repo.getSubscription(userId, countryCode);
  }

  getSubscriptions(userId: number): HolidaySubscriptionRow[] {
    return this.repo.getSubscriptions(userId);
  }

  setPrimary(userId: number, countryCode: string): void {
    this.repo.setPrimary(userId, countryCode);
  }

  toggleNotify(userId: number, countryCode: string): void {
    this.repo.toggleNotify(userId, countryCode);
  }

  private guessRegion(countryCode: string): string {
    const regionMap: Record<string, string> = {
      AL: 'Europe',
      AT: 'Europe',
      BE: 'Europe',
      BG: 'Europe',
      BY: 'Europe',
      CH: 'Europe',
      CZ: 'Europe',
      DE: 'Europe',
      DK: 'Europe',
      EE: 'Europe',
      ES: 'Europe',
      FI: 'Europe',
      FR: 'Europe',
      GB: 'Europe',
      GR: 'Europe',
      HR: 'Europe',
      HU: 'Europe',
      IE: 'Europe',
      IS: 'Europe',
      IT: 'Europe',
      LT: 'Europe',
      LU: 'Europe',
      LV: 'Europe',
      MD: 'Europe',
      ME: 'Europe',
      MK: 'Europe',
      NL: 'Europe',
      NO: 'Europe',
      PL: 'Europe',
      PT: 'Europe',
      RO: 'Europe',
      RS: 'Europe',
      RU: 'Europe',
      SE: 'Europe',
      SI: 'Europe',
      SK: 'Europe',
      TR: 'Europe',
      UA: 'Europe',
      XK: 'Europe',
      AE: 'Asia',
      AM: 'Asia',
      AZ: 'Asia',
      BD: 'Asia',
      BN: 'Asia',
      CN: 'Asia',
      GE: 'Asia',
      HK: 'Asia',
      ID: 'Asia',
      IL: 'Asia',
      IN: 'Asia',
      IQ: 'Asia',
      IR: 'Asia',
      JP: 'Asia',
      KG: 'Asia',
      KH: 'Asia',
      KR: 'Asia',
      KZ: 'Asia',
      LA: 'Asia',
      LK: 'Asia',
      MM: 'Asia',
      MN: 'Asia',
      MY: 'Asia',
      NP: 'Asia',
      PH: 'Asia',
      PK: 'Asia',
      QA: 'Asia',
      SA: 'Asia',
      SG: 'Asia',
      TH: 'Asia',
      TJ: 'Asia',
      TM: 'Asia',
      TW: 'Asia',
      UZ: 'Asia',
      VN: 'Asia',
      AR: 'Americas',
      BO: 'Americas',
      BR: 'Americas',
      CA: 'Americas',
      CL: 'Americas',
      CO: 'Americas',
      CR: 'Americas',
      CU: 'Americas',
      DO: 'Americas',
      EC: 'Americas',
      GT: 'Americas',
      HN: 'Americas',
      HT: 'Americas',
      JM: 'Americas',
      MX: 'Americas',
      NI: 'Americas',
      PA: 'Americas',
      PE: 'Americas',
      PY: 'Americas',
      SV: 'Americas',
      US: 'Americas',
      UY: 'Americas',
      VE: 'Americas',
      AO: 'Africa',
      BF: 'Africa',
      BJ: 'Africa',
      BW: 'Africa',
      CD: 'Africa',
      CF: 'Africa',
      CG: 'Africa',
      CI: 'Africa',
      CM: 'Africa',
      DJ: 'Africa',
      DZ: 'Africa',
      EG: 'Africa',
      ET: 'Africa',
      GA: 'Africa',
      GH: 'Africa',
      GN: 'Africa',
      KE: 'Africa',
      LY: 'Africa',
      MA: 'Africa',
      MG: 'Africa',
      ML: 'Africa',
      MR: 'Africa',
      MU: 'Africa',
      MW: 'Africa',
      MZ: 'Africa',
      NA: 'Africa',
      NE: 'Africa',
      NG: 'Africa',
      RW: 'Africa',
      SD: 'Africa',
      SN: 'Africa',
      SO: 'Africa',
      SS: 'Africa',
      TD: 'Africa',
      TG: 'Africa',
      TN: 'Africa',
      TZ: 'Africa',
      UG: 'Africa',
      ZA: 'Africa',
      ZM: 'Africa',
      ZW: 'Africa',
      AU: 'Oceania',
      FJ: 'Oceania',
      NZ: 'Oceania',
      PG: 'Oceania',
    };
    return regionMap[countryCode] ?? 'Other';
  }
}
