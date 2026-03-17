import { describe, expect, mock, test } from 'bun:test';
import { createCallbackHandler } from '../../../src/bot/handlers/callback.handler';

function makeCtx(data: string, language = 'en') {
  return {
    data,
    dbUser: { telegram_id: 200, language, timezone: 'UTC' },
    answer: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
  };
}

function makeHandler(invitationService: Record<string, unknown>) {
  return createCallbackHandler(
    {} as never, // eventService
    {} as never, // editValueScene
    {} as never, // holidayService
    {} as never, // prefsService
    undefined, // calendarRepo
    undefined, // disconnectDeps
    undefined, // onCalendarsDone
    undefined, // renderService
    invitationService as never, // invitationService
  );
}

describe('invitation callbacks', () => {
  test('accept callback calls acceptInvitation', async () => {
    const invitationService = {
      acceptInvitation: mock(() => ({
        success: true,
        invitation: { id: 1, status: 'accepted', event_id: 5 },
      })),
    };

    const ctx = makeCtx('inv:accept:1');
    const handler = makeHandler(invitationService);

    await handler(ctx as never);
    expect(invitationService.acceptInvitation).toHaveBeenCalledWith(1, 200);
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
  });

  test('decline callback calls declineInvitation', async () => {
    const invitationService = {
      declineInvitation: mock(() => ({
        success: true,
        invitation: { id: 1, status: 'declined' },
      })),
    };

    const ctx = makeCtx('inv:decline:1');
    const handler = makeHandler(invitationService);

    await handler(ctx as never);
    expect(invitationService.declineInvitation).toHaveBeenCalledWith(1, 200);
    expect(ctx.answer).toHaveBeenCalled();
  });

  test('maybe callback calls maybeInvitation', async () => {
    const invitationService = {
      maybeInvitation: mock(() => ({
        success: true,
        invitation: { id: 1, status: 'maybe' },
      })),
    };

    const ctx = makeCtx('inv:maybe:1');
    const handler = makeHandler(invitationService);

    await handler(ctx as never);
    expect(invitationService.maybeInvitation).toHaveBeenCalledWith(1, 200);
    expect(ctx.answer).toHaveBeenCalled();
  });

  test('keep callback acknowledges without calling service', async () => {
    const invitationService = {
      acceptInvitation: mock(() => ({ success: true })),
    };

    const ctx = makeCtx('inv:keep:1');
    const handler = makeHandler(invitationService);

    await handler(ctx as never);
    expect(invitationService.acceptInvitation).not.toHaveBeenCalled();
    expect(ctx.answer).toHaveBeenCalled();
  });

  test('failed invitation shows error', async () => {
    const invitationService = {
      acceptInvitation: mock(() => ({
        success: false,
        error: 'Invitation not found',
      })),
    };

    const ctx = makeCtx('inv:accept:999');
    const handler = makeHandler(invitationService);

    await handler(ctx as never);
    expect(invitationService.acceptInvitation).toHaveBeenCalledWith(999, 200);
    expect(ctx.answer).toHaveBeenCalledWith('Invitation not found');
  });

  test('accept callback uses Russian text for ru user', async () => {
    const invitationService = {
      acceptInvitation: mock(() => ({
        success: true,
        invitation: { id: 2, status: 'accepted' },
      })),
    };

    const ctx = makeCtx('inv:accept:2', 'ru');
    const handler = makeHandler(invitationService);

    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
    const answerCall = (ctx.answer as ReturnType<typeof mock>).mock.calls[0];
    // Russian text contains specific characters
    expect(answerCall[0]).toContain('принято');
  });
});

