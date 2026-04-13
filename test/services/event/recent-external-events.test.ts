import { describe, expect, test } from 'bun:test';
import type { ActionLogRepository } from '../../../src/database/repositories/action-log.repository.ts';
import type { ParticipantRepository } from '../../../src/database/repositories/participant.repository.ts';
import type { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import type { EventParticipant, User, UserActionLog } from '../../../src/database/types.ts';
import { findMostRecentEventWithExternalParticipants } from '../../../src/services/event/recent-external-events.ts';

function makeActionLogRepo(actions: UserActionLog[]): ActionLogRepository {
  return {
    query: () => actions,
  } as unknown as ActionLogRepository;
}

function makeParticipantRepo(byEvent: { [eventId: number]: EventParticipant[] }): ParticipantRepository {
  return {
    getByEvent: (eventId: number) => byEvent[eventId] ?? [],
  } as unknown as ParticipantRepository;
}

function makeUserRepo(existingIds: number[]): UserRepository {
  const set = new Set(existingIds);
  return {
    findByTelegramId: (id: number) => (set.has(id) ? ({ telegram_id: id } as User) : null),
  } as unknown as UserRepository;
}

function makeAction(eventId: number, userId: number, minutesAgo: number): UserActionLog {
  const created = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  return {
    id: eventId * 10,
    user_id: userId,
    chat_id: userId,
    action_type: 'scene',
    action_name: 'create_event',
    message_id: null,
    chat_history_id: null,
    input_summary: 'Meeting',
    result_summary: `id: ${eventId}`,
    metadata: null,
    target_event_id: eventId,
    target_user_id: null,
    success: 1,
    created_at: created,
  };
}

function makeParticipant(eventId: number, participantUserId: number): EventParticipant {
  return {
    id: eventId * 100 + participantUserId,
    event_id: eventId,
    user_id: participantUserId,
    status: 'pending',
    role: 'attendee',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

const USER_ID = 100;

describe('findMostRecentEventWithExternalParticipants', () => {
  test('returns null when no recent events', () => {
    const result = findMostRecentEventWithExternalParticipants(
      USER_ID,
      makeActionLogRepo([]),
      makeParticipantRepo({}),
      makeUserRepo([]),
    );
    expect(result).toBeNull();
  });

  test('returns event with external participants', () => {
    const action = makeAction(1, USER_ID, 2);
    const externalUserId = 200;

    const result = findMostRecentEventWithExternalParticipants(
      USER_ID,
      makeActionLogRepo([action]),
      makeParticipantRepo({
        1: [makeParticipant(1, USER_ID), makeParticipant(1, externalUserId)],
      }),
      makeUserRepo([USER_ID]), // externalUserId NOT in users table
    );

    expect(result).not.toBeNull();
    expect(result!.eventId).toBe(1);
    expect(result!.externalInviteeIds).toEqual([externalUserId]);
  });

  test('ignores events where all participants are bot users', () => {
    const action = makeAction(1, USER_ID, 2);
    const botUserId = 300;

    const result = findMostRecentEventWithExternalParticipants(
      USER_ID,
      makeActionLogRepo([action]),
      makeParticipantRepo({
        1: [makeParticipant(1, USER_ID), makeParticipant(1, botUserId)],
      }),
      makeUserRepo([USER_ID, botUserId]), // both in users table
    );

    expect(result).toBeNull();
  });

  test('ignores events with no participants besides creator', () => {
    const action = makeAction(1, USER_ID, 2);

    const result = findMostRecentEventWithExternalParticipants(
      USER_ID,
      makeActionLogRepo([action]),
      makeParticipantRepo({
        1: [makeParticipant(1, USER_ID)],
      }),
      makeUserRepo([USER_ID]),
    );

    expect(result).toBeNull();
  });

  test('returns most recent event when multiple exist', () => {
    // Actions are already ordered DESC by repo — first one is most recent
    const action1 = makeAction(1, USER_ID, 8); // 8 minutes ago
    const action2 = makeAction(2, USER_ID, 2); // 2 minutes ago (most recent)

    const result = findMostRecentEventWithExternalParticipants(
      USER_ID,
      makeActionLogRepo([action2, action1]), // DESC order
      makeParticipantRepo({
        1: [makeParticipant(1, 400)],
        2: [makeParticipant(2, 500)],
      }),
      makeUserRepo([USER_ID]),
    );

    expect(result).not.toBeNull();
    expect(result!.eventId).toBe(2);
    expect(result!.externalInviteeIds).toEqual([500]);
  });

  test('skips action without target_event_id', () => {
    const action: UserActionLog = {
      id: 10,
      user_id: USER_ID,
      chat_id: USER_ID,
      action_type: 'scene',
      action_name: 'create_event',
      message_id: null,
      chat_history_id: null,
      input_summary: 'Meeting',
      result_summary: null,
      metadata: null,
      target_event_id: null,
      target_user_id: null,
      success: 1,
      created_at: new Date().toISOString(),
    };

    const result = findMostRecentEventWithExternalParticipants(
      USER_ID,
      makeActionLogRepo([action]),
      makeParticipantRepo({}),
      makeUserRepo([USER_ID]),
    );

    expect(result).toBeNull();
  });

  test('returns multiple external invitee IDs', () => {
    const action = makeAction(1, USER_ID, 1);
    const ext1 = 600;
    const ext2 = 700;

    const result = findMostRecentEventWithExternalParticipants(
      USER_ID,
      makeActionLogRepo([action]),
      makeParticipantRepo({
        1: [makeParticipant(1, USER_ID), makeParticipant(1, ext1), makeParticipant(1, ext2)],
      }),
      makeUserRepo([USER_ID]),
    );

    expect(result).not.toBeNull();
    expect(result!.eventId).toBe(1);
    expect(result!.externalInviteeIds).toEqual([ext1, ext2]);
  });
});
