// test/bot/pipeline/dialogue-v3-layer.test.ts
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createDialogueV3Layer, type DialogueV3LayerDeps } from '../../../src/bot/pipeline/dialogue-v3-layer.ts';
import type { WorkflowSession } from '../../../src/bot/pipeline/types.ts';
import type { BotCommandContext } from '../../../src/bot/types.ts';
import { DatabaseService } from '../../../src/database/index.ts';
import { createContactPeopleResolver, createManualPlaceResolver } from '../../../src/services/dialogue/resolvers.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { InvitationService } from '../../../src/services/sharing/invitation-service.ts';

const databases: DatabaseService[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.db.close();
});

function makeHarness(now = new Date('2026-09-29T08:00:00Z'), extraDeps: Partial<DialogueV3LayerDeps> = {}) {
  const db = new DatabaseService(':memory:');
  databases.push(db);
  const user = db.users.create({ telegram_id: 42, language: 'ru', timezone: 'Europe/Belgrade' });
  const send = mock(async (_text: string, _options?: { reply_markup?: unknown }) => undefined);
  const ctx = { chatId: 42, dbUser: user, lang: 'ru', send } as unknown as BotCommandContext;
  const sentInvitations: Array<{ chatId: number; text: string }> = [];
  const sender = {
    sendMessage: async (chatId: number, text: string) => {
      sentInvitations.push({ chatId, text });
      return { message_id: sentInvitations.length };
    },
    editMessageText: async () => {},
    sendInvitation: async (inviteeId: number, text: string) => {
      sentInvitations.push({ chatId: inviteeId, text });
      return { message_id: sentInvitations.length };
    },
  };
  const googlePushCalls: Array<{ userId: number; eventId: number }> = [];
  const deps: DialogueV3LayerDeps = {
    enabled: true,
    dialogueSessions: db.dialogueSessions,
    eventService: new EventService({ eventRepo: db.events }),
    invitationService: new InvitationService(db.invitations, db.events, db.sharingSettings, db.participants),
    invitationDelivery: { sender, invitationRepo: db.invitations, userRepo: db.users },
    peopleResolver: createContactPeopleResolver(db.contacts),
    placeResolver: createManualPlaceResolver(),
    onEventCreated: async (userId, eventId) => {
      googlePushCalls.push({ userId, eventId });
    },
    now: () => now,
    ...extraDeps,
  };
  return { db, user, send, ctx, sentInvitations, googlePushCalls, layer: createDialogueV3Layer(deps), deps };
}

function eventsOf(db: DatabaseService, userId: number) {
  return db.events.getVisibleInRange(userId, '2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z');
}

