import { expect, mock, test } from 'bun:test';
import { handleAdd } from '../../../src/bot/commands/add.ts';
import type { GroupChatRepository } from '../../../src/database/repositories/group-chat.repository.ts';
import type { CreateEventData } from '../../../src/database/types.ts';
import type { EventService } from '../../../src/services/event/event-service.ts';

// Minimal stub for addEventScene
const stubScene = {} as never;

function makeGroupCtx(args: string, overrides: Partial<{ send: ReturnType<typeof mock> }> = {}) {
  return {
    chat: { type: 'group' as const, id: -100 },
    dbUser: { telegram_id: 42, language: 'ru' as const, timezone: 'Europe/Moscow' },
    args,
    send: overrides.send ?? mock(() => Promise.resolve()),
    scene: { enter: mock(() => Promise.resolve()) },
  };
}

function makePrivateCtx(args: string) {
  return {
    chat: { type: 'private' as const, id: 1 },
    dbUser: { telegram_id: 1, language: 'ru' as const, timezone: 'UTC' },
    args,
    send: mock(() => Promise.resolve()),
    scene: { enter: mock(() => Promise.resolve()) },
  };
}

test('handleAdd in group with no args enters scene without crash', async () => {
  const groupRepo = { getTimezone: mock(() => 'Europe/Moscow') } as unknown as GroupChatRepository;
  const ctx = makeGroupCtx('');
  await handleAdd(
    ctx as unknown as Parameters<typeof handleAdd>[0],
    {} as unknown as EventService,
    stubScene,
    groupRepo,
  );
  expect(ctx.scene.enter).toHaveBeenCalled();
});

test("handleAdd in group with no timezone sends prompt containing 'таймзону'", async () => {
  const groupRepo = { getTimezone: mock(() => null) } as unknown as GroupChatRepository;
  let sentText = '';
  const send = mock((text: string) => {
    sentText = text;
    return Promise.resolve();
  });
  const ctx = makeGroupCtx('Встреча завтра', { send });
  await handleAdd(
    ctx as unknown as Parameters<typeof handleAdd>[0],
    {} as unknown as EventService,
    stubScene,
    groupRepo,
  );
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
  const ctx = makeGroupCtx('Встреча завтра 10:00', {});
  await handleAdd(ctx as unknown as Parameters<typeof handleAdd>[0], eventService, stubScene, groupRepo);
  // Explicit time makes this a true quick-add.
  expect(createdData).not.toBeNull();
  expect(createdData!.owner_type).toBe('group');
  expect(createdData!.group_id).toBe(-100);
  expect(createdData!.created_by).toBe(42);
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
  const ctx = makeGroupCtx('Митинг завтра 10:00', {});
  await handleAdd(ctx as unknown as Parameters<typeof handleAdd>[0], eventService, stubScene, groupRepo);
  expect(createdData).not.toBeNull();
  expect(createdData!.timezone).toBe('Asia/Tokyo');
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
  const ctx = makePrivateCtx('Task завтра 10:00');
  await handleAdd(ctx as unknown as Parameters<typeof handleAdd>[0], eventService, stubScene);
  expect(createdData).not.toBeNull();
  expect(createdData!.owner_type).not.toBe('group');
  expect(createdData!.group_id).toBeUndefined();
});

test('handleAdd in private chat with no args enters scene', async () => {
  const ctx = makePrivateCtx('');
  await handleAdd(ctx as unknown as Parameters<typeof handleAdd>[0], {} as unknown as EventService, stubScene);
  expect(ctx.scene.enter).toHaveBeenCalled();
});

test('quick-add with date but no time preserves title/date and asks wizard for time', async () => {
  const createEvent = mock(() => {
    throw new Error('must not create a midnight event');
  });
  const eventService = { createEvent } as unknown as EventService;
  const ctx = makePrivateCtx('Task завтра');

  await handleAdd(ctx as unknown as Parameters<typeof handleAdd>[0], eventService, stubScene);

  expect(createEvent).not.toHaveBeenCalled();
  expect(ctx.scene.enter).toHaveBeenCalledTimes(1);
  const [, params] = ctx.scene.enter.mock.calls[0] as unknown as [
    unknown,
    { initialTitle: string; pendingDate: string },
  ];
  expect(params.initialTitle).toBe('Task');
  expect(params.pendingDate).toBeString();
});
