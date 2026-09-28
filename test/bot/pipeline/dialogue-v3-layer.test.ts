// test/bot/pipeline/dialogue-v3-layer.test.ts
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createDialogueV3Layer, type DialogueV3LayerDeps } from '../../../src/bot/pipeline/dialogue-v3-layer.ts';
import type { BotCommandContext } from '../../../src/bot/types.ts';
import { DatabaseService } from '../../../src/database/index.ts';
import { createContactPeopleResolver, createManualPlaceResolver } from '../../../src/services/dialogue/resolvers.ts';
import { EventService } from '../../../src/services/event/event-service.ts';

const databases: DatabaseService[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.db.close();
});

function makeHarness(now = new Date('2026-09-29T08:00:00Z')) {
  const db = new DatabaseService(':memory:');
  databases.push(db);
  const user = db.users.create({ telegram_id: 42, language: 'ru', timezone: 'Europe/Belgrade' });
  const send = mock(async (_text: string, _options?: { reply_markup?: unknown }) => undefined);
  const ctx = { chatId: 42, dbUser: user, lang: 'ru', send } as unknown as BotCommandContext;
  const deps: DialogueV3LayerDeps = {
    enabled: true,
    dialogueSessions: db.dialogueSessions,
    eventService: new EventService({ eventRepo: db.events }),
    participantRepo: db.participants,
    peopleResolver: createContactPeopleResolver(db.contacts),
    placeResolver: createManualPlaceResolver(),
    now: () => now,
  };
  return { db, user, send, ctx, layer: createDialogueV3Layer(deps) };
}

function eventsOf(db: DatabaseService, userId: number) {
  return db.events.getVisibleInRange(userId, '2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z');
}

describe('disabled flag — inert', () => {
  test('returns handled:false and touches nothing when disabled', async () => {
    const h = makeHarness();
    const disabledLayer = createDialogueV3Layer({
      enabled: false,
      dialogueSessions: h.db.dialogueSessions,
      eventService: new EventService({ eventRepo: h.db.events }),
      peopleResolver: createContactPeopleResolver(h.db.contacts),
      placeResolver: createManualPlaceResolver(),
    });
    const result = await disabledLayer(h.ctx, 'сделай встречу завтра в 14:00');
    expect(result).toEqual({ handled: false });
    expect(eventsOf(h.db, 42)).toHaveLength(0);
  });
});

describe('unrelated text — falls through', () => {
  test('a message with no starter verb and no active session returns handled:false', async () => {
    const h = makeHarness();
    const result = await h.layer(h.ctx, 'какая сегодня погода?');
    expect(result).toEqual({ handled: false });
  });
});

describe('a fully specified natural-start message creates the event in one turn, zero LLM', () => {
  test('"сделай встречу завтра в 14:00" executes immediately', async () => {
    const h = makeHarness();
    const result = await h.layer(h.ctx, 'сделай встречу завтра в 14:00');
    expect(result).toEqual({ handled: true });
    const events = eventsOf(h.db, 42);
    expect(events).toHaveLength(1);
    expect(events[0]?.start_at).toBe('2026-09-30T12:00:00.000Z');
    // No dialogue session left behind once the draft executes.
    expect(h.db.dialogueSessions.get({ chatId: 42, userId: 42, topicId: 0 })).toBeNull();
  });

  test('a timed event gets a real end time, never left NULL (regression: was hardcoded undefined)', async () => {
    const h = makeHarness();
    await h.layer(h.ctx, 'сделай встречу завтра в 14:00');
    const events = eventsOf(h.db, 42);
    expect(events[0]?.end_at).not.toBeNull();
    expect(events[0]?.end_at).toBe('2026-09-30T13:00:00.000Z'); // default 60-minute duration
  });

  test('a group-triggered draft creates a group event, never silently personal (regression)', async () => {
    const h = makeHarness();
    const groupCtx = { ...h.ctx } as unknown as BotCommandContext;
    const result = await h.layer(groupCtx, 'сделай встречу завтра в 14:00', {
      groupContext: { isGroup: true, groupChatId: 42 },
    });
    expect(result).toEqual({ handled: true });
    // getVisibleInRange requires group membership setup unrelated to this assertion — read the
    // raw row to check owner_type/group_id directly.
    const row = h.db.db.prepare('SELECT owner_type, group_id FROM events WHERE user_id = ?').get(42) as {
      owner_type: string | null;
      group_id: number | null;
    };
    expect(row.owner_type).toBe('group');
    expect(row.group_id).toBe(42);
  });
});

