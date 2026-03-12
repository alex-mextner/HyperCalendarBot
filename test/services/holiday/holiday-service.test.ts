import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('HolidayService', () => {
  let service: HolidayService;
  let repo: HolidayRepository;
  const USER_ID = 123;

  beforeEach(() => {
    const db = createTestDb();
    repo = new HolidayRepository(db);
    new UserRepository(db).create({ telegram_id: USER_ID });
    service = new HolidayService(repo);
  });

  test('refreshCountryHolidays populates cache', () => {
    service.refreshCountryHolidays('UA', 2026);
    const holidays = repo.getHolidaysForRange('UA', '2026-01-01', '2026-12-31');
    expect(holidays.length).toBeGreaterThan(0);
  });

  test('subscribeUser subscribes and caches holidays', () => {
    service.subscribeUser(USER_ID, 'UA', true);
    const subs = repo.getSubscriptions(USER_ID);
    expect(subs.length).toBe(1);
    expect(subs[0]!.is_primary).toBe(1);
  });

  test('getHolidaysForDate returns holidays for subscribed user', () => {
    service.subscribeUser(USER_ID, 'UA', true);
    const holidays = service.getHolidaysForDate(USER_ID, '2026-01-01');
    expect(holidays.length).toBeGreaterThan(0);
  });

  test('isDayOff returns true for primary country holiday', () => {
    service.subscribeUser(USER_ID, 'UA', true);
    const result = service.isDayOff(USER_ID, '2026-01-01');
    expect(result).toBe(true);
  });

  test('isDayOff respects user override', () => {
    service.subscribeUser(USER_ID, 'UA', true);
    repo.setOverride(USER_ID, '2026-01-01', false);
    const result = service.isDayOff(USER_ID, '2026-01-01');
    expect(result).toBe(false);
  });

  test('isDayOff returns false with no subscriptions', () => {
    const result = service.isDayOff(USER_ID, '2026-01-01');
    expect(result).toBe(false);
  });

  test('getUpcomingHolidays returns future holidays', () => {
    service.subscribeUser(USER_ID, 'UA', true);
    const upcoming = service.getUpcomingHolidays(USER_ID, 10);
    expect(upcoming.length).toBeGreaterThan(0);
  });

  test('getAvailableRegions returns regions', () => {
    const regions = service.getAvailableRegions();
    expect(regions.length).toBeGreaterThan(0);
  });

  test('getCountriesForRegion returns countries', () => {
    const countries = service.getCountriesForRegion('Europe');
    expect(countries.length).toBeGreaterThan(0);
  });
});
