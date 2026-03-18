import type { Database } from 'bun:sqlite';

export interface HolidayCountryRow {
  code: string;
  name: string;
  region: string;
}

export interface HolidayRow {
  id: number;
  country_code: string;
  date: string;
  name: string;
  type: string;
  year: number;
}

export interface HolidaySubscriptionRow {
  id: number;
  user_id: number;
  country_code: string;
  is_primary: number;
  notify: number;
  created_at: string;
}

export interface HolidayOverrideRow {
  id: number;
  user_id: number;
  date: string;
  is_day_off: number;
  created_at: string;
}

export interface InsertHolidayData {
  country_code: string;
  date: string;
  name: string;
  type: string;
  year: number;
}

export class HolidayRepository {
  constructor(private db: Database) {}

  upsertCountry(code: string, name: string, region: string): void {
    this.db
      .prepare(
        'INSERT INTO holiday_countries (code, name, region) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET name = excluded.name, region = excluded.region',
      )
      .run(code, name, region);
  }

  getCountry(code: string): HolidayCountryRow | null {
    return this.db.prepare('SELECT * FROM holiday_countries WHERE code = ?').get(code) as HolidayCountryRow | null;
  }

  getCountriesByRegion(region: string): HolidayCountryRow[] {
    return this.db
      .prepare('SELECT * FROM holiday_countries WHERE region = ? ORDER BY name')
      .all(region) as HolidayCountryRow[];
  }

  getAllRegions(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT region FROM holiday_countries ORDER BY region').all() as {
      region: string;
    }[];
    return rows.map((r) => r.region);
  }

  insertHolidays(holidays: InsertHolidayData[]): void {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO holidays (country_code, date, name, type, year) VALUES (?, ?, ?, ?, ?)',
    );
    const tx = this.db.transaction(() => {
      for (const h of holidays) {
        stmt.run(h.country_code, h.date, h.name, h.type, h.year);
      }
    });
    tx();
  }

  deleteHolidaysByYear(countryCode: string, year: number): void {
    this.db.prepare('DELETE FROM holidays WHERE country_code = ? AND year = ?').run(countryCode, year);
  }

  getHolidaysForRange(countryCode: string, fromDate: string, toDate: string): HolidayRow[] {
    return this.db
      .prepare('SELECT * FROM holidays WHERE country_code = ? AND date >= ? AND date <= ? ORDER BY date')
      .all(countryCode, fromDate, toDate) as HolidayRow[];
  }

  getHolidaysForUserDate(userId: number, date: string): (HolidayRow & { country_name: string })[] {
    return this.db
      .prepare(`
        SELECT h.*, hc.name as country_name
        FROM holidays h
        JOIN holiday_subscriptions hs ON hs.country_code = h.country_code AND hs.user_id = ?
        JOIN holiday_countries hc ON hc.code = h.country_code
        WHERE h.date = ?
        ORDER BY hs.is_primary DESC, h.country_code
      `)
      .all(userId, date) as (HolidayRow & { country_name: string })[];
  }

  subscribe(userId: number, countryCode: string, isPrimary: boolean): void {
    if (isPrimary) {
      this.db.prepare('UPDATE holiday_subscriptions SET is_primary = 0 WHERE user_id = ?').run(userId);
    }
    this.db
      .prepare(`
        INSERT INTO holiday_subscriptions (user_id, country_code, is_primary) VALUES (?, ?, ?)
        ON CONFLICT(user_id, country_code) DO UPDATE SET is_primary = excluded.is_primary
      `)
      .run(userId, countryCode, isPrimary ? 1 : 0);
  }

  unsubscribe(userId: number, countryCode: string): void {
    this.db
      .prepare('DELETE FROM holiday_subscriptions WHERE user_id = ? AND country_code = ?')
      .run(userId, countryCode);
  }

  getSubscriptions(userId: number): HolidaySubscriptionRow[] {
    return this.db
      .prepare('SELECT * FROM holiday_subscriptions WHERE user_id = ? ORDER BY is_primary DESC')
      .all(userId) as HolidaySubscriptionRow[];
  }

  getSubscription(userId: number, countryCode: string): HolidaySubscriptionRow | null {
    return this.db
      .prepare('SELECT * FROM holiday_subscriptions WHERE user_id = ? AND country_code = ?')
      .get(userId, countryCode) as HolidaySubscriptionRow | null;
  }

  setPrimary(userId: number, countryCode: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE holiday_subscriptions SET is_primary = 0 WHERE user_id = ?').run(userId);
      this.db
        .prepare('UPDATE holiday_subscriptions SET is_primary = 1 WHERE user_id = ? AND country_code = ?')
        .run(userId, countryCode);
    });
    tx();
  }

  toggleNotify(userId: number, countryCode: string): void {
    this.db
      .prepare('UPDATE holiday_subscriptions SET notify = 1 - notify WHERE user_id = ? AND country_code = ?')
      .run(userId, countryCode);
  }

  setOverride(userId: number, date: string, isDayOff: boolean): void {
    this.db
      .prepare('INSERT OR REPLACE INTO holiday_overrides (user_id, date, is_day_off) VALUES (?, ?, ?)')
      .run(userId, date, isDayOff ? 1 : 0);
  }

  getOverride(userId: number, date: string): HolidayOverrideRow | null {
    return this.db
      .prepare('SELECT * FROM holiday_overrides WHERE user_id = ? AND date = ?')
      .get(userId, date) as HolidayOverrideRow | null;
  }

  removeOverride(userId: number, date: string): void {
    this.db.prepare('DELETE FROM holiday_overrides WHERE user_id = ? AND date = ?').run(userId, date);
  }

  getPrimaryCountry(userId: number): string | null {
    const row = this.db
      .prepare('SELECT country_code FROM holiday_subscriptions WHERE user_id = ? AND is_primary = 1')
      .get(userId) as { country_code: string } | null;
    return row?.country_code ?? null;
  }

  getUsersWithNotifyForDate(date: string): { user_id: number; country_code: string; holiday_name: string }[] {
    return this.db
      .prepare(`
        SELECT hs.user_id, hs.country_code, h.name AS holiday_name
        FROM holiday_subscriptions hs
        JOIN holidays h ON h.country_code = hs.country_code AND h.date = ?
        WHERE hs.notify = 1
        ORDER BY hs.user_id, hs.is_primary DESC
      `)
      .all(date) as { user_id: number; country_code: string; holiday_name: string }[];
  }
}
