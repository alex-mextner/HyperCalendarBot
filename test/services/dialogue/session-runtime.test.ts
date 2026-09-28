// test/services/dialogue/session-runtime.test.ts
import { describe, expect, mock, test } from 'bun:test';
import type { BotCommandContext } from '../../../src/bot/types.ts';
import { DatabaseService } from '../../../src/database/index.ts';
import type { DialogueSessionKey } from '../../../src/database/repositories/dialogue-session.repository.ts';
import type { User } from '../../../src/database/types.ts';
import {
  applyParseResultToDraft,
  executeDraft,
  inviteResolvedPeople,
  resumeExecutedSession,
  type SessionRuntimeDeps,
  toPendingConfirmations,
} from '../../../src/services/dialogue/session-runtime.ts';
import {
  type DialogueV3Session,
  type EventCreateDraft,
  emptyDraft,
  PENDING_EFFECT_LEDGER,
} from '../../../src/services/dialogue/v3-types.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { localToGoogle } from '../../../src/services/google/event-mapper.ts';
import { InvitationService } from '../../../src/services/sharing/invitation-service.ts';

function eventsOf(db: DatabaseService, userId: number) {
  return db.events.getVisibleInRange(userId, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z');
}

function makeCtx(chatId: number, user: User, sentTexts: string[]): BotCommandContext {
  const send = mock(async (text: string) => {
    sentTexts.push(text);
  });
  return { chatId, dbUser: user, lang: 'en', send } as unknown as BotCommandContext;
}

function makeShell(user: User, timezone: string): DialogueV3Session {
  const now = Date.now();
  return {
    version: 3,
    sessionId: 'sess-1',
    actorId: user.telegram_id,
    chatId: user.telegram_id,
    topicId: 0,
    operation: 'event.create',
    timezone,
    selectedDate: '2026-09-30',
    draft: emptyDraft('personal'),
    pendingField: null,
    pendingFuzzyPeople: [],
    status: 'collecting',
    revision: 0,
    executionReceipt: null,
    createdAt: now,
    updatedAt: now,
    sourceText: 'test',
  };
}

function keyFor(user: User): DialogueSessionKey {
  return { chatId: user.telegram_id, userId: user.telegram_id, topicId: 0 };
}

describe(
  'executeDraft — all-day storage boundary (blocker: must reuse wall-clock.ts localMidnightInstant ' +
    'verbatim, never a second UTC-midnight conversion that recreates the negative-offset day-shift bug)',
  () => {
    function allDayHarness(timezone: string) {
      const db = new DatabaseService(':memory:');
      const user = db.users.create({ telegram_id: 7, language: 'en', timezone });
      const eventService = new EventService({ eventRepo: db.events });
      const sentTexts: string[] = [];
      const ctx = makeCtx(user.telegram_id, user, sentTexts);
      const deps: SessionRuntimeDeps = { eventService, dialogueSessions: db.dialogueSessions };
      return { db, user, eventService, ctx, deps };
    }

    function allDayDraft(startDate: string, endDateExclusive: string): EventCreateDraft {
      return applyParseResultToDraft(
        emptyDraft('personal'),
        { title: 'Holiday', schedule: { kind: 'all_day', startDate, endDateExclusive } },
        60,
      );
    }

    async function createAllDay(timezone: string, startDate: string, endDateExclusive: string) {
      const { user, ctx, deps } = allDayHarness(timezone);
      const draft = allDayDraft(startDate, endDateExclusive);
      const shell = makeShell(user, timezone);
      const session: DialogueV3Session = { ...shell, draft, status: 'collecting', revision: 0, executionReceipt: null };
      const outcome = await executeDraft(ctx, user, draft, timezone, session, null, keyFor(user), deps);
      if (outcome.kind !== 'executed') throw new Error('expected executed');
      return outcome.event;
    }

    test('PARENT all-day case: a negative-offset zone (New York, 2027-03-10) keeps the chosen calendar date, never the naive UTC-midnight day-shift', async () => {
      const event = await createAllDay('America/New_York', '2027-03-10', '2027-03-11');
      // Naive UTC midnight ("...T00:00:00.000Z") reads back as March 9 in America/New_York
      // (-05:00 in March); the real local-midnight instant keeps the calendar day on both ends.
      expect(event.start_at).toBe('2027-03-10T00:00:00.000-05:00');
      expect(event.end_at).toBe('2027-03-11T00:00:00.000-05:00');
      expect(event.start_at.slice(0, 10)).toBe('2027-03-10');
      expect(event.end_at!.slice(0, 10)).toBe('2027-03-11');
    });

    test('a positive-offset zone (Tokyo) also keeps the chosen calendar date, offset-preserving, never "Z"', async () => {
      const event = await createAllDay('Asia/Tokyo', '2027-04-10', '2027-04-11');
      expect(event.start_at).toBe('2027-04-10T00:00:00.000+09:00');
      expect(event.end_at).toBe('2027-04-11T00:00:00.000+09:00');
    });

    test('a spring-forward all-day event spans 23 real hours, never a fixed 86,400,000ms day', async () => {
      // New York's clocks skip forward on 2027-03-14 (02:00 -> 03:00): midnight to midnight is
      // only 23 real hours — a fixed 86,400,000ms addition instead of resolving the real next
      // local midnight would end 1 hour early.
      const event = await createAllDay('America/New_York', '2027-03-14', '2027-03-15');
      expect(event.start_at).toBe('2027-03-14T00:00:00.000-05:00');
      expect(event.end_at).toBe('2027-03-15T00:00:00.000-04:00');
      const spanMs = Date.parse(event.end_at!) - Date.parse(event.start_at);
      expect(spanMs).toBe(23 * 60 * 60 * 1000);
      expect(spanMs).not.toBe(86_400_000);
    });

    test('a fall-back all-day event spans 25 real hours, never a fixed 86,400,000ms day', async () => {
      // New York's clocks fall back on 2027-11-07 (02:00 -> 01:00): that calendar day is 25 real
      // hours long.
      const event = await createAllDay('America/New_York', '2027-11-07', '2027-11-08');
      expect(event.start_at).toBe('2027-11-07T00:00:00.000-04:00');
      expect(event.end_at).toBe('2027-11-08T00:00:00.000-05:00');
      const spanMs = Date.parse(event.end_at!) - Date.parse(event.start_at);
      expect(spanMs).toBe(25 * 60 * 60 * 1000);
      expect(spanMs).not.toBe(86_400_000);
    });

    test('the offset-preserving stored format still maps to the correct Google start.date/end.date', async () => {
      const event = await createAllDay('America/New_York', '2027-03-10', '2027-03-11');
      const mapped = localToGoogle(event);
      expect(mapped.start?.date).toBe('2027-03-10');
      expect(mapped.end?.date).toBe('2027-03-11');
    });
  },
);

describe('applyParseResultToDraft — field provenance and computed end time', () => {
  test('a fresh draft starts every field at "missing" provenance', () => {
    const draft = emptyDraft('personal');
    expect(draft.provenance).toEqual({
      title: 'missing',
      schedule: 'missing',
      people: 'missing',
      place: 'missing',
      description: 'missing',
      recurrence: 'missing',
    });
  });

  test('supplying title marks its provenance "supplied" without touching other fields', () => {
    const draft = applyParseResultToDraft(emptyDraft('personal'), { title: 'Meeting' }, 60);
    expect(draft.title).toBe('Meeting');
    expect(draft.provenance.title).toBe('supplied');
    expect(draft.provenance.schedule).toBe('missing');
  });

  test('a timed schedule computes endAt once, using the caller-supplied default duration', () => {
    const draft = applyParseResultToDraft(
      emptyDraft('personal'),
      { schedule: { kind: 'timed', startAt: '2026-09-30T12:00:00.000Z' } },
      30,
    );
    expect(draft.endAt).toBe('2026-09-30T12:30:00.000Z');
    expect(draft.provenance.schedule).toBe('supplied');
  });

  test('an all-day schedule never computes a timed endAt', () => {
    const draft = applyParseResultToDraft(
      emptyDraft('personal'),
      { schedule: { kind: 'all_day', startDate: '2026-09-30', endDateExclusive: '2026-10-01' } },
      60,
    );
    expect(draft.endAt).toBeUndefined();
  });

  test('people accumulate across turns rather than being replaced', () => {
    const first = applyParseResultToDraft(
      emptyDraft('personal'),
      { people: [{ contactId: 1, telegramId: 501, displayName: 'Lena', confirmed: true }] },
      60,
    );
    const second = applyParseResultToDraft(
      first,
      { people: [{ contactId: 2, telegramId: 502, displayName: 'Anton', confirmed: true }] },
      60,
    );
    expect(second.people.map((p) => p.displayName)).toEqual(['Lena', 'Anton']);
  });

  test('recurrence is never populated by this function — GH-657 owns recurrence-phrase parsing, and no field here ever carries raw recurrence text into execution (blocker: raw recurrence text cannot execute unexamined)', () => {
    const draft = applyParseResultToDraft(emptyDraft('personal'), { title: 'Weekly sync every Monday' }, 60);
    expect(draft.recurrenceRule).toBeUndefined();
    expect(draft.provenance.recurrence).toBe('missing');
  });
});

describe('toPendingConfirmations — merges fuzzy and unresolved names into one confirmation queue', () => {
  test('a real fuzzy match and a zero-candidate unresolved name are both represented, fuzzy first', () => {
    const result = toPendingConfirmations(
      [
        {
          rawName: 'Kristin',
          candidates: [{ contactId: 1, telegramId: 501, displayName: 'Kristina', confidence: 0.9 }],
        },
      ],
      ['Zorblax'],
    );
    expect(result).toEqual([
      { rawName: 'Kristin', candidates: [{ contactId: 1, telegramId: 501, displayName: 'Kristina', confidence: 0.9 }] },
      { rawName: 'Zorblax', candidates: [] },
    ]);
  });

  test('no fuzzy and no unresolved names yields an empty queue', () => {
    expect(toPendingConfirmations([], [])).toEqual([]);
  });
});

describe('inviteResolvedPeople — never claims delivered when live delivery actually failed (blocker: invitation delivery must never be silently reported as success)', () => {
  function harness() {
    const db = new DatabaseService(':memory:');
    const user = db.users.create({ telegram_id: 1, language: 'en', timezone: 'UTC' });
    db.users.create({ telegram_id: 501, language: 'en', timezone: 'UTC' });
    const eventService = new EventService({ eventRepo: db.events });
    const event = eventService.createEvent({
      user_id: user.telegram_id,
      title: 'Meeting',
      start_at: '2026-09-30T12:00:00.000Z',
      end_at: '2026-09-30T13:00:00.000Z',
      timezone: 'UTC',
    });
    const invitationService = new InvitationService(db.invitations, db.events, db.sharingSettings, db.participants);
    return { db, user, event, invitationService };
  }

  test('a Bot-API send failure with no MTProto/deep-link fallback available is reported as failed, never delivered', async () => {
    const { db, user, event, invitationService } = harness();
    const person = { contactId: 1, telegramId: 501, displayName: 'Lena', confirmed: true };
    const outcome = await inviteResolvedPeople(event, user, [person], 'en', {
      invitationService,
      invitationDelivery: {
        // Bot API delivery fails outright (returns null, matching TelegramSender's own
        // "delivery failed" contract) and no deep-link/MTProto capability is configured —
        // there is genuinely no way this invitation reached anyone.
        sender: {
          sendMessage: async () => ({ message_id: 1 }),
          editMessageText: async () => {},
          sendInvitation: async () => null,
        },
        invitationRepo: db.invitations,
        userRepo: db.users,
      },
    });
    expect(outcome.delivered).toEqual([]);
    expect(outcome.pendingManualForward).toEqual([]);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]?.person.displayName).toBe('Lena');
    // The Invitation record itself was still created (real, queryable, resendable) — only the
    // live push failed; the outcome must not conflate "record exists" with "delivered".
    expect(db.invitations.getByEvent(event.id)).toHaveLength(1);
  });

  test('a thrown delivery error is reported as failed, never silently upgraded to delivered', async () => {
    const { db, user, event, invitationService } = harness();
    const person = { contactId: 1, telegramId: 501, displayName: 'Lena', confirmed: true };
    const outcome = await inviteResolvedPeople(event, user, [person], 'en', {
      invitationService,
      invitationDelivery: {
        sender: {
          sendMessage: async () => ({ message_id: 1 }),
          editMessageText: async () => {},
          sendInvitation: async () => {
            throw new Error('network error');
          },
        },
        invitationRepo: db.invitations,
        userRepo: db.users,
      },
    });
    expect(outcome.delivered).toEqual([]);
    expect(outcome.failed).toHaveLength(1);
  });

  test('no invitationDelivery configured at all never claims delivered just because the Invitation row exists', async () => {
    const { db, user, event, invitationService } = harness();
    const person = { contactId: 1, telegramId: 501, displayName: 'Lena', confirmed: true };
    const outcome = await inviteResolvedPeople(event, user, [person], 'en', { invitationService });
    expect(outcome.delivered).toEqual([]);
    expect(outcome.failed).toHaveLength(1);
    expect(db.invitations.getByEvent(event.id)).toHaveLength(1);
  });
});

