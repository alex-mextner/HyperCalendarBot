// test/bot/handlers/message-handler-propose-time.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { createMessageHandler } from '../../../src/bot/handlers/message.handler';

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
      reminderRepo: {} as never,
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
      reminderRepo: {} as never,
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
      reminderRepo: {} as never,
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
      reminderRepo: {} as never,
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
});
