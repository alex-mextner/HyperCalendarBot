// test/services/dialogue/session-runtime.test.ts
import { describe, expect, test } from 'bun:test';
import { DatabaseService } from '../../../src/database/index.ts';
import {
  applyParseResultToDraft,
  gapSafeLocalMidnight,
  inviteResolvedPeople,
  toPendingConfirmations,
} from '../../../src/services/dialogue/session-runtime.ts';
import { emptyDraft } from '../../../src/services/dialogue/v3-types.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { InvitationService } from '../../../src/services/sharing/invitation-service.ts';

describe('gapSafeLocalMidnight — the all-day calendar-day boundary instant (blocker: must survive negative/positive timezones and DST)', () => {
  test('UTC has no offset — local midnight is UTC midnight', () => {
    expect(gapSafeLocalMidnight('2027-03-10', 'UTC')).toBe('2027-03-10T00:00:00.000Z');
  });

  test('a negative-offset zone (New York, UTC-5 in March) — local midnight is later the same UTC day, never shifted to the previous day', () => {
    expect(gapSafeLocalMidnight('2027-03-10', 'America/New_York')).toBe('2027-03-10T05:00:00.000Z');
  });

  test('a positive-offset zone (Tokyo, UTC+9) — local midnight is the PREVIOUS UTC day, proving a naive UTC-slice read of the stored instant would be off by one day', () => {
    expect(gapSafeLocalMidnight('2027-03-10', 'Asia/Tokyo')).toBe('2027-03-09T15:00:00.000Z');
  });

  test('a DST spring-forward day (New York, 2027-03-14) still resolves to local midnight — the offset used for that day is the PRE-transition one', () => {
    // 2027-03-14 is the US DST start Sunday; midnight itself is still EST (-05:00) — the
    // transition happens later that day (02:00->03:00), not at midnight.
    expect(gapSafeLocalMidnight('2027-03-14', 'America/New_York')).toBe('2027-03-14T05:00:00.000Z');
  });

  test('a real DST transition AT local midnight (America/Sao_Paulo, 2018-11-04 sprang forward 00:00->01:00) is a genuine gap — the bounded forward search lands on the first instant that exists that day, never a naive UTC-literal that could land on the wrong proleptic day', () => {
    // Verified independently: resolveWallInstant returns 'gap' for every minute 0-59 that day;
    // 01:00 local (already -02:00 DST) is the first valid instant, i.e. 2018-11-04T03:00:00Z.
    expect(gapSafeLocalMidnight('2018-11-04', 'America/Sao_Paulo')).toBe('2018-11-04T03:00:00.000Z');
  });

  test('the day after a fall-back fold (New York, 2026-11-02 — DST ended the day before) resolves standard-time midnight, not one of the two folded instants', () => {
    expect(gapSafeLocalMidnight('2026-11-02', 'America/New_York')).toBe('2026-11-02T05:00:00.000Z');
  });
});

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
