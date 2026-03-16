// test/database/repositories/call-settings.repository.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations';
import { CallSettingsRepository } from '../../../src/database/repositories/call-settings.repository';
import { UserRepository } from '../../../src/database/repositories/user.repository';
import { runMigrations } from '../../../src/database/schema';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const USER_ID = 100;

describe('CallSettingsRepository', () => {
  let db: Database;
  let repo: CallSettingsRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new CallSettingsRepository(db);
    new UserRepository(db).create({ telegram_id: USER_ID });
  });

  test('get returns null when no settings', () => {
    expect(repo.get(USER_ID)).toBeNull();
  });

  test('ensureDefaults creates row with defaults', () => {
    repo.ensureDefaults(USER_ID);
    const settings = repo.get(USER_ID);
    expect(settings).not.toBeNull();
    expect(settings!.enabled).toBe(0);
    expect(settings!.max_daily_calls).toBe(5);
    expect(settings!.language).toBe('en');
  });

  test('ensureDefaults is idempotent', () => {
    repo.ensureDefaults(USER_ID);
    repo.ensureDefaults(USER_ID);
    expect(repo.get(USER_ID)!.enabled).toBe(0);
  });

  test('setEnabled toggles enabled flag', () => {
    repo.ensureDefaults(USER_ID);
    repo.setEnabled(USER_ID, true);
    expect(repo.get(USER_ID)!.enabled).toBe(1);
    repo.setEnabled(USER_ID, false);
    expect(repo.get(USER_ID)!.enabled).toBe(0);
  });

  test('setQuietHours stores start and end', () => {
    repo.ensureDefaults(USER_ID);
    repo.setQuietHours(USER_ID, '22:00', '08:00');
    const s = repo.get(USER_ID)!;
    expect(s.quiet_hours_start).toBe('22:00');
    expect(s.quiet_hours_end).toBe('08:00');
  });

  test('isEnabled returns false when not configured', () => {
    expect(repo.isEnabled(USER_ID)).toBe(false);
  });

  test('isEnabled returns true when enabled', () => {
    repo.ensureDefaults(USER_ID);
    repo.setEnabled(USER_ID, true);
    expect(repo.isEnabled(USER_ID)).toBe(true);
  });

  // --- Red tests ---

  test('get returns null for non-existent user', () => {
    expect(repo.get(999)).toBeNull();
  });

  test('isEnabled returns false for non-existent user', () => {
    expect(repo.isEnabled(999)).toBe(false);
  });

  test('setQuietHours clears with nulls', () => {
    repo.ensureDefaults(USER_ID);
    repo.setQuietHours(USER_ID, '22:00', '08:00');
    repo.setQuietHours(USER_ID, null, null);
    const s = repo.get(USER_ID)!;
    expect(s.quiet_hours_start).toBeNull();
    expect(s.quiet_hours_end).toBeNull();
  });

  test('setLanguage updates language', () => {
    repo.ensureDefaults(USER_ID);
    repo.setLanguage(USER_ID, 'ru');
    expect(repo.get(USER_ID)!.language).toBe('ru');
  });
});
