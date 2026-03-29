// test/bot/handlers/callback-invite-contact.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { createCallbackHandler } from '../../../src/bot/handlers/callback.handler';

function makeCtx(data: string, userId = 200, lang = 'en') {
  return {
    data,
    dbUser: { telegram_id: userId, language: lang, timezone: 'UTC', first_name: 'Test' },
    answer: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
    send: mock(() => Promise.resolve()),
  };
}

function makeHandler(eventService: { [key: string]: unknown }, forceInviteDeps?: { [key: string]: unknown }) {
  return createCallbackHandler(eventService as never, {} as never, {} as never, {} as never, {
    forceInviteDeps: forceInviteDeps as never,
  });
}

describe('INVITE_CONTACT callback', () => {
  test('cancel — edits text to Cancelled (en)', async () => {
    const ctx = makeCtx('invc:cancel');
    await makeHandler({})(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalledWith(expect.stringContaining('Cancel'));
  });

  test('cancel — edits text to Отменено (ru)', async () => {
    const ctx = makeCtx('invc:cancel', 200, 'ru');
    await makeHandler({})(ctx as never);
    expect(ctx.editText).toHaveBeenCalledWith(expect.stringContaining('Отмен'));
  });

  test('picker sub — answers and shows Pick a contact message', async () => {
    const eventService = {
      getEvent: mock(() => ({ id: 5, title: 'Meeting' })),
    };
    const ctx = makeCtx('invc:5:picker');
    await makeHandler(eventService)(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalledWith(expect.stringContaining('Pick a contact'), expect.anything());
    expect(ctx.send).toHaveBeenCalled();
  });

  test('chat sub — answers and shows Pick a contact message', async () => {
    const eventService = {
      getEvent: mock(() => ({ id: 7, title: 'Lunch' })),
    };
    const ctx = makeCtx('invc:7:chat');
    await makeHandler(eventService)(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.send).toHaveBeenCalled();
  });

  test('picker sub — answers Not found when event missing', async () => {
    const eventService = { getEvent: mock(() => null) };
    const ctx = makeCtx('invc:5:picker');
    await makeHandler(eventService)(ctx as never);
    expect(ctx.answer).toHaveBeenCalledWith(expect.objectContaining({ text: 'Not found' }));
  });

  test('direct contact — answers Not found when event deleted (ownerId null)', async () => {
    const eventService = {
      getEvent: mock(() => null),
      getEventOwnerId: mock(() => null),
    };
    const forceInviteDeps = {
      invitationService: { sendInvitation: mock(() => ({ success: true })) },
      invRepo: {},
      deepLinkService: {},
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    };
    const ctx = makeCtx('invc:5:300');
    await makeHandler(eventService, forceInviteDeps)(ctx as never);
    expect(ctx.answer).toHaveBeenCalledWith(expect.objectContaining({ text: 'Not found' }));
    expect(forceInviteDeps.invitationService.sendInvitation).not.toHaveBeenCalled();
  });

  test('direct contact — ownership check denies non-owner', async () => {
    const eventService = {
      getEvent: mock(() => ({ id: 5, title: 'Meeting' })),
      getEventOwnerId: mock(() => 999), // owner is 999, user is 200
    };
    const forceInviteDeps = {
      invitationService: { sendInvitation: mock(() => ({ success: true })) },
      invRepo: {},
      deepLinkService: {},
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    };
    const ctx = makeCtx('invc:5:300');
    await makeHandler(eventService, forceInviteDeps)(ctx as never);
    expect(ctx.answer).toHaveBeenCalledWith(expect.objectContaining({ text: 'Not authorized' }));
    expect(forceInviteDeps.invitationService.sendInvitation).not.toHaveBeenCalled();
  });

  test('direct contact — sends invitation when owner matches', async () => {
    const eventService = {
      getEvent: mock(() => ({
        id: 5,
        title: 'Party',
        start_at: '2026-04-01T18:00:00Z',
        end_at: '2026-04-01T19:00:00Z',
        all_day: false,
        timezone: 'UTC',
      })),
      getEventOwnerId: mock(() => 200), // user 200 is owner
    };
    const sendInvitation = mock(() => ({ success: true, invitation: { id: 42 } }));
    const sendMessage = mock(() => Promise.resolve({ message_id: 7 }));
    const setMessageInfo = mock(() => {});
    const forceInviteDeps = {
      invitationService: { sendInvitation },
      invRepo: { setMessageInfo },
      deepLinkService: {},
      sendMessage,
    };
    const ctx = makeCtx('invc:5:300');
    await makeHandler(eventService, forceInviteDeps)(ctx as never);
    expect(sendInvitation).toHaveBeenCalledWith(5, 200, 300);
    expect(ctx.editText).toHaveBeenCalled();
  });

  test('direct contact — answers Not configured when forceInviteDeps absent', async () => {
    const eventService = {
      getEvent: mock(() => ({ id: 5, title: 'Party' })),
      getEventOwnerId: mock(() => 200),
    };
    const ctx = makeCtx('invc:5:300');
    await makeHandler(eventService)(ctx as never); // no forceInviteDeps
    expect(ctx.answer).toHaveBeenCalledWith(expect.objectContaining({ text: 'Not configured' }));
  });

  test('direct contact — answers error when sendInvitation fails', async () => {
    const eventService = {
      getEvent: mock(() => ({ id: 5, title: 'Party' })),
      getEventOwnerId: mock(() => 200),
    };
    const forceInviteDeps = {
      invitationService: { sendInvitation: mock(() => ({ success: false, error: 'Already invited' })) },
      invRepo: {},
      deepLinkService: {},
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    };
    const ctx = makeCtx('invc:5:300');
    await makeHandler(eventService, forceInviteDeps)(ctx as never);
    expect(ctx.answer).toHaveBeenCalledWith(expect.objectContaining({ text: 'Already invited' }));
  });
});
