// test/bot/commands/unshare.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { handleUnshare } from '../../../src/bot/commands/unshare.ts';
import type { GroupChatRepository } from '../../../src/database/repositories/group-chat.repository';

function makeCtx(chatType: string, userId = 100) {
  return {
    dbUser: { telegram_id: userId, language: 'en' },
    send: mock(() => Promise.resolve()),
    chat: { type: chatType, id: -1001234 },
  };
}

const makeSharedEvent = (eventId: number, sharedBy: number) => ({
  id: 1,
  chat_id: -1001234,
  event_id: eventId,
  shared_by: sharedBy,
  created_at: '2026-03-01T00:00:00Z',
});

describe('handleUnshare', () => {
  test('rejects in private chat', async () => {
    const ctx = makeCtx('private');
    await handleUnshare(ctx as never, {} as never, {} as never);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('groups');
  });

  test('shows no-events message when user has no shared events in this chat', async () => {
    const ctx = makeCtx('supergroup', 100);
    const groupRepo = { getSharedEvents: mock(() => []) } as unknown as GroupChatRepository;
    await handleUnshare(ctx as never, groupRepo, {} as never);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('no events');
  });

  test('shows no-events message when shared events belong to other users', async () => {
    const ctx = makeCtx('group', 100);
    const groupRepo = {
      getSharedEvents: mock(() => [makeSharedEvent(5, 999)]),
    } as unknown as GroupChatRepository;
    await handleUnshare(ctx as never, groupRepo, {} as never);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('no events');
  });

  test('shows unshare picker when user has shared events', async () => {
    const ctx = makeCtx('group', 100);
    const groupRepo = {
      getSharedEvents: mock(() => [makeSharedEvent(5, 100), makeSharedEvent(7, 100)]),
    } as unknown as GroupChatRepository;
    const eventService = {
      getEvent: mock((id: number) => ({ id, title: `Event ${id}` })),
    };

    await handleUnshare(ctx as never, groupRepo, eventService as never);
    expect(ctx.send).toHaveBeenCalledWith(
      expect.stringContaining('Select an event'),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
  });

  test('calls getSharedEvents with chat id', async () => {
    const ctx = makeCtx('supergroup', 100);
    const getSharedEvents = mock(() => []);
    const groupRepo = { getSharedEvents } as unknown as GroupChatRepository;

    await handleUnshare(ctx as never, groupRepo, {} as never);
    expect(getSharedEvents).toHaveBeenCalledWith(-1001234);
  });

  test('shows picker in ru locale', async () => {
    const ctx = {
      dbUser: { telegram_id: 100, language: 'ru' },
      send: mock(() => Promise.resolve()),
      chat: { type: 'group', id: -1001234 },
    };
    const groupRepo = {
      getSharedEvents: mock(() => [makeSharedEvent(3, 100)]),
    } as unknown as GroupChatRepository;
    const eventService = { getEvent: mock(() => ({ id: 3, title: 'Meeting' })) };

    await handleUnshare(ctx as never, groupRepo, eventService as never);
    expect(ctx.send).toHaveBeenCalledWith(
      expect.stringContaining('Выберите событие'),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
  });
});
