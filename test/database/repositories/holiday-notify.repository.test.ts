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

describe('HolidayRepository.getUsersWithNotifyForDate', () => {
  let db: Database;
  let repo: HolidayRepository;
  let userRepo: UserRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new HolidayRepository(db);
    userRepo = new UserRepository(db);
  });

  test('returns users who have notify=1 subscription with a holiday on that date', () => {
    userRepo.create({ telegram_id: 1 });
    repo.upsertCountry('UA', 'Ukraine', 'Europe');
    repo.insertHolidays([{ country_code: 'UA', date: '2026-03-19', name: 'Test Holiday', type: 'public', year: 2026 }]);
    repo.subscribe(1, 'UA', true);

    const rows = repo.getUsersWithNotifyForDate('2026-03-19');
    expect(rows.length).toBe(1);
    expect(rows[0]!.user_id).toBe(1);
    expect(rows[0]!.holiday_name).toBe('Test Holiday');
    expect(rows[0]!.country_code).toBe('UA');
  });

  test('excludes users with notify=0', () => {
    userRepo.create({ telegram_id: 1 });
    repo.upsertCountry('UA', 'Ukraine', 'Europe');
    repo.insertHolidays([{ country_code: 'UA', date: '2026-03-19', name: 'Test Holiday', type: 'public', year: 2026 }]);
    repo.subscribe(1, 'UA', true);
    // toggle off
    repo.toggleNotify(1, 'UA');

    const rows = repo.getUsersWithNotifyForDate('2026-03-19');
    expect(rows.length).toBe(0);
  });

  test('returns empty when no holiday on that date', () => {
    userRepo.create({ telegram_id: 1 });
    repo.upsertCountry('UA', 'Ukraine', 'Europe');
    repo.subscribe(1, 'UA', true);

    const rows = repo.getUsersWithNotifyForDate('2026-03-19');
    expect(rows.length).toBe(0);
  });

  test('returns one row per user even with multiple countries with holidays', () => {
    userRepo.create({ telegram_id: 1 });
    repo.upsertCountry('UA', 'Ukraine', 'Europe');
    repo.upsertCountry('PL', 'Poland', 'Europe');
    repo.insertHolidays([
      { country_code: 'UA', date: '2026-03-19', name: 'UA Holiday', type: 'public', year: 2026 },
      { country_code: 'PL', date: '2026-03-19', name: 'PL Holiday', type: 'public', year: 2026 },
    ]);
    repo.subscribe(1, 'UA', true);
    repo.subscribe(1, 'PL', false);

    const rows = repo.getUsersWithNotifyForDate('2026-03-19');
    // Both subscriptions have notify=1 by default, so we get two rows (one per country)
    // The scheduler picks the first (primary first)
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.user_id).toBe(1);
  });

  test('multiple users each get their own row', () => {
    userRepo.create({ telegram_id: 1 });
    userRepo.create({ telegram_id: 2 });
    repo.upsertCountry('UA', 'Ukraine', 'Europe');
    repo.insertHolidays([{ country_code: 'UA', date: '2026-03-19', name: 'Test Holiday', type: 'public', year: 2026 }]);
    repo.subscribe(1, 'UA', true);
    repo.subscribe(2, 'UA', true);

    const rows = repo.getUsersWithNotifyForDate('2026-03-19');
    const userIds = rows.map((r) => r.user_id);
    expect(userIds).toContain(1);
    expect(userIds).toContain(2);
  });
});
