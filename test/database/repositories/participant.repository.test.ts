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

describe('ParticipantRepository', () => {
  let db: Database;
  let participantRepo: ParticipantRepository;
  let eventRepo: EventRepository;
  let eventId: number;

  beforeEach(() => {
    db = createTestDb();
    const userRepo = new UserRepository(db);
    eventRepo = new EventRepository(db);
    participantRepo = new ParticipantRepository(db);
    userRepo.create({ telegram_id: CREATOR, timezone: 'UTC' });
    userRepo.create({ telegram_id: INVITEE, timezone: 'UTC' });
    eventId = eventRepo.create({
      user_id: CREATOR,
      title: 'Team Sync',
      start_at: '2026-03-20T10:00:00Z',
      timezone: 'UTC',
    }).id;
  });

  test('add creates participant with default role', () => {
    const p = participantRepo.add(eventId, INVITEE, 'accepted');
    expect(p.event_id).toBe(eventId);
    expect(p.user_id).toBe(INVITEE);
    expect(p.status).toBe('accepted');
    expect(p.role).toBe('attendee');
  });

  test('add with organizer role', () => {
    const p = participantRepo.add(eventId, CREATOR, 'accepted', 'organizer');
    expect(p.role).toBe('organizer');
  });

  test('findByEventAndUser returns participant', () => {
    participantRepo.add(eventId, INVITEE, 'accepted');
    const p = participantRepo.findByEventAndUser(eventId, INVITEE);
    expect(p).not.toBeNull();
    expect(p!.status).toBe('accepted');
  });

  test('findByEventAndUser returns null when not found', () => {
    expect(participantRepo.findByEventAndUser(eventId, 999)).toBeNull();
  });

  test('getByEvent returns all participants', () => {
    const userRepo = new UserRepository(db);
    userRepo.create({ telegram_id: 300, timezone: 'UTC' });
    participantRepo.add(eventId, INVITEE, 'accepted');
    participantRepo.add(eventId, 300, 'pending');
    const all = participantRepo.getByEvent(eventId);
    expect(all).toHaveLength(2);
  });

  test('getAcceptedEventIds returns event ids for accepted participations', () => {
    participantRepo.add(eventId, INVITEE, 'accepted');
    const ids = participantRepo.getAcceptedEventIds(INVITEE);
    expect(ids).toContain(eventId);
  });

  test('getAcceptedEventIds excludes declined', () => {
    participantRepo.add(eventId, INVITEE, 'declined');
    const ids = participantRepo.getAcceptedEventIds(INVITEE);
    expect(ids).not.toContain(eventId);
  });

  test('updateStatus changes status', () => {
    participantRepo.add(eventId, INVITEE, 'accepted');
    participantRepo.updateStatus(eventId, INVITEE, 'declined');
    const p = participantRepo.findByEventAndUser(eventId, INVITEE);
    expect(p!.status).toBe('declined');
  });

  test('delete removes participant', () => {
    participantRepo.add(eventId, INVITEE, 'accepted');
    participantRepo.delete(eventId, INVITEE);
    expect(participantRepo.findByEventAndUser(eventId, INVITEE)).toBeNull();
  });

  test('cascade: deleting event removes participants', () => {
    participantRepo.add(eventId, INVITEE, 'accepted');
    eventRepo.remove(eventId, CREATOR);
    expect(participantRepo.getByEvent(eventId)).toHaveLength(0);
  });

  test('unique constraint: cannot add same user to same event twice', () => {
    participantRepo.add(eventId, INVITEE, 'accepted');
    expect(() => participantRepo.add(eventId, INVITEE, 'pending')).toThrow();
  });
});
