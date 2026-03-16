import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations';
import { EventRepository } from '../../../src/database/repositories/event.repository';
import { SharingSettingsRepository } from '../../../src/database/repositories/sharing-settings.repository';
import { UserRepository } from '../../../src/database/repositories/user.repository';
import { runMigrations } from '../../../src/database/schema';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const USER_ID = 100;

describe('SharingSettingsRepository', () => {
  let db: Database;
  let repo: SharingSettingsRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SharingSettingsRepository(db);
    new UserRepository(db).create({ telegram_id: USER_ID });
  });

  test('ensureDefaults creates row with defaults', () => {
    repo.ensureDefaults(USER_ID);
    const settings = repo.get(USER_ID);
    expect(settings).not.toBeNull();
    expect(settings!.default_visibility).toBe('full');
    expect(settings!.inline_mode_enabled).toBe(1);
    expect(settings!.allow_invitations).toBe(1);
  });

  test('ensureDefaults is idempotent', () => {
    repo.ensureDefaults(USER_ID);
    repo.ensureDefaults(USER_ID);
    const settings = repo.get(USER_ID);
    expect(settings!.default_visibility).toBe('full');
  });

  test('update changes specified fields only', () => {
    repo.ensureDefaults(USER_ID);
    repo.update(USER_ID, { default_visibility: 'full', share_location: 1 });
    const settings = repo.get(USER_ID);
    expect(settings!.default_visibility).toBe('full');
    expect(settings!.share_location).toBe(1);
    expect(settings!.inline_mode_enabled).toBe(1);
  });

  test('getEventVisibility returns null when not set', () => {
    expect(repo.getEventVisibility(999)).toBeNull();
  });

  test('setEventVisibility creates and retrieves override', () => {
    const event = new EventRepository(db).create({
      user_id: USER_ID,
      title: 'Test',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    });
    repo.setEventVisibility(event.id, 'full');
    expect(repo.getEventVisibility(event.id)).toBe('full');
  });

  test('setEventVisibility updates existing override', () => {
    const event = new EventRepository(db).create({
      user_id: USER_ID,
      title: 'Test',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    });
    repo.setEventVisibility(event.id, 'full');
    repo.setEventVisibility(event.id, 'free_busy');
    expect(repo.getEventVisibility(event.id)).toBe('free_busy');
  });

  test('removeEventVisibility deletes override', () => {
    const event = new EventRepository(db).create({
      user_id: USER_ID,
      title: 'Test',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    });
    repo.setEventVisibility(event.id, 'full');
    repo.removeEventVisibility(event.id);
    expect(repo.getEventVisibility(event.id)).toBeNull();
  });
});
