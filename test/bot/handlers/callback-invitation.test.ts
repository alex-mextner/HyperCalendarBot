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
