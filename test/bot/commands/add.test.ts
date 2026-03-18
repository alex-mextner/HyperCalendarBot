import { expect, mock, test } from 'bun:test';
import { handleAdd } from '../../../src/bot/commands/add.ts';
import type { BotCommandContext } from '../../../src/bot/types.ts';
import type { GroupChatRepository } from '../../../src/database/repositories/group-chat.repository.ts';
import type { CreateEventData } from '../../../src/database/types.ts';
import type { EventService } from '../../../src/services/event/event-service.ts';

// Minimal stub for addEventScene
const stubScene = {} as never;

function makeGroupCtx(args: string, overrides: Partial<{ send: ReturnType<typeof mock> }> = {}) {
  return {
    chat: { type: 'group' as const, id: -100 },
    dbUser: { telegram_id: 42, language: 'ru', timezone: 'Europe/Moscow' },
    args,
    send: overrides.send ?? mock(() => Promise.resolve()),
    scene: { enter: mock(() => Promise.resolve()) },
  } as unknown as BotCommandContext;
}

function makePrivateCtx(args: string) {
  return {
    chat: { type: 'private' as const, id: 1 },
    dbUser: { telegram_id: 1, language: 'ru', timezone: 'UTC' },
    args,
    send: mock(() => Promise.resolve()),
    scene: { enter: mock(() => Promise.resolve()) },
  } as unknown as BotCommandContext;
}

test('handleAdd in group with no args enters scene without crash', async () => {
  const groupRepo = { getTimezone: mock(() => 'Europe/Moscow') } as unknown as GroupChatRepository;
  const ctx = makeGroupCtx('');
  await handleAdd(ctx, {} as EventService, stubScene, groupRepo);
  expect((ctx.scene as { enter: ReturnType<typeof mock> }).enter).toHaveBeenCalled();
});

test("handleAdd in group with no timezone sends prompt containing 'таймзону'", async () => {
  const groupRepo = { getTimezone: mock(() => null) } as unknown as GroupChatRepository;
  let sentText = '';
  const send = mock((text: string) => {
    sentText = text;
    return Promise.resolve();
  });
  const ctx = makeGroupCtx('Встреча завтра', { send });
  await handleAdd(ctx, {} as EventService, stubScene, groupRepo);
  expect(sentText).toContain('таймзону');
});

test('handleAdd in group with timezone creates event with group fields', async () => {
  const groupRepo = { getTimezone: mock(() => 'Europe/Moscow') } as unknown as GroupChatRepository;
  let createdData: CreateEventData | null = null;
  const fakeEvent = {
    id: 1,
    title: 'Встреча',
    start_at: new Date().toISOString(),
    end_at: null,
    timezone: 'Europe/Moscow',
    user_id: 42,
  };
  const eventService = {
    createEvent: mock((data: CreateEventData) => {
      createdData = data;
      return fakeEvent;
    }),
  } as unknown as EventService;
  const ctx = makeGroupCtx('Встреча завтра', {});
  await handleAdd(ctx, eventService, stubScene, groupRepo);
  // Parsing "Встреча завтра" succeeds → createEvent is called
  expect(createdData).not.toBeNull();
  expect((createdData as CreateEventData).owner_type).toBe('group');
  expect((createdData as CreateEventData).group_id).toBe(-100);
  expect((createdData as CreateEventData).created_by).toBe(42);
});

test('handleAdd in group quick-add uses group timezone not user timezone', async () => {
  const groupRepo = { getTimezone: mock(() => 'Asia/Tokyo') } as unknown as GroupChatRepository;
  let createdData: CreateEventData | null = null;
  const fakeEvent = {
    id: 1,
    title: 'Митинг',
    start_at: new Date().toISOString(),
    end_at: null,
    timezone: 'Asia/Tokyo',
    user_id: 42,
  };
  const eventService = {
    createEvent: mock((data: CreateEventData) => {
      createdData = data;
      return fakeEvent;
    }),
  } as unknown as EventService;
  const ctx = makeGroupCtx('Митинг завтра', {});
  await handleAdd(ctx, eventService, stubScene, groupRepo);
  expect(createdData).not.toBeNull();
  expect((createdData as CreateEventData).timezone).toBe('Asia/Tokyo');
});

test('handleAdd in private chat does not set group fields', async () => {
  let createdData: CreateEventData | null = null;
  const fakeEvent = {
    id: 1,
    title: 'Task',
    start_at: new Date().toISOString(),
    end_at: null,
    timezone: 'UTC',
    user_id: 1,
  };
  const eventService = {
    createEvent: mock((data: CreateEventData) => {
      createdData = data;
      return fakeEvent;
    }),
  } as unknown as EventService;
  const ctx = makePrivateCtx('Task завтра');
  await handleAdd(ctx, eventService, stubScene);
  expect(createdData).not.toBeNull();
  expect((createdData as CreateEventData).owner_type).not.toBe('group');
  expect((createdData as CreateEventData).group_id).toBeUndefined();
});

test('handleAdd in private chat with no args enters scene', async () => {
  const ctx = makePrivateCtx('');
  await handleAdd(ctx, {} as EventService, stubScene);
  expect((ctx.scene as { enter: ReturnType<typeof mock> }).enter).toHaveBeenCalled();
});
