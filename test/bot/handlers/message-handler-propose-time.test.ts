// test/bot/handlers/message-handler-propose-time.test.ts
import { Database } from 'bun:sqlite';
import { describe, expect, mock, test } from 'bun:test';
import { createMessageHandler } from '../../../src/bot/handlers/message.handler';
import { t } from '../../../src/config/constants.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { SharingSettingsRepository } from '../../../src/database/repositories/sharing-settings.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { InvitationService } from '../../../src/services/sharing/invitation-service.ts';

function makeUser(overrides = {}) {
  return { telegram_id: 200, language: 'en', timezone: 'UTC', ...overrides };
}

function makeCtx(text: string, userId = 200) {
  return {
    text,
    dbUser: makeUser({ telegram_id: userId }),
    chatId: userId,
    send: mock(() => Promise.resolve()),
    chat: { type: 'private' },
  };
}

describe('message handler: propose time session', () => {
  test('handles text input when proposeTimeSession exists', async () => {
    const proposeTimeSessions = new Map<number, { invitationId: number }>();
    proposeTimeSessions.set(200, { invitationId: 5 });

    const inv = {
      id: 5,
      invitee_id: 200,
      inviter_id: 100,
      event_id: 3,
      status: 'pending',
      proposed_time: null,
      message_id: 42,
      chat_id: 200,
    };
    const invitationService = {
      proposeTime: mock(() => ({ success: true, invitation: { ...inv, proposed_time: '2026-04-01T15:00:00Z' } })),
    };
    const invitationRepo = { findById: mock(() => inv) };
    const editMessage = mock(() => Promise.resolve());
    const sendMessage = mock(() => Promise.resolve());

    const handler = createMessageHandler({
      agent: { run: mock(() => Promise.resolve({ responseText: '' })) } as never,
      eventService: { getEventsInRange: mock(() => []) } as never,
      holidayService: {} as never,
      chatHistory: { save: mock(() => {}), getLast: mock(() => []) } as never,
      userRepo: { findByTelegramId: mock(() => makeUser({ telegram_id: 100 })) } as never,
      eventReminderRepo: {} as never,
      sceneStorage: { get: mock(() => Promise.resolve(null)), delete: mock(() => {}) },
      proposeTimeSessions,
      invitationService: invitationService as never,
      invitationRepo: invitationRepo as never,
      editMessage,
      sendMessageToUser: sendMessage,
      conversationLogger: null as never,
    });

    const ctx = makeCtx('tomorrow 15:00');
    await handler(ctx as never);

    expect(invitationService.proposeTime).toHaveBeenCalledWith(5, 200, expect.any(String));
    expect(proposeTimeSessions.has(200)).toBe(false); // session cleared
    expect(editMessage).toHaveBeenCalled(); // original invite message edited
  });

  test('notifies inviter after successful text time input', async () => {
    const proposeTimeSessions = new Map<number, { invitationId: number }>();
    proposeTimeSessions.set(200, { invitationId: 5 });

    const inv = {
      id: 5,
      invitee_id: 200,
      inviter_id: 100,
      event_id: 3,
      status: 'pending',
      proposed_time: null,
      message_id: 42,
      chat_id: 200,
    };
    const invitationService = {
      proposeTime: mock(() => ({ success: true, invitation: { ...inv, proposed_time: '2026-04-01T15:00:00Z' } })),
    };
    const invitationRepo = { findById: mock(() => inv) };
    const notifyInviterProposal = mock(() => Promise.resolve());

    const handler = createMessageHandler({
      agent: { run: mock(() => Promise.resolve({ responseText: '' })) } as never,
      eventService: { getEvent: mock(() => ({ title: 'Party' })) } as never,
      holidayService: {} as never,
      chatHistory: { save: mock(() => {}), getLast: mock(() => []) } as never,
      userRepo: {} as never,
      eventReminderRepo: {} as never,
      sceneStorage: { get: mock(() => Promise.resolve(null)), delete: mock(() => {}) },
      proposeTimeSessions,
      invitationService: invitationService as never,
      invitationRepo: invitationRepo as never,
      notifyInviterProposal,
      conversationLogger: null as never,
    });

    const ctx = makeCtx('tomorrow 15:00');
    await handler(ctx as never);

    expect(notifyInviterProposal).toHaveBeenCalledWith(5, expect.any(Object), expect.any(String), 'Party');
  });

  test('re-asks on invalid time input', async () => {
    const proposeTimeSessions = new Map<number, { invitationId: number }>();
    proposeTimeSessions.set(200, { invitationId: 5 });

    const ctx = makeCtx('not a time at all');
    const handler = createMessageHandler({
      agent: { run: mock(() => Promise.resolve({ responseText: '' })) } as never,
      eventService: { getEventsInRange: mock(() => []) } as never,
      holidayService: {} as never,
      chatHistory: { save: mock(() => {}), getLast: mock(() => []) } as never,
      userRepo: {} as never,
      eventReminderRepo: {} as never,
      sceneStorage: { get: mock(() => Promise.resolve(null)), delete: mock(() => {}) },
      proposeTimeSessions,
      conversationLogger: null as never,
    });

    await handler(ctx as never);
    expect(ctx.send).toHaveBeenCalled(); // error message sent
    expect(proposeTimeSessions.has(200)).toBe(true); // session kept for retry
  });

  test('ignores propose-time session in group chats', async () => {
    const proposeTimeSessions = new Map<number, { invitationId: number }>();
    proposeTimeSessions.set(200, { invitationId: 5 });
    const invitationService = { proposeTime: mock(() => ({ success: true })) };

    const handler = createMessageHandler({
      agent: { run: mock(() => Promise.resolve({ responseText: '' })) } as never,
      eventService: { getEventsInRange: mock(() => []) } as never,
      holidayService: {} as never,
      chatHistory: { save: mock(() => {}), getLast: mock(() => []) } as never,
      userRepo: {} as never,
      eventReminderRepo: {} as never,
      sceneStorage: { get: mock(() => Promise.resolve(null)), delete: mock(() => {}) },
      proposeTimeSessions,
      invitationService: invitationService as never,
      conversationLogger: null as never,
    });

    const ctx = {
      text: 'tomorrow 15:00',
      dbUser: makeUser({ telegram_id: 200 }),
      chatId: 999,
      send: mock(() => Promise.resolve()),
      chat: { type: 'group', title: 'Team' },
    };
    await handler(ctx as never);

    expect(invitationService.proposeTime).not.toHaveBeenCalled();
    expect(proposeTimeSessions.has(200)).toBe(true); // session NOT consumed
  });

  test('a typed time for a cancelled invitation is refused and says so', async () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    const users = new UserRepository(db);
    users.create({ telegram_id: 100, timezone: 'UTC', language: 'en' });
    users.create({ telegram_id: 200, timezone: 'UTC', language: 'en' });
    const eventRepo = new EventRepository(db);
    const invitationRepo = new InvitationRepository(db);
    const invitationService = new InvitationService(invitationRepo, eventRepo, new SharingSettingsRepository(db));
    const event = eventRepo.create({
      user_id: 100,
      title: 'Fixture meetup',
      start_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      timezone: 'UTC',
    });
    const invitation = invitationService.sendInvitation(event.id, 100, 200).invitation!;
    invitationService.cancelInvitation(invitation.id, 100);
    const proposeTimeSessions = new Map<number, { invitationId: number }>();
    proposeTimeSessions.set(200, { invitationId: invitation.id });
    const notifyInviterProposal = mock(() => Promise.resolve());

    const handler = createMessageHandler({
      agent: { run: mock(() => Promise.resolve({ responseText: '' })) } as never,
      eventService: { getEventsInRange: mock(() => []) } as never,
      holidayService: {} as never,
      chatHistory: { save: mock(() => {}), getLast: mock(() => []) } as never,
      userRepo: users,
      eventReminderRepo: {} as never,
      sceneStorage: { get: mock(() => Promise.resolve(null)), delete: mock(() => {}) },
      proposeTimeSessions,
      invitationService,
      invitationRepo,
      notifyInviterProposal,
      conversationLogger: null as never,
    });

    const ctx = makeCtx('tomorrow 15:00');
    await handler(ctx as never);

    expect(invitationRepo.findById(invitation.id)!.proposed_time).toBeNull();
    expect(ctx.send).toHaveBeenCalledWith(t('en').invitation_cancelled);
    expect(notifyInviterProposal).not.toHaveBeenCalled();
  });
});
