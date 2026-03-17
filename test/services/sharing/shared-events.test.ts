import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { ParticipantRepository } from '../../../src/database/repositories/participant.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

const CREATOR = 100;
const INVITEE = 200;

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('visible events (owned + participated)', () => {
  let db: Database;
  let eventRepo: EventRepository;
  let participantRepo: ParticipantRepository;

  beforeEach(() => {
    db = createTestDb();
    const userRepo = new UserRepository(db);
    eventRepo = new EventRepository(db);
    participantRepo = new ParticipantRepository(db);
    userRepo.create({ telegram_id: CREATOR, timezone: 'UTC' });
    userRepo.create({ telegram_id: INVITEE, timezone: 'UTC' });
  });

  test('getVisibleInRange returns own events', () => {
    eventRepo.create({
      user_id: INVITEE,
      title: 'My Event',
      start_at: '2026-03-20T10:00:00Z',
      timezone: 'UTC',
    });
    const events = eventRepo.getVisibleInRange(INVITEE, '2026-03-20T00:00:00Z', '2026-03-21T00:00:00Z');
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('My Event');
  });

  test('getVisibleInRange returns accepted participated events', () => {
    const event = eventRepo.create({
      user_id: CREATOR,
      title: 'Shared Meeting',
      start_at: '2026-03-20T10:00:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(event.id, INVITEE, 'accepted');

    const events = eventRepo.getVisibleInRange(INVITEE, '2026-03-20T00:00:00Z', '2026-03-21T00:00:00Z');
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('Shared Meeting');
  });

  test('getVisibleInRange excludes declined participated events', () => {
    const event = eventRepo.create({
      user_id: CREATOR,
      title: 'Declined',
      start_at: '2026-03-20T10:00:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(event.id, INVITEE, 'declined');

    const events = eventRepo.getVisibleInRange(INVITEE, '2026-03-20T00:00:00Z', '2026-03-21T00:00:00Z');
    expect(events).toHaveLength(0);
  });

  test('getVisibleInRange does not duplicate if user is both owner and participant', () => {
    const event = eventRepo.create({
      user_id: CREATOR,
      title: 'Own',
      start_at: '2026-03-20T10:00:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(event.id, CREATOR, 'accepted', 'organizer');

    const events = eventRepo.getVisibleInRange(CREATOR, '2026-03-20T00:00:00Z', '2026-03-21T00:00:00Z');
    expect(events).toHaveLength(1);
  });

  test('getVisibleInRange shows mix of own and shared events sorted by time', () => {
    eventRepo.create({
      user_id: INVITEE,
      title: 'Own Event',
      start_at: '2026-03-20T09:00:00Z',
      timezone: 'UTC',
    });
    const shared = eventRepo.create({
      user_id: CREATOR,
      title: 'Shared Event',
      start_at: '2026-03-20T14:00:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(shared.id, INVITEE, 'accepted');

    const events = eventRepo.getVisibleInRange(INVITEE, '2026-03-20T00:00:00Z', '2026-03-21T00:00:00Z');
    expect(events).toHaveLength(2);
    expect(events[0].title).toBe('Own Event');
    expect(events[1].title).toBe('Shared Event');
  });

  test('getVisibleInRange excludes maybe status', () => {
    const event = eventRepo.create({
      user_id: CREATOR,
      title: 'Maybe Event',
      start_at: '2026-03-20T10:00:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(event.id, INVITEE, 'maybe');

    const events = eventRepo.getVisibleInRange(INVITEE, '2026-03-20T00:00:00Z', '2026-03-21T00:00:00Z');
    expect(events).toHaveLength(0);
  });

  test('isParticipant returns true for accepted participant', () => {
    const event = eventRepo.create({
      user_id: CREATOR,
      title: 'Shared',
      start_at: '2026-03-20T10:00:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(event.id, INVITEE, 'accepted');
    expect(eventRepo.isParticipant(event.id, INVITEE)).toBe(true);
  });

  test('isParticipant returns false for non-participant', () => {
    const event = eventRepo.create({
      user_id: CREATOR,
      title: 'Private',
      start_at: '2026-03-20T10:00:00Z',
      timezone: 'UTC',
    });
    expect(eventRepo.isParticipant(event.id, INVITEE)).toBe(false);
  });

  test('isParticipant returns false for declined', () => {
    const event = eventRepo.create({
      user_id: CREATOR,
      title: 'Declined',
      start_at: '2026-03-20T10:00:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(event.id, INVITEE, 'declined');
    expect(eventRepo.isParticipant(event.id, INVITEE)).toBe(false);
  });
});
