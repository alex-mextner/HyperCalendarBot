import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { ParticipantRepository } from '../../../src/database/repositories/participant.repository.ts';
import { ReminderRepository } from '../../../src/database/repositories/reminder.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { ConflictChecker } from '../../../src/services/event/conflict-checker.ts';
import { EventService } from '../../../src/services/event/event-service.ts';

const USER = 100;
const OTHER = 200;

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('ConflictChecker', () => {
  let db: Database;
  let eventRepo: EventRepository;
  let participantRepo: ParticipantRepository;
  let eventService: EventService;
  let checker: ConflictChecker;

  beforeEach(() => {
    db = createTestDb();
    const userRepo = new UserRepository(db);
    eventRepo = new EventRepository(db);
    participantRepo = new ParticipantRepository(db);
    const reminderRepo = new ReminderRepository(db);
    eventService = new EventService({ eventRepo, reminderRepo });
    checker = new ConflictChecker(eventRepo);
    userRepo.create({ telegram_id: USER, timezone: 'UTC' });
    userRepo.create({ telegram_id: OTHER, timezone: 'UTC' });
  });

  test('detects overlapping events', () => {
    eventService.createEvent({
      user_id: USER,
      title: 'Meeting A',
      start_at: '2026-03-20T10:00:00Z',
      end_at: '2026-03-20T11:00:00Z',
      timezone: 'UTC',
    });
    const eventB = eventService.createEvent({
      user_id: USER,
      title: 'Meeting B',
      start_at: '2026-03-20T10:30:00Z',
      end_at: '2026-03-20T11:30:00Z',
      timezone: 'UTC',
    });

    const conflicts = checker.checkConflicts(eventB, USER);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.title).toBe('Meeting A');
  });

  test('adjacent events do not conflict', () => {
    eventService.createEvent({
      user_id: USER,
      title: 'Meeting A',
      start_at: '2026-03-20T10:00:00Z',
      end_at: '2026-03-20T11:00:00Z',
      timezone: 'UTC',
    });
    const eventB = eventService.createEvent({
      user_id: USER,
      title: 'Meeting B',
      start_at: '2026-03-20T11:00:00Z',
      end_at: '2026-03-20T12:00:00Z',
      timezone: 'UTC',
    });

    const conflicts = checker.checkConflicts(eventB, USER);
    expect(conflicts).toHaveLength(0);
  });

  test('all-day events do not conflict', () => {
    eventService.createEvent({
      user_id: USER,
      title: 'All Day',
      start_at: '2026-03-20T00:00:00Z',
      all_day: true,
      timezone: 'UTC',
    });
    const eventB = eventService.createEvent({
      user_id: USER,
      title: 'Meeting',
      start_at: '2026-03-20T10:00:00Z',
      end_at: '2026-03-20T11:00:00Z',
      timezone: 'UTC',
    });

    const conflicts = checker.checkConflicts(eventB, USER);
    expect(conflicts).toHaveLength(0);
  });

  test('point event gets 30min default duration for conflict check', () => {
    eventService.createEvent({
      user_id: USER,
      title: 'Existing',
      start_at: '2026-03-20T10:00:00Z',
      end_at: '2026-03-20T11:00:00Z',
      timezone: 'UTC',
    });
    // Point event at 10:15 — within the 30min window overlaps with Existing
    const point = eventService.createEvent({
      user_id: USER,
      title: 'Quick Note',
      start_at: '2026-03-20T10:15:00Z',
      timezone: 'UTC',
    });

    const conflicts = checker.checkConflicts(point, USER);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.title).toBe('Existing');
  });

  test('excludes event itself from conflicts', () => {
    const event = eventService.createEvent({
      user_id: USER,
      title: 'Solo',
      start_at: '2026-03-20T10:00:00Z',
      end_at: '2026-03-20T11:00:00Z',
      timezone: 'UTC',
    });

    const conflicts = checker.checkConflicts(event, USER);
    expect(conflicts).toHaveLength(0);
  });

  test('detects conflicts with participated events', () => {
    const shared = eventService.createEvent({
      user_id: OTHER,
      title: 'Shared Meeting',
      start_at: '2026-03-20T10:00:00Z',
      end_at: '2026-03-20T11:00:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(shared.id, USER, 'accepted');

    const own = eventService.createEvent({
      user_id: USER,
      title: 'My Meeting',
      start_at: '2026-03-20T10:30:00Z',
      end_at: '2026-03-20T11:30:00Z',
      timezone: 'UTC',
    });

    const conflicts = checker.checkConflicts(own, USER);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.title).toBe('Shared Meeting');
  });

  test('no conflicts when events are far apart', () => {
    eventService.createEvent({
      user_id: USER,
      title: 'Morning',
      start_at: '2026-03-20T09:00:00Z',
      end_at: '2026-03-20T10:00:00Z',
      timezone: 'UTC',
    });
    const afternoon = eventService.createEvent({
      user_id: USER,
      title: 'Afternoon',
      start_at: '2026-03-20T14:00:00Z',
      end_at: '2026-03-20T15:00:00Z',
      timezone: 'UTC',
    });

    const conflicts = checker.checkConflicts(afternoon, USER);
    expect(conflicts).toHaveLength(0);
  });
});
