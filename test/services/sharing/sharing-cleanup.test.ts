// test/services/sharing/sharing-cleanup.test.ts
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations';
import { DeepLinkRepository } from '../../../src/database/repositories/deep-link.repository';
import { EventRepository } from '../../../src/database/repositories/event.repository';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository';
import { UserRepository } from '../../../src/database/repositories/user.repository';
import { runMigrations } from '../../../src/database/schema';
import { runSharingCleanup } from '../../../src/services/sharing/sharing-cleanup';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const USER_A = 100;
const USER_B = 200;

describe('runSharingCleanup', () => {
  test('expires past invitations', () => {
    const db = createTestDb();
    const users = new UserRepository(db);
    const events = new EventRepository(db);
    const invitations = new InvitationRepository(db);
    const deepLinks = new DeepLinkRepository(db);

    users.create({ telegram_id: USER_A });
    users.create({ telegram_id: USER_B });

    const event = events.create({
      user_id: USER_A,
      title: 'Past Event',
      start_at: '2020-01-01T10:00:00Z',
      end_at: '2020-01-01T11:00:00Z',
      timezone: 'UTC',
    });

    invitations.create({ event_id: event.id, inviter_id: USER_A, invitee_id: USER_B });

    const result = runSharingCleanup({ invitationRepo: invitations, deepLinkRepo: deepLinks });

    expect(result.expiredInvitations).toBe(1);
    expect(invitations.findById(1)!.status).toBe('expired');
  });

  test('deletes expired deep links', () => {
    const db = createTestDb();
    const users = new UserRepository(db);
    const invitations = new InvitationRepository(db);
    const deepLinks = new DeepLinkRepository(db);

    users.create({ telegram_id: USER_A });

    deepLinks.create({
      code: 's_expired1',
      type: 'shared_event',
      payload: '{"event_id":1}',
      created_by: USER_A,
      expires_at: '2020-01-01T00:00:00Z',
    });

    deepLinks.create({
      code: 's_valid1',
      type: 'shared_event',
      payload: '{"event_id":2}',
      created_by: USER_A,
      expires_at: '2099-01-01T00:00:00Z',
    });

    const result = runSharingCleanup({ invitationRepo: invitations, deepLinkRepo: deepLinks });

    expect(result.deletedDeepLinks).toBe(1);
    expect(deepLinks.findByCode('s_expired1')).toBeNull();
    expect(deepLinks.findByCode('s_valid1')).not.toBeNull();
  });

  test('returns zero counts when nothing to clean', () => {
    const db = createTestDb();
    const invitations = new InvitationRepository(db);
    const deepLinks = new DeepLinkRepository(db);

    const result = runSharingCleanup({ invitationRepo: invitations, deepLinkRepo: deepLinks });

    expect(result.expiredInvitations).toBe(0);
    expect(result.deletedDeepLinks).toBe(0);
    expect(result.cleanedSessions).toBe(0);
  });

  test('handles errors gracefully', () => {
    const db = createTestDb();
    const invitations = new InvitationRepository(db);
    const deepLinks = new DeepLinkRepository(db);

    db.close();

    const result = runSharingCleanup({ invitationRepo: invitations, deepLinkRepo: deepLinks });

    expect(result.expiredInvitations).toBe(0);
    expect(result.deletedDeepLinks).toBe(0);
    expect(result.cleanedSessions).toBe(0);
  });
});
