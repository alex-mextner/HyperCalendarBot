import { Database } from 'bun:sqlite';
import { beforeEach, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { BirthdayMetadataRepository } from '../../../src/database/repositories/birthday-metadata.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { BirthdayService } from '../../../src/services/birthday/birthday-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

let db: Database;
let service: BirthdayService;

beforeEach(() => {
  db = createTestDb();
  const userRepo = new UserRepository(db);
  userRepo.create({ telegram_id: 1, first_name: 'Alice', language: 'ru', timezone: 'UTC' });
  userRepo.create({ telegram_id: 42, first_name: 'Ivan', username: 'ivan_t', language: 'ru', timezone: 'UTC' });

  service = new BirthdayService(
    new EventRepository(db),
    new BirthdayMetadataRepository(db),
    new EventReminderRepository(db),
    new NotificationPreferencesRepository(db),
  );
});

test('getDisplayTitle RU with birth_year uses ruPlural for age', () => {
  expect(service.getDisplayTitle('Д/р Иван', 1996, new Date('2026-05-10'), 'ru')).toBe('🎁 Д/р Иван — 30 лет');
  expect(service.getDisplayTitle('Д/р Иван', 1995, new Date('2026-05-10'), 'ru')).toBe('🎁 Д/р Иван — 31 год');
  expect(service.getDisplayTitle('Д/р Иван', 2004, new Date('2026-05-10'), 'ru')).toBe('🎁 Д/р Иван — 22 года');
});

test('getDisplayTitle EN with birth_year', () => {
  expect(service.getDisplayTitle('Bday Ivan', 1996, new Date('2026-05-10'), 'en')).toBe('🎁 Bday Ivan — turns 30');
});

test('getDisplayTitle without birth_year omits age', () => {
  expect(service.getDisplayTitle('Д/р Иван', null, new Date('2026-05-10'), 'ru')).toBe('🎁 Д/р Иван');
});

test('upsertBirthdayEvent creates event with correct fields and reminders', () => {
  service.upsertBirthdayEvent({
    ownerId: 1,
    celebrantId: 42,
    celebrantName: 'Иван',
    day: 10,
    month: 5,
    year: 1996,
    lang: 'ru',
    timezone: 'UTC',
    autoCreated: true,
  });

  const events = db.prepare("SELECT * FROM events WHERE event_type = 'birthday'").all() as {
    title: string;
    recurrence_rule: string;
    all_day: number;
  }[];
  expect(events.length).toBe(1);
  expect(events[0]!.title).toBe('Д/р Иван');
  expect(events[0]!.recurrence_rule).toBe('FREQ=YEARLY');
  expect(events[0]!.all_day).toBe(1);

  const reminders = db.prepare('SELECT * FROM event_reminders').all();
  expect(reminders.length).toBeGreaterThanOrEqual(1);
});

test('shouldSkipSync returns true when recently synced', () => {
  const metaRepo = new BirthdayMetadataRepository(db);
  metaRepo.upsertSyncState(1, new Date().toISOString());
  expect(service.shouldSkipSync(1)).toBe(true);
});

test('shouldSkipSync returns false when never synced', () => {
  expect(service.shouldSkipSync(1)).toBe(false);
});

test('findExistingBirthday returns existing personal calendar entry', () => {
  service.upsertBirthdayEvent({
    ownerId: 1,
    celebrantId: 42,
    celebrantName: 'Иван',
    day: 10,
    month: 5,
    year: null,
    lang: 'ru',
    timezone: 'UTC',
    autoCreated: false,
  });
  const result = service.findExistingBirthday(42, 1);
  expect(result).not.toBeNull();
  expect(result!.celebrant_id).toBe(42);
});

test('getBirthdaysForDisplay returns personal entries sorted by next occurrence', () => {
  service.upsertBirthdayEvent({
    ownerId: 1,
    celebrantId: 42,
    celebrantName: 'Иван',
    day: 10,
    month: 5,
    year: null,
    lang: 'ru',
    timezone: 'UTC',
    autoCreated: false,
  });
  const { personal } = service.getBirthdaysForDisplay(1, []);
  expect(personal.length).toBe(1);
  expect(personal[0]!.event.title).toBe('Д/р Иван');
});
