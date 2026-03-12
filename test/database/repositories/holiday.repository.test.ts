import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('HolidayRepository', () => {
  let db: Database;
  let repo: HolidayRepository;
  const USER_ID = 123;

  beforeEach(() => {
    db = createTestDb();
    repo = new HolidayRepository(db);
    new UserRepository(db).create({ telegram_id: USER_ID });
  });

  test('upsertCountry inserts and returns country', () => {
    repo.upsertCountry('TR', 'Turkey', 'Europe');
    const country = repo.getCountry('TR');
    expect(country).not.toBeNull();
    expect(country!.name).toBe('Turkey');
  });

  test('insertHolidays stores holidays', () => {
    repo.upsertCountry('TR', 'Turkey', 'Europe');
    repo.insertHolidays([
      { country_code: 'TR', date: '2026-01-01', name: "New Year's Day", type: 'public', year: 2026 },
      { country_code: 'TR', date: '2026-04-23', name: "Children's Day", type: 'public', year: 2026 },
    ]);
    const holidays = repo.getHolidaysForRange('TR', '2026-01-01', '2026-12-31');
    expect(holidays.length).toBe(2);
  });

  test('subscribe and getSubscriptions', () => {
    repo.upsertCountry('TR', 'Turkey', 'Europe');
    repo.subscribe(USER_ID, 'TR', true);
    const subs = repo.getSubscriptions(USER_ID);
    expect(subs.length).toBe(1);
    expect(subs[0]!.is_primary).toBe(1);
  });

  test('unsubscribe removes subscription', () => {
    repo.upsertCountry('TR', 'Turkey', 'Europe');
    repo.subscribe(USER_ID, 'TR', false);
    repo.unsubscribe(USER_ID, 'TR');
    const subs = repo.getSubscriptions(USER_ID);
    expect(subs.length).toBe(0);
  });

  test('setPrimary updates primary flag', () => {
    repo.upsertCountry('TR', 'Turkey', 'Europe');
    repo.upsertCountry('UA', 'Ukraine', 'Europe');
    repo.subscribe(USER_ID, 'TR', true);
    repo.subscribe(USER_ID, 'UA', false);
    repo.setPrimary(USER_ID, 'UA');
    const subs = repo.getSubscriptions(USER_ID);
    const uaSub = subs.find((s) => s.country_code === 'UA');
    const trSub = subs.find((s) => s.country_code === 'TR');
    expect(uaSub!.is_primary).toBe(1);
    expect(trSub!.is_primary).toBe(0);
  });

  test('setOverride and getOverride', () => {
    repo.setOverride(USER_ID, '2026-03-15', true);
    const override = repo.getOverride(USER_ID, '2026-03-15');
    expect(override).not.toBeNull();
    expect(override!.is_day_off).toBe(1);
  });

  test('getHolidaysForUserDate returns holidays across subscriptions', () => {
    repo.upsertCountry('TR', 'Turkey', 'Europe');
    repo.insertHolidays([{ country_code: 'TR', date: '2026-01-01', name: 'New Year', type: 'public', year: 2026 }]);
    repo.subscribe(USER_ID, 'TR', true);
    const holidays = repo.getHolidaysForUserDate(USER_ID, '2026-01-01');
    expect(holidays.length).toBe(1);
  });
});
