// test/bot/handlers/invite-conflict-callback.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { createCallbackHandler } from '../../../src/bot/handlers/callback.handler.ts';

function makeCtx(data: string, language = 'ru', telegramId = 100) {
  return {
    data,
    dbUser: { telegram_id: telegramId, language, timezone: 'UTC', first_name: 'Alex', username: 'alex' },
    answer: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
    send: mock(() => Promise.resolve()),
  };
}

function makeEventService(overrides: Record<string, unknown> = {}) {
  return {
    getEvent: mock(() => null),
    getEventsForDay: mock(() => []),
    getEventsInRange: mock(() => []),
    getEventOwnerId: mock(() => 100),
    editOccurrence: mock(() => null),
    splitRecurrence: mock(() => null),
    cancelOccurrence: mock(() => undefined),
    deleteFuture: mock(() => undefined),
    ...overrides,
  };
}

function makeForceInviteDeps(overrides: Record<string, unknown> = {}) {
  return {
    invitationService: {
      sendInvitation: mock(() => ({ success: true, invitation: { id: 99 } })),
    },
    invRepo: { setMessageInfo: mock(() => {}) },
    deepLinkService: {},
    sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    ...overrides,
  };
}

function makeHandler(
  eventService: ReturnType<typeof makeEventService>,
  forceInviteDeps?: ReturnType<typeof makeForceInviteDeps>,
) {
  return createCallbackHandler(
    eventService as never, // 1 eventService
    {} as never, // 2 editValueScene
    {} as never, // 3 holidayService
    {} as never, // 4 prefsService
    undefined, // 5 calendarRepo
    undefined, // 6 disconnectDeps
    undefined, // 7 onCalendarsDone
    undefined, // 8 renderService
    undefined, // 9 invitationService
    undefined, // 10 groupChatRepo
    undefined, // 11 eventRepo
    undefined, // 12 chatHistoryRepo
    undefined, // 13 onAiButtonClick
    undefined, // 14 oauthDeps
    undefined, // 15 invitationNotifyDeps
    undefined, // 16 onboardingScene
    undefined, // 17 editProposalDeps
    undefined, // 18 callSettingsRepo
    undefined, // 19 sharingSettingsRepo
    undefined, // 20 feedbackDeps
    undefined, // 21 userRepo
    undefined, // 22 intentDeps
    undefined, // 23 secretaryDeps
    undefined, // 24 proposalDeps
    undefined, // 25 snoozeDeps
    forceInviteDeps as never, // 26 forceInviteDeps
  );
}

describe('inv_force callback', () => {
  test('rejects if caller is not event owner', async () => {
    const eventService = makeEventService({ getEventOwnerId: mock(() => 999) });
    const ctx = makeCtx('inv_force:5:200', 'ru', 100);
    const handler = makeHandler(eventService, makeForceInviteDeps());
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalledWith({ text: 'Not authorized' });
  });

  test('sends invitations for each invitee when caller is owner', async () => {
    const eventService = makeEventService({
      getEventOwnerId: mock(() => 100),
      getEvent: mock(() => ({
        id: 5,
        title: 'Party',
        start_at: '2026-03-20T10:00:00.000Z',
        end_at: '2026-03-20T11:00:00.000Z',
      })),
    });
    const forceInviteDeps = makeForceInviteDeps();
    const ctx = makeCtx('inv_force:5:200,201', 'ru', 100);
    const handler = makeHandler(eventService, forceInviteDeps);
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
    // sendInvitation called for 200 and 201
    expect(forceInviteDeps.invitationService.sendInvitation).toHaveBeenCalledTimes(2);
  });

  test('does nothing without forceInviteDeps', async () => {
    const eventService = makeEventService();
    const ctx = makeCtx('inv_force:5:200');
    const handler = makeHandler(eventService);
    await handler(ctx as never);
    // Falls through to unknown action warning, answer still called
    expect(ctx.answer).toHaveBeenCalled();
  });
});

describe('inv_retime callback', () => {
  test('rejects if caller is not event owner', async () => {
    const eventService = makeEventService({ getEventOwnerId: mock(() => 999) });
    const ctx = makeCtx('inv_retime:5', 'ru', 100);
    const handler = makeHandler(eventService, makeForceInviteDeps());
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalledWith({ text: 'Not authorized' });
  });

  test('shows retime prompt when caller is owner', async () => {
    const eventService = makeEventService({ getEventOwnerId: mock(() => 100) });
    const ctx = makeCtx('inv_retime:5', 'ru', 100);
    const handler = makeHandler(eventService, makeForceInviteDeps());
    await handler(ctx as never);
    expect(ctx.editText).toHaveBeenCalled();
    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('/edit');
  });
});

describe('inv_cancel callback', () => {
  test('edits message to cancelled text', async () => {
    const ctx = makeCtx('inv_cancel', 'ru');
    const handler = makeHandler(makeEventService());
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('❌');
  });

  test('works in english locale', async () => {
    const ctx = makeCtx('inv_cancel', 'en');
    const handler = makeHandler(makeEventService());
    await handler(ctx as never);
    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('cancelled');
  });
});
