import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations';
import { EventRepository } from '../../../src/database/repositories/event.repository';
import { SharingSettingsRepository } from '../../../src/database/repositories/sharing-settings.repository';
import { UserRepository } from '../../../src/database/repositories/user.repository';
import { runMigrations } from '../../../src/database/schema';
import { PrivacyService } from '../../../src/services/sharing/privacy-service';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const USER_ID = 100;

describe('PrivacyService', () => {
  let db: Database;
  let settingsRepo: SharingSettingsRepository;
  let service: PrivacyService;

  beforeEach(() => {
    db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    settingsRepo = new SharingSettingsRepository(db);
    service = new PrivacyService(settingsRepo);
  });

  test('defaults to full when no settings exist', () => {
    expect(service.resolveVisibility(USER_ID, 1)).toBe('full');
  });

  test('uses user default when no event override', () => {
    settingsRepo.ensureDefaults(USER_ID);
    settingsRepo.update(USER_ID, { default_visibility: 'free_busy' });
    expect(service.resolveVisibility(USER_ID, 999)).toBe('free_busy');
  });

  test('event override takes precedence over user default', () => {
    settingsRepo.ensureDefaults(USER_ID);
    settingsRepo.update(USER_ID, { default_visibility: 'free_busy' });
    const eventRepo = new EventRepository(db);
    const event = eventRepo.create({
      user_id: USER_ID,
      title: 'Secret',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    });
    settingsRepo.setEventVisibility(event.id, 'full');
    expect(service.resolveVisibility(USER_ID, event.id)).toBe('full');
  });

  test('canViewEvent returns true when no settings exist (defaults to full)', () => {
    expect(service.canViewEvent(USER_ID, 1)).toBe(true);
  });

  test('canViewEvent returns true for free_busy or full', () => {
    settingsRepo.ensureDefaults(USER_ID);
    settingsRepo.update(USER_ID, { default_visibility: 'full' });
    expect(service.canViewEvent(USER_ID, 999)).toBe(true);
  });

  test('isFreeBusyOnly returns true for free_busy', () => {
    settingsRepo.ensureDefaults(USER_ID);
    settingsRepo.update(USER_ID, { default_visibility: 'free_busy' });
    expect(service.isFreeBusyOnly(USER_ID, 999)).toBe(true);
  });

  test('isFreeBusyOnly returns false for full', () => {
    settingsRepo.ensureDefaults(USER_ID);
    settingsRepo.update(USER_ID, { default_visibility: 'full' });
    expect(service.isFreeBusyOnly(USER_ID, 999)).toBe(false);
  });

  test('isFreeBusyOnly returns false when no settings (defaults to full)', () => {
    expect(service.isFreeBusyOnly(USER_ID, 1)).toBe(false);
  });
});