describe('inviter notification on response', () => {
  function makeHandlerWithNotify(
    invitationService: Record<string, unknown>,
    notifyDeps: { userRepo: Record<string, unknown>; sendMessage: ReturnType<typeof mock> },
    eventRepo?: Record<string, unknown>,
  ) {
    return createCallbackHandler(
      {} as never, // eventService
      {} as never, // editValueScene
      {} as never, // holidayService
      {} as never, // prefsService
      undefined, // calendarRepo
      undefined, // disconnectDeps
      undefined, // onCalendarsDone
      undefined, // renderService
      invitationService as never, // invitationService
      undefined, // groupChatRepo
      eventRepo as never, // eventRepo
      undefined, // chatHistoryRepo
      undefined, // onAiButtonClick
      undefined, // oauthDeps
      notifyDeps as never, // invitationNotifyDeps
    );
  }

  test('notifies inviter when invitation is accepted', async () => {
    const sendMessage = mock(() => Promise.resolve());
    const invitationService = {
      acceptInvitation: mock(() => ({
        success: true,
        invitation: { id: 1, status: 'accepted', event_id: 5, inviter_id: 100, invitee_id: 200 },
      })),
    };
    const userRepo = {
      findByTelegramId: mock(() => ({ telegram_id: 100, first_name: 'Sender', language: 'en' })),
    };
    const eventRepo = {
      findById: mock(() => ({ title: 'Party', start_at: '2026-03-15T18:00:00Z' })),
    };

    const ctx = makeCtx('inv:accept:1');
    const handler = makeHandlerWithNotify(invitationService, { userRepo, sendMessage }, eventRepo);

    await handler(ctx as never);

    // Wait for async notification
    await new Promise((r) => setTimeout(r, 50));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessage.mock.calls[0] as [number, string, unknown];
    expect(chatId).toBe(100);
    expect(text).toContain('Party');
    expect(text).toContain('accepted');
    expect(text).toContain('✅');
  });

  test('notifies inviter when invitation is declined', async () => {
    const sendMessage = mock(() => Promise.resolve());
    const invitationService = {
      declineInvitation: mock(() => ({
        success: true,
        invitation: { id: 1, status: 'declined', event_id: 5, inviter_id: 100, invitee_id: 200 },
      })),
    };
    const userRepo = {
      findByTelegramId: mock(() => ({ telegram_id: 100, first_name: 'Sender', language: 'en' })),
    };
    const eventRepo = {
      findById: mock(() => ({ title: 'Meeting', start_at: '2026-03-15T10:00:00Z' })),
    };

    const ctx = makeCtx('inv:decline:1');
    const handler = makeHandlerWithNotify(invitationService, { userRepo, sendMessage }, eventRepo);

    await handler(ctx as never);
    await new Promise((r) => setTimeout(r, 50));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessage.mock.calls[0] as [number, string, unknown];
    expect(chatId).toBe(100);
    expect(text).toContain('declined');
    expect(text).toContain('❌');
  });

  test('notifies inviter in their language', async () => {
    const sendMessage = mock(() => Promise.resolve());
    const invitationService = {
      acceptInvitation: mock(() => ({
        success: true,
        invitation: { id: 1, status: 'accepted', event_id: 5, inviter_id: 100, invitee_id: 200 },
      })),
    };
    const userRepo = {
      findByTelegramId: mock(() => ({ telegram_id: 100, first_name: 'Отправитель', language: 'ru' })),
    };
    const eventRepo = {
      findById: mock(() => ({ title: 'Встреча', start_at: '2026-03-15T10:00:00Z' })),
    };

    const ctx = makeCtx('inv:accept:1');
    const handler = makeHandlerWithNotify(invitationService, { userRepo, sendMessage }, eventRepo);

    await handler(ctx as never);
    await new Promise((r) => setTimeout(r, 50));

    const [, text] = sendMessage.mock.calls[0] as [number, string, unknown];
    expect(text).toContain('принял');
    expect(text).toContain('Встреча');
  });

  test('does not notify when response fails', async () => {
    const sendMessage = mock(() => Promise.resolve());
    const invitationService = {
      acceptInvitation: mock(() => ({
        success: false,
        error: 'Already responded',
      })),
    };
    const userRepo = {
      findByTelegramId: mock(() => ({ telegram_id: 100, first_name: 'Sender', language: 'en' })),
    };

    const ctx = makeCtx('inv:accept:1');
    const handler = makeHandlerWithNotify(invitationService, { userRepo, sendMessage });

    await handler(ctx as never);
    await new Promise((r) => setTimeout(r, 50));

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('does not crash when sendMessage fails', async () => {
    const sendMessage = mock(() => Promise.reject(new Error('Forbidden')));
    const invitationService = {
      acceptInvitation: mock(() => ({
        success: true,
        invitation: { id: 1, status: 'accepted', event_id: 5, inviter_id: 100, invitee_id: 200 },
      })),
    };
    const userRepo = {
      findByTelegramId: mock(() => ({ telegram_id: 100, first_name: 'Sender', language: 'en' })),
    };

    const ctx = makeCtx('inv:accept:1');
    const handler = makeHandlerWithNotify(invitationService, { userRepo, sendMessage });

    // Should not throw
    await handler(ctx as never);
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.answer).toHaveBeenCalled();
  });
});