describe('an incomplete natural-start message asks the next question and persists a session', () => {
  test('"сделай завтра встречу" (no time) asks for schedule and stores a collecting session', async () => {
    const h = makeHarness();
    const result = await h.layer(h.ctx, 'сделай завтра встречу');
    expect(result).toEqual({ handled: true });
    expect(eventsOf(h.db, 42)).toHaveLength(0);
    const session = h.db.dialogueSessions.get({ chatId: 42, userId: 42, topicId: 0 });
    expect(session?.status).toBe('collecting');
    expect(session?.pendingField).toBe('schedule');
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  test('a follow-up turn supplying the time completes the draft and clears the session', async () => {
    const h = makeHarness();
    await h.layer(h.ctx, 'сделай завтра встречу');
    const result = await h.layer(h.ctx, '14:00');
    expect(result).toEqual({ handled: true });
    const events = eventsOf(h.db, 42);
    expect(events).toHaveLength(1);
    expect(h.db.dialogueSessions.get({ chatId: 42, userId: 42, topicId: 0 })).toBeNull();
  });
});

describe('a completely unrecognized continuation turn hands off to the AI path exactly once', () => {
  test('an unparseable follow-up returns handled:false and marks the session handed_off', async () => {
    const h = makeHarness();
    await h.layer(h.ctx, 'сделай завтра встречу');
    const result = await h.layer(h.ctx, 'ask my assistant to figure out a good time based on everyone calendars');
    expect(result).toEqual({ handled: false });
    const session = h.db.dialogueSessions.get({ chatId: 42, userId: 42, topicId: 0 });
    expect(session?.status).toBe('handed_off');
  });
});

describe('cancel — a plain-text cancel word deletes the session', () => {
  test('"отмена" clears the collecting session', async () => {
    const h = makeHarness();
    await h.layer(h.ctx, 'сделай завтра встречу');
    const result = await h.layer(h.ctx, 'отмена');
    expect(result).toEqual({ handled: true });
    expect(h.db.dialogueSessions.get({ chatId: 42, userId: 42, topicId: 0 })).toBeNull();
    expect(eventsOf(h.db, 42)).toHaveLength(0);
  });
});

describe('a single fuzzy person on a natural-start message blocks the fast path', () => {
  test('an unconfirmed fuzzy match parks the draft on a yes/no question, never auto-adds and never auto-fires (regression)', async () => {
    const h = makeHarness();
    h.db.contacts.add(42, 'Kristina', undefined, 501);
    const result = await h.layer(h.ctx, 'сделай встречу завтра в 14:00 with Kristin');
    expect(result).toEqual({ handled: true });
    expect(eventsOf(h.db, 42)).toHaveLength(0);
    const session = h.db.dialogueSessions.get({ chatId: 42, userId: 42, topicId: 0 });
    expect(session?.status).toBe('collecting');
    expect(session?.pendingField).toBe('people');
    expect(session?.pendingFuzzyPeople).toHaveLength(1);
    expect(session?.pendingFuzzyPeople[0]?.rawName).toBe('Kristin');
    // The confirmation question was actually sent — not silently swallowed.
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]?.[0]).toContain('Kristina');
  });

  test('an unrelated next message does NOT resolve the pending confirmation or auto-fire the event (regression: was silently dropped + wrong auto-create)', async () => {
    const h = makeHarness();
    h.db.contacts.add(42, 'Kristina', undefined, 501);
    await h.layer(h.ctx, 'сделай встречу завтра в 14:00 with Kristin');
    const result = await h.layer(h.ctx, 'какая сегодня погода?');
    expect(result).toEqual({ handled: true });
    expect(eventsOf(h.db, 42)).toHaveLength(0);
    const session = h.db.dialogueSessions.get({ chatId: 42, userId: 42, topicId: 0 });
    expect(session?.status).toBe('collecting');
    expect(session?.pendingFuzzyPeople).toHaveLength(1);
  });

  test('replying "yes" confirms the candidate, adds the participant, and fires the event', async () => {
    const h = makeHarness();
    h.db.contacts.add(42, 'Kristina', undefined, 501);
    await h.layer(h.ctx, 'сделай встречу завтра в 14:00 with Kristin');
    const result = await h.layer(h.ctx, 'да');
    expect(result).toEqual({ handled: true });
    const events = eventsOf(h.db, 42);
    expect(events).toHaveLength(1);
    const participants = h.db.participants.getByEvent(events[0]!.id);
    expect(participants).toHaveLength(1);
    expect(participants[0]?.user_id).toBe(501);
    expect(h.db.dialogueSessions.get({ chatId: 42, userId: 42, topicId: 0 })).toBeNull();
  });

  test('replying "no" declines the candidate and still fires the event without that person', async () => {
    const h = makeHarness();
    h.db.contacts.add(42, 'Kristina', undefined, 501);
    await h.layer(h.ctx, 'сделай встречу завтра в 14:00 with Kristin');
    const result = await h.layer(h.ctx, 'нет');
    expect(result).toEqual({ handled: true });
    const events = eventsOf(h.db, 42);
    expect(events).toHaveLength(1);
    expect(h.db.participants.getByEvent(events[0]!.id)).toHaveLength(0);
  });

  test('an unrecognized reply to the confirmation re-asks locally, never hands off to the AI path', async () => {
    const h = makeHarness();
    h.db.contacts.add(42, 'Kristina', undefined, 501);
    await h.layer(h.ctx, 'сделай встречу завтра в 14:00 with Kristin');
    const result = await h.layer(h.ctx, 'maybe idk');
    expect(result).toEqual({ handled: true });
    expect(eventsOf(h.db, 42)).toHaveLength(0);
    const session = h.db.dialogueSessions.get({ chatId: 42, userId: 42, topicId: 0 });
    expect(session?.pendingFuzzyPeople).toHaveLength(1);
  });
});

describe('actor/chat/topic scoping', () => {
  test('two different chats for the same user get independent sessions', async () => {
    const h = makeHarness();
    await h.layer(h.ctx, 'сделай завтра встречу');
    const otherChatCtx = { ...h.ctx, chatId: 999 } as unknown as BotCommandContext;
    const result = await h.layer(otherChatCtx, 'какая погода?');
    // No session yet for chat 999, and "какая погода?" is not a starter phrase.
    expect(result).toEqual({ handled: false });
    expect(h.db.dialogueSessions.get({ chatId: 42, userId: 42, topicId: 0 })?.status).toBe('collecting');
    expect(h.db.dialogueSessions.get({ chatId: 999, userId: 42, topicId: 0 })).toBeNull();
  });
});