describe(
  'executeDraft — durable post-create effect ledger (parent blocker: executeDraft immediately ' +
    'deleted the session before invitations/hooks/receipt reconciled; a crash/failure after event ' +
    'creation lost the only durable applied/unknown ledger and could not be resumed)',
  () => {
    function harness() {
      const db = new DatabaseService(':memory:');
      const user = db.users.create({ telegram_id: 1, language: 'en', timezone: 'UTC' });
      const eventService = new EventService({ eventRepo: db.events });
      const sentTexts: string[] = [];
      const ctx = makeCtx(user.telegram_id, user, sentTexts);
      return { db, user, eventService, ctx, sentTexts };
    }

    function timedDraft(title: string, people: EventCreateDraft['people'] = []): EventCreateDraft {
      return applyParseResultToDraft(
        emptyDraft('personal'),
        { title, schedule: { kind: 'timed', startAt: '2026-09-30T12:00:00.000Z' }, people },
        60,
      );
    }

    function collectingSession(user: User, draft: EventCreateDraft): DialogueV3Session {
      const shell = makeShell(user, 'UTC');
      return { ...shell, draft, status: 'collecting', revision: 0, executionReceipt: null };
    }

    test('a crash immediately after event creation — invitation delivery throwing before it completes — leaves the ledger honestly "unknown", never blind-retried, and the event is created exactly once', async () => {
      const { db, user, eventService, ctx } = harness();
      const draft = timedDraft('Meeting', [{ contactId: 1, telegramId: 501, displayName: 'Lena', confirmed: true }]);
      const session = collectingSession(user, draft);
      let sendInvitationCalls = 0;
      const deps: SessionRuntimeDeps = {
        eventService,
        dialogueSessions: db.dialogueSessions,
        invitationService: {
          sendInvitation: () => {
            sendInvitationCalls++;
            throw new Error('database exploded mid-invitation');
          },
        } as unknown as InvitationService,
      };

      const outcome = await executeDraft(ctx, user, draft, 'UTC', session, null, keyFor(user), deps);
      expect(outcome.kind).toBe('executed');
      if (outcome.kind !== 'executed') throw new Error('unreachable');
      expect(eventsOf(db, user.telegram_id)).toHaveLength(1);
      expect(sendInvitationCalls).toBe(1);

      const persisted = db.dialogueSessions.get(keyFor(user));
      expect(persisted).not.toBeNull();
      expect(persisted?.status).toBe('executed');
      if (persisted?.executionReceipt?.status !== 'applied') throw new Error('expected an applied receipt');
      expect(persisted.executionReceipt.eventId).toBe(outcome.event.id);
      expect(persisted.executionReceipt.effects.invitations).toBe('unknown');
      // Neither post-create hooks nor the receipt were configured to fail here, so both settled —
      // only the genuinely ambiguous invitation-delivery throw keeps this ledger unreconciled.
      expect(persisted.executionReceipt.effects.postCreateHooks).toBe('applied');
      expect(persisted.executionReceipt.effects.receipt).toBe('applied');

      // "Process resumes by re-reading session": a later turn/restart must never call
      // EventService.createEvent again, and must never blind-retry the now-`unknown` invitation
      // effect just because a fresh attempt might happen to succeed.
      const resumed = await resumeExecutedSession(ctx, user, persisted, keyFor(user), deps);
      expect(resumed.reconciled).toBe(false);
      expect(sendInvitationCalls).toBe(1);
      expect(eventsOf(db, user.telegram_id)).toHaveLength(1);
      expect(db.dialogueSessions.get(keyFor(user))).not.toBeNull();
    });

    test('a rejecting Google-push post-create hook is caught, marks only that effect "unknown", and the receipt still reaches the user (blocker: onEventCreated rejecting must not crash the whole execution)', async () => {
      const { db, user, eventService, ctx, sentTexts } = harness();
      const draft = timedDraft('Standup');
      const session = collectingSession(user, draft);
      let hookCalls = 0;
      const deps: SessionRuntimeDeps = {
        eventService,
        dialogueSessions: db.dialogueSessions,
        onEventCreated: async () => {
          hookCalls++;
          throw new Error('Google Calendar API is down');
        },
      };

      const outcome = await executeDraft(ctx, user, draft, 'UTC', session, null, keyFor(user), deps);
      expect(outcome.kind).toBe('executed');
      if (outcome.kind !== 'executed') throw new Error('unreachable');
      expect(eventsOf(db, user.telegram_id)).toHaveLength(1);
      expect(hookCalls).toBe(1);
      expect(sentTexts.length).toBeGreaterThan(0);

      const persisted = db.dialogueSessions.get(keyFor(user));
      if (persisted?.executionReceipt?.status !== 'applied') throw new Error('expected an applied receipt');
      expect(persisted.executionReceipt.eventId).toBe(outcome.event.id);
      expect(persisted.executionReceipt.effects.postCreateHooks).toBe('unknown');
      // Nobody to invite, and the receipt itself succeeded — only the hook stays unresolved.
      expect(persisted.executionReceipt.effects.invitations).toBe('applied');
      expect(persisted.executionReceipt.effects.receipt).toBe('applied');
    });

    test('sendReceipt failing (e.g. Telegram unreachable) is caught, marks that effect "unknown", and never loses the already-created event (blocker: sendReceipt failing must not lose the durable event/session record)', async () => {
      const db = new DatabaseService(':memory:');
      const user = db.users.create({ telegram_id: 1, language: 'en', timezone: 'UTC' });
      const eventService = new EventService({ eventRepo: db.events });
      const send = mock(async () => {
        throw new Error('Telegram API unreachable');
      });
      const ctx = { chatId: user.telegram_id, dbUser: user, lang: 'en', send } as unknown as BotCommandContext;
      const draft = timedDraft('Dentist');
      const session = collectingSession(user, draft);
      const deps: SessionRuntimeDeps = { eventService, dialogueSessions: db.dialogueSessions };

      const outcome = await executeDraft(ctx, user, draft, 'UTC', session, null, keyFor(user), deps);
      expect(outcome.kind).toBe('executed');
      if (outcome.kind !== 'executed') throw new Error('unreachable');
      expect(eventsOf(db, user.telegram_id)).toHaveLength(1);

      const persisted = db.dialogueSessions.get(keyFor(user));
      expect(persisted).not.toBeNull();
      if (persisted?.executionReceipt?.status !== 'applied') throw new Error('expected an applied receipt');
      expect(persisted.executionReceipt.eventId).toBe(outcome.event.id);
      expect(persisted.executionReceipt.effects.receipt).toBe('unknown');
      expect(persisted.executionReceipt.effects.invitations).toBe('applied');
      expect(persisted.executionReceipt.effects.postCreateHooks).toBe('applied');
      // The event itself remains fully discoverable by its durable id despite the send failure.
      expect(eventService.getEvent(outcome.event.id, user.telegram_id)?.id).toBe(outcome.event.id);
    });

    test('a process restart resumes by re-reading the persisted session — never recreates the event, only completes the effects still pending, and deletes the session once fully reconciled', async () => {
      const { db, user, eventService, ctx, sentTexts } = harness();
      const event = eventService.createEvent({
        user_id: user.telegram_id,
        title: 'Recovered meeting',
        start_at: '2026-10-01T10:00:00.000Z',
        end_at: '2026-10-01T10:30:00.000Z',
        timezone: 'UTC',
      });
      const draft = timedDraft('Recovered meeting');
      const shell = makeShell(user, 'UTC');
      let hookCalls = 0;
      const deps: SessionRuntimeDeps = {
        eventService,
        dialogueSessions: db.dialogueSessions,
        onEventCreated: async () => {
          hookCalls++;
        },
      };
      // Simulates a process that crashed immediately after creating the event and persisting the
      // initial all-pending ledger, before attempting a single post-create effect.
      const executedSession: DialogueV3Session = {
        ...shell,
        draft,
        status: 'executed',
        revision: 0,
        executionReceipt: {
          status: 'applied',
          eventId: event.id,
          appliedAtRevision: 0,
          effects: PENDING_EFFECT_LEDGER,
          inviteOutcome: null,
        },
      };
      const inserted = db.dialogueSessions.set(keyFor(user), executedSession, null);
      expect(inserted.ok).toBe(true);

      const persisted = db.dialogueSessions.get(keyFor(user));
      expect(persisted).not.toBeNull();
      const result = await resumeExecutedSession(ctx, user, persisted!, keyFor(user), deps);

      expect(result.reconciled).toBe(true);
      expect(hookCalls).toBe(1);
      expect(sentTexts).toHaveLength(1);
      // EventService.createEvent was never called again — exactly the one event from before the
      // "restart" exists.
      expect(eventsOf(db, user.telegram_id)).toHaveLength(1);
      expect(db.dialogueSessions.get(keyFor(user))).toBeNull();
      // The applied eventId remains discoverable through the real event record even after the
      // session row itself is gone.
      expect(eventService.getEvent(event.id, user.telegram_id)?.id).toBe(event.id);
    });

    test('two concurrent executeDraft calls for the same fresh session key create the event exactly once (blocker: duplicate concurrent execution must never double-create)', async () => {
      const { db, user, eventService, ctx } = harness();
      const draft = timedDraft('Race');
      const session = collectingSession(user, draft);
      const deps: SessionRuntimeDeps = { eventService, dialogueSessions: db.dialogueSessions };

      const [first, second] = await Promise.all([
        executeDraft(ctx, user, draft, 'UTC', session, null, keyFor(user), deps),
        executeDraft(ctx, user, draft, 'UTC', session, null, keyFor(user), deps),
      ]);

      const kinds = [first.kind, second.kind].sort();
      expect(kinds).toEqual(['executed', 'race_lost']);
      expect(eventsOf(db, user.telegram_id)).toHaveLength(1);
    });
  },
);