describe('disabled flag — inert', () => {
  test('returns handled:false and touches nothing when disabled', async () => {
    const h = makeHarness();
    const disabledLayer = createDialogueV3Layer({ ...h.deps, enabled: false });
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

  test('a timed event gets a real end time, never left NULL', async () => {
    const h = makeHarness();
    await h.layer(h.ctx, 'сделай встречу завтра в 14:00');
    const events = eventsOf(h.db, 42);
    expect(events[0]?.end_at).not.toBeNull();
    expect(events[0]?.end_at).toBe('2026-09-30T13:00:00.000Z'); // default 60-minute duration
  });

  test('a group-triggered draft creates a group event, never silently personal', async () => {
    const h = makeHarness();
    const groupCtx = { ...h.ctx } as unknown as BotCommandContext;
    const result = await h.layer(groupCtx, 'сделай встречу завтра в 14:00', {
      groupContext: { isGroup: true, groupChatId: 42 },
    });
    expect(result).toEqual({ handled: true });
    const row = h.db.db.prepare('SELECT owner_type, group_id FROM events WHERE user_id = ?').get(42) as {
      owner_type: string | null;
      group_id: number | null;
    };
    expect(row.owner_type).toBe('group');
    expect(row.group_id).toBe(42);
  });

  test('the post-create Google scheduling hook is invoked, never duplicated or bypassed (blocker: reuse googleSchedulePush)', async () => {
    const h = makeHarness();
    await h.layer(h.ctx, 'сделай встречу завтра в 14:00');
    expect(h.googlePushCalls).toHaveLength(1);
    expect(h.googlePushCalls[0]?.userId).toBe(42);
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
    expect(session?.selectedDate).toBe('2026-09-30');
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  test('a follow-up turn supplying the time completes the draft and clears the session', async () => {
    const h = makeHarness();
    await h.layer(h.ctx, 'сделай завтра встречу');
    const result = await h.layer(h.ctx, '14:00');
    expect(result).toEqual({ handled: true });
    const events = eventsOf(h.db, 42);
    expect(events).toHaveLength(1);
    expect(events[0]?.start_at).toBe('2026-09-30T12:00:00.000Z');
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

describe('negation blocks execution outright (blocker: parseResult.negated MUST block event.create)', () => {
  test('a negated starter turn never creates an event and never starts a draft', async () => {
    const h = makeHarness();
    const result = await h.layer(h.ctx, 'сделай встречу завтра в 14:00 не создавай');
    expect(result).toEqual({ handled: true });
    expect(eventsOf(h.db, 42)).toHaveLength(0);
    expect(h.db.dialogueSessions.get({ chatId: 42, userId: 42, topicId: 0 })).toBeNull();
  });

  test('a negated continuation turn cancels the in-progress draft rather than executing it', async () => {
    const h = makeHarness();
    await h.layer(h.ctx, 'сделай завтра встречу');
    const result = await h.layer(h.ctx, 'не надо, отставить');
    expect(result).toEqual({ handled: true });
    expect(eventsOf(h.db, 42)).toHaveLength(0);
    expect(h.db.dialogueSessions.get({ chatId: 42, userId: 42, topicId: 0 })).toBeNull();
  });
});

describe('a single fuzzy person on a natural-start message blocks the fast path', () => {
  test('an unconfirmed fuzzy match parks the draft on a yes/no question, never auto-adds and never auto-fires', async () => {
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
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]?.[0]).toContain('Kristina');
  });

  test('an unrelated next message does NOT resolve the pending confirmation or auto-fire the event', async () => {
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

  test('replying "yes" confirms the candidate, sends a real invitation (not a raw pending participant), and fires the event', async () => {
    const h = makeHarness();
    h.db.contacts.add(42, 'Kristina', undefined, 501);
    h.db.users.create({ telegram_id: 501, language: 'en', timezone: 'UTC' });
    await h.layer(h.ctx, 'сделай встречу завтра в 14:00 with Kristin');
    const result = await h.layer(h.ctx, 'да');
    expect(result).toEqual({ handled: true });
    const events = eventsOf(h.db, 42);
    expect(events).toHaveLength(1);
    // Real Invitation record created (blocker: participantRepo.add(pending) is not delivery).
    const invitations = h.db.invitations.getByEvent(events[0]!.id);
    expect(invitations).toHaveLength(1);
    expect(invitations[0]?.invitee_id).toBe(501);
    // Real delivery attempted through the sender.
    expect(h.sentInvitations.length).toBeGreaterThan(0);
    expect(h.db.dialogueSessions.get({ chatId: 42, userId: 42, topicId: 0 })).toBeNull();
  });

  test('replying "no" declines the candidate and still fires the event without that person, no invitation created', async () => {
    const h = makeHarness();
    h.db.contacts.add(42, 'Kristina', undefined, 501);
    await h.layer(h.ctx, 'сделай встречу завтра в 14:00 with Kristin');
    const result = await h.layer(h.ctx, 'нет');
    expect(result).toEqual({ handled: true });
    const events = eventsOf(h.db, 42);
    expect(events).toHaveLength(1);
    expect(h.db.invitations.getByEvent(events[0]!.id)).toHaveLength(0);
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

describe('an unresolved name (no contact at all) blocks execution and offers a skip path (blocker: unresolvedPeopleNames MUST block event.create)', () => {
  test('an explicit unknown name parks on a clarify-or-skip question, never silently created without them', async () => {
    const h = makeHarness();
    const result = await h.layer(h.ctx, 'сделай встречу завтра в 14:00 with Zorblax');
    expect(result).toEqual({ handled: true });
    expect(eventsOf(h.db, 42)).toHaveLength(0);
    const session = h.db.dialogueSessions.get({ chatId: 42, userId: 42, topicId: 0 });
    expect(session?.pendingFuzzyPeople).toEqual([{ rawName: 'Zorblax', candidates: [] }]);
    expect(h.send.mock.calls[0]?.[0]).toContain('Zorblax');
  });

  test('replying "skip" drops the unresolved name and fires the event without them', async () => {
    const h = makeHarness();
    await h.layer(h.ctx, 'сделай встречу завтра в 14:00 with Zorblax');
    const result = await h.layer(h.ctx, 'skip');
    expect(result).toEqual({ handled: true });
    const events = eventsOf(h.db, 42);
    expect(events).toHaveLength(1);
    expect(h.db.invitations.getByEvent(events[0]!.id)).toHaveLength(0);
  });
});

describe('actor/chat/topic scoping', () => {
  test('two different chats for the same user get independent sessions', async () => {
    const h = makeHarness();
    await h.layer(h.ctx, 'сделай завтра встречу');
    const otherChatCtx = { ...h.ctx, chatId: 999 } as unknown as BotCommandContext;
    const result = await h.layer(otherChatCtx, 'какая погода?');
    expect(result).toEqual({ handled: false });
    expect(h.db.dialogueSessions.get({ chatId: 42, userId: 42, topicId: 0 })?.status).toBe('collecting');
    expect(h.db.dialogueSessions.get({ chatId: 999, userId: 42, topicId: 0 })).toBeNull();
  });
});

describe('one-active-interaction-owner precedence (blocker: v3 and legacy workflow/scene must not both consume the same reply)', () => {
  test('an active v1/v2 workflow session makes this layer abstain entirely — never starts or continues a v3 draft', async () => {
    const h = makeHarness(undefined, {
      workflowSessions: {
        get: (_chatId, _userId) =>
          ({
            intentId: 1,
            stepIndex: 0,
            stepResults: {},
            workflow: { version: 1, steps: [] },
            captures: {},
            createdAt: Date.now(),
          }) as unknown as WorkflowSession,
        set: () => {},
        delete: () => {},
        deleteByUser: () => {},
      },
    });
    const result = await h.layer(h.ctx, 'сделай встречу завтра в 14:00');
    expect(result).toEqual({ handled: false });
    expect(eventsOf(h.db, 42)).toHaveLength(0);
    expect(h.db.dialogueSessions.get({ chatId: 42, userId: 42, topicId: 0 })).toBeNull();
  });

  test('no active v1/v2 session (get returns null) behaves exactly as without the store wired at all', async () => {
    const h = makeHarness(undefined, {
      workflowSessions: { get: () => null, set: () => {}, delete: () => {}, deleteByUser: () => {} },
    });
    const result = await h.layer(h.ctx, 'сделай встречу завтра в 14:00');
    expect(result).toEqual({ handled: true });
    expect(eventsOf(h.db, 42)).toHaveLength(1);
  });
});

describe('anchor date carries forward across turns (blocker: "Встреча завтра" must retain the selected date for the next time question)', () => {
  test('a bare time-only reply resolves against the date the starter turn selected, not the day the reply arrived', async () => {
    const h = makeHarness();
    await h.layer(h.ctx, 'сделай встречу завтра');
    const result = await h.layer(h.ctx, '14:00');
    expect(result).toEqual({ handled: true });
    const events = eventsOf(h.db, 42);
    expect(events).toHaveLength(1);
    expect(events[0]?.start_at).toBe('2026-09-30T12:00:00.000Z');
  });
});

describe('compare-and-swap race safety (blocker: late/duplicate write never overwrites newer state)', () => {
  test('a lost CAS race on the executing write is silently absorbed, never double-executed', async () => {
    const h = makeHarness();
    await h.layer(h.ctx, 'сделай завтра встречу');
    // Wrap the real repository so its `set()` reports a lost race exactly once — simulating a
    // concurrent writer that won between this turn's read and its own write — while every other
    // operation (get/delete) stays real.
    let setCalls = 0;
    const racyDialogueSessions = {
      get: h.db.dialogueSessions.get.bind(h.db.dialogueSessions),
      delete: h.db.dialogueSessions.delete.bind(h.db.dialogueSessions),
      cleanup: h.db.dialogueSessions.cleanup.bind(h.db.dialogueSessions),
      set: () => {
        setCalls++;
        return { ok: false as const, reason: 'revision_mismatch' as const };
      },
    } as unknown as DialogueV3LayerDeps['dialogueSessions'];
    const racyLayer = createDialogueV3Layer({ ...h.deps, dialogueSessions: racyDialogueSessions });
    const result = await racyLayer(h.ctx, '14:00');
    expect(result).toEqual({ handled: true });
    expect(setCalls).toBeGreaterThan(0);
    // No event created — the race was lost before EventService.createEvent ever ran.
    expect(eventsOf(h.db, 42)).toHaveLength(0);
  });
});
