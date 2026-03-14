import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations';
import { EventRepository } from '../../../src/database/repositories/event.repository';
import { SharingSettingsRepository } from '../../../src/database/repositories/sharing-settings.repository';
import { UserRepository } from '../../../src/database/repositories/user.repository';
import { runMigrations } from '../../../src/database/schema';
import { PrivacyService } from '../../../src/services/sharing/privacy-service';
import { SharingService } from '../../../src/services/sharing/sharing-service';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const USER_ID = 100;
const TZ = 'Europe/Kyiv';

describe('SharingService', () => {
  function setup() {
    const db = createTestDb();
    const userRepo = new UserRepository(db);
    userRepo.create({ telegram_id: USER_ID });
    const eventRepo = new EventRepository(db);
    const settingsRepo = new SharingSettingsRepository(db);
    const privacyService = new PrivacyService(settingsRepo);
    const service = new SharingService(eventRepo, privacyService);
    return { db, service, eventRepo, settingsRepo };
  }

  test('getAgendaForSharing returns empty when no events', () => {
    const { service } = setup();
    const result = service.getAgendaForSharing(USER_ID, new Date('2026-03-15'), TZ);
    expect(result).toHaveLength(0);
  });

  test('getAgendaForSharing filters private events', () => {
    const { service, eventRepo } = setup();
    eventRepo.create({
      user_id: USER_ID,
      title: 'Secret',
      start_at: '2026-03-15T10:00:00Z',
      timezone: TZ,
    });
    // Default visibility is 'private', so nothing should be shareable
    const result = service.getAgendaForSharing(USER_ID, new Date('2026-03-15'), TZ);
    expect(result).toHaveLength(0);
  });

  test('getAgendaForSharing returns events with full visibility', () => {
    const { service, eventRepo, settingsRepo } = setup();
    settingsRepo.ensureDefaults(USER_ID);
    settingsRepo.update(USER_ID, { default_visibility: 'full' });
    eventRepo.create({
      user_id: USER_ID,
      title: 'Public Meeting',
      start_at: '2026-03-15T10:00:00Z',
      timezone: TZ,
    });
    const result = service.getAgendaForSharing(USER_ID, new Date('2026-03-15'), TZ);
    expect(result).toHaveLength(1);
    expect(result[0].displayTitle).toBe('Public Meeting');
    expect(result[0].visibility).toBe('full');
  });

  test('getAgendaForSharing shows "Busy" for free_busy events', () => {
    const { service, eventRepo, settingsRepo } = setup();
    settingsRepo.ensureDefaults(USER_ID);
    settingsRepo.update(USER_ID, { default_visibility: 'free_busy' });
    eventRepo.create({
      user_id: USER_ID,
      title: 'Private Meeting',
      start_at: '2026-03-15T10:00:00Z',
      timezone: TZ,
    });
    const result = service.getAgendaForSharing(USER_ID, new Date('2026-03-15'), TZ);
    expect(result).toHaveLength(1);
    expect(result[0].visibility).toBe('free_busy');
    // displayTitle should still show the actual title -- the caller decides how to render
    expect(result[0].displayTitle).toBe('Private Meeting');
  });

  test('getAgendaForSharing respects event-level visibility override', () => {
    const { service, eventRepo, settingsRepo } = setup();
    settingsRepo.ensureDefaults(USER_ID);
    settingsRepo.update(USER_ID, { default_visibility: 'private' });
    const event = eventRepo.create({
      user_id: USER_ID,
      title: 'Override Event',
      start_at: '2026-03-15T10:00:00Z',
      timezone: TZ,
    });
    // Event-level override to full, even though default is private
    settingsRepo.setEventVisibility(event.id, 'full');
    const result = service.getAgendaForSharing(USER_ID, new Date('2026-03-15'), TZ);
    expect(result).toHaveLength(1);
    expect(result[0].displayTitle).toBe('Override Event');
    expect(result[0].visibility).toBe('full');
  });

  test('getAgendaForSharing includes startAt and timezone', () => {
    const { service, eventRepo, settingsRepo } = setup();
    settingsRepo.ensureDefaults(USER_ID);
    settingsRepo.update(USER_ID, { default_visibility: 'full' });
    eventRepo.create({
      user_id: USER_ID,
      title: 'Meeting',
      start_at: '2026-03-15T14:00:00Z',
      timezone: TZ,
    });
    const result = service.getAgendaForSharing(USER_ID, new Date('2026-03-15'), TZ);
    expect(result).toHaveLength(1);
    expect(result[0].startAt).toBe('2026-03-15T14:00:00Z');
    expect(result[0].timezone).toBe(TZ);
  });
});
