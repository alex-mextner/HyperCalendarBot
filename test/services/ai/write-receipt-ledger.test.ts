/**
 * Write-receipt suite, part 2: ledger identity and dates, repeated creates and the create key.
 * Fixtures live in write-receipt-helpers.ts; part 1 is write-receipt.test.ts.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { WRITE_TOOLS } from '../../../src/services/ai/tool-executor.ts';
import { occurrenceToSummary } from '../../../src/services/ai/tool-handlers/events/presentation.ts';
import { WriteOutcomes } from '../../../src/services/ai/write-outcomes.ts';
import {
  created,
  eventNotFound,
  exec,
  FRIEND,
  OWNER,
  okCall,
  type Recorded,
  receipt,
  receiptViewFor,
  rejectedCreate,
  secretaryContext,
  uncertain,
} from './write-receipt-helpers.ts';

beforeEach(() => setSystemTime(new Date('2026-10-31T09:00:00Z')));
afterEach(() => setSystemTime());

describe('ledger identity and dates (regressions)', () => {
  const deleted: Recorded = {
    success: true,
    disposition: 'executed',
    mutationState: 'confirmed',
    effect: { kind: 'event_deleted' },
  };
  const personal = { title: 'Board games', start_at: '2026-10-31T17:00:00Z' };

  test('a failed recreation stays visible after the earlier create was deleted', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', personal, created);
    ledger.record('delete_event', { event_id: 501 }, deleted);
    ledger.record('create_event', personal, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created: event “Board games”');
  });

  test('declining an event (attendance_declined) does not retire the create of that event', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', personal, created);
    ledger.record('delete_event', { event_id: 501 }, { ...deleted, effect: { kind: 'attendance_declined' } });
    ledger.record('create_event', personal, rejectedCreate);
    const text = ledger.finalNotice(receiptViewFor('en')) ?? '';
    expect(text).not.toContain('Not created');
  });

  test('an impossible calendar date is not turned into another day', () => {
    for (const allDay of [true, false]) {
      const ledger = new WriteOutcomes(WRITE_TOOLS);
      ledger.record('create_event', { title: 'Board games', start_at: '2030-02-31', all_day: allDay }, rejectedCreate);
      const text = ledger.finalNotice(receiptViewFor('en')) ?? '';
      expect(text).toContain('Not created: event “Board games”');
      expect(text).not.toMatch(/March|00:00/);
    }
  });

  test('an extra event_id in a create input does not rename the created event', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { ...personal, event_id: 777 }, created);
    ledger.record('send_invitation', { event_id: 501, invitee_id: FRIEND }, eventNotFound);
    const text = ledger.finalNotice(receiptViewFor('en')) ?? '';
    expect(text).toContain('Created: event “Board games”');
    expect(text).toContain('The invitation to “Board games” was not sent');
  });

  test('listing the occurrences of a created series keeps the created day', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    const series: Recorded = {
      ...created,
      data: { id: 502, title: 'Board games', date: '2026-04-15', time: '17:00', all_day: false },
    };
    ledger.record(
      'create_event',
      { ...personal, start_at: '2026-04-15T17:00:00Z', recurrence_rule: 'FREQ=DAILY;COUNT=3' },
      series,
    );
    const read: Recorded = {
      success: true,
      disposition: 'executed',
      data: {
        id: 502,
        title: 'Board games',
        date: '2026-04-17',
        time: '17:00',
        all_day: false,
        recurrence_rule: 'FREQ=DAILY;COUNT=3',
      },
    };
    ledger.record('get_events', {}, read);
    ledger.record('send_invitation', { event_id: 502, invitee_id: FRIEND }, eventNotFound);
    const text = ledger.finalNotice({ ...receiptViewFor('en'), now: new Date('2026-04-14T09:00:00Z') }) ?? '';
    expect(text).toContain('tomorrow, 17:00');
    expect(text).not.toContain('April 17');
  });

  test('all_day "false" is not all-day: the string and the boolean form are the same create', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { ...personal, all_day: 'false', end_at: 'invalid' }, rejectedCreate);
    ledger.record('create_event', { ...personal, all_day: false }, created);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });

  test('a failed all-day create is not hidden by a timed create at the same instant', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { ...personal, all_day: 'true' }, rejectedCreate);
    ledger.record('create_event', { ...personal, all_day: false }, created);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created');
  });

  // Reachable all-day spellings of one date (start_at accepts YYYY-MM-DD and any offset instant): the
  // date-only form and 'T00:00:00Z' are one UTC midnight; a zone ahead of UTC adds the local midnight
  // expressed in UTC. The bot reads all three as the same calendar day (allDayCalendarDate), so a
  // reject-then-retry using two of them is one event and must not read "Not created" plus "Created".
  describe('one-off all-day creates are one event when they name the same calendar day', () => {
    const tz = 'Europe/Belgrade';
    const dayOf = (id: number, date: string): Recorded => ({
      ...created,
      data: { id, title: 'Board games', date, all_day: true },
    });
    const allDay = (start_at: string, extra: object = {}) => ({
      title: 'Board games',
      all_day: true,
      start_at,
      ...extra,
    });
    const spellings = ['2030-04-15', '2030-04-15T00:00:00Z', '2030-04-14T22:00:00Z', '2030-04-15T00:00:00+02:00'];

    test.each(
      spellings.flatMap((a) => spellings.map((b) => [a, b] as const)),
    )('reject %s, then create %s', (rejected, retried) => {
      const ledger = new WriteOutcomes(WRITE_TOOLS);
      ledger.record('create_event', allDay(rejected, { end_at: 'invalid' }), rejectedCreate, false, tz);
      ledger.record('create_event', allDay(retried), dayOf(503, '2030-04-15'), false, tz);
      expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
    });

    test('a created all-day event absorbs a rejected retry in another spelling', () => {
      const ledger = new WriteOutcomes(WRITE_TOOLS);
      ledger.record('create_event', allDay('2030-04-14T22:00:00Z'), dayOf(503, '2030-04-15'), false, tz);
      ledger.record('create_event', allDay('2030-04-15'), rejectedCreate, false, tz);
      expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
    });

    test('an impossible date is never rolled into a real day to match another create', () => {
      const ledger = new WriteOutcomes(WRITE_TOOLS);
      ledger.record('create_event', allDay('2030-02-31T23:00:00Z'), rejectedCreate, false, tz);
      ledger.record('create_event', allDay('2030-03-04'), dayOf(503, '2030-03-04'), false, tz);
      expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created');
    });

    test('another calendar day stays a separate, visible failure', () => {
      const ledger = new WriteOutcomes(WRITE_TOOLS);
      ledger.record('create_event', allDay('2030-04-16', {}), rejectedCreate, false, tz);
      ledger.record('create_event', allDay('2030-04-14T22:00:00Z'), dayOf(503, '2030-04-15'), false, tz);
      expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created');
    });

    test('recurring all-day spellings stay distinct: a series expands from its start instant', () => {
      const rule = { recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=2' };
      const ledger = new WriteOutcomes(WRITE_TOOLS);
      ledger.record('create_event', allDay('2030-04-14T22:00:00Z', rule), dayOf(504, '2030-04-16'), false, tz);
      ledger.record('create_event', allDay('2030-04-15', rule), rejectedCreate, false, tz);
      expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created');
    });

    test('a timed create at the same instant is a different event from the all-day one', () => {
      const ledger = new WriteOutcomes(WRITE_TOOLS);
      ledger.record('create_event', allDay('2030-04-15'), rejectedCreate, false, tz);
      ledger.record(
        'create_event',
        { title: 'Board games', start_at: '2030-04-15' },
        dayOf(505, '2030-04-15'),
        false,
        tz,
      );
      expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created');
    });
  });

  test('a rejected all-day create shows the calendar day the handler stores, not the UTC day', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record(
      'create_event',
      { title: 'Board games', start_at: '2030-04-14T22:00:00Z', all_day: true },
      rejectedCreate,
    );
    const view = { ...receiptViewFor('en'), timezone: 'Europe/Belgrade', now: new Date('2030-04-01T09:00:00Z') };
    expect(ledger.finalNotice(view)).toContain('April 15');
  });

  test('a timed date-only start is read as the UTC instant the handler stores, in the user zone', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { title: 'Board games', start_at: '2030-04-15' }, rejectedCreate);
    const view = { ...receiptViewFor('en'), timezone: 'America/New_York', now: new Date('2030-04-01T09:00:00Z') };
    expect(ledger.finalNotice(view)).toContain('April 14, 20:00');
  });

  test('a long name is cut by code point, never through a surrogate pair', () => {
    const ctx = secretaryContext('en', false, { friend: `${'a'.repeat(39)}😀tail` });
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('send_invitation', { event_id: 501, invitee_id: FRIEND }, eventNotFound);
    const text = receipt(ledger, ctx).evidence ?? '';
    expect(text).toContain(`${'a'.repeat(39)}😀`);
    expect(text.isWellFormed()).toBe(true);
  });
});

describe('a repeated create that ends unknown (exact texts)', () => {
  const req = { title: 'Board games', start_at: '2026-10-31T17:00:00Z' };
  const ru =
    'Повторное создание не удалось подтвердить: событие «Board games» (сегодня, 17:00). Проверь календарь на дубль.';
  const en =
    'A repeat of the creation could not be confirmed: event “Board games” (today, 17:00). Check the calendar for a duplicate.';
  const first = 'Повторная попытка удалась, но первая могла тоже сработать: проверь календарь на дубль.';
  const firstEn = 'The retry worked, but the first try may have gone through too: check the calendar for a duplicate.';

  test('success, then an unknown repeat: the repeat is the unconfirmed one', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', req, created);
    ledger.record('create_event', req, uncertain);
    const lines = (lang: 'ru' | 'en') =>
      ledger.finalNotice({ ...receiptViewFor(lang), now: new Date('2026-10-31T08:00:00Z') })?.split('\n') ?? [];
    expect(lines('en')).toContain(en);
    expect(lines('en')).not.toContain(firstEn);
    expect(lines('ru')).toContain(ru);
    expect(lines('ru')).not.toContain(first);
  });
});

describe('the create key covers end, location and description', () => {
  const call = { title: 'Call', start_at: '2026-10-31T10:00:00Z', end_at: '2026-10-31T10:30:00Z' };

  test.each([
    ['end_at', { end_at: '2026-10-31T11:00:00Z' }],
    ['location', { location: 'Office' }],
    ['description', { description: 'Agenda' }],
  ])('a failed create that differs in %s stays visible', (_field, other) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, ...other }, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created: event “Call”');
  });

  test('absent, empty and blank location or description are the same create', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: '  ', description: '' }, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });

  test('an update that changes the location retires the create; one that restates it does not', () => {
    const base = { ...call, location: 'Office' };
    const changed = new WriteOutcomes(WRITE_TOOLS);
    changed.record('create_event', base, okCall);
    changed.record('update_event', { event_id: 601, location: 'Home' }, okCall);
    changed.record('create_event', base, rejectedCreate);
    expect(changed.finalNotice(receiptViewFor('en'))).toContain('Not created');
    const same = new WriteOutcomes(WRITE_TOOLS);
    same.record('create_event', base, okCall);
    same.record('update_event', { event_id: 601, location: ' Office ' }, okCall);
    same.record('create_event', base, rejectedCreate);
    expect(same.finalNotice(receiptViewFor('en'))).toBeNull();
  });
});

describe('a corrected retry settles the rejected attempt, whatever it corrected', () => {
  const base = { title: 'Board games', start_at: '2026-10-31T17:00:00Z' };

  test.each([
    ['end_at', { end_at: 'invalid' }, { end_at: '2026-10-31T18:00:00Z' }],
    ['location', { location: 'Office' }, { location: 'office' }],
    ['description', { description: 'Bring snacks' }, { description: 'Bring drinks' }],
  ])('rejected with one %s, then created with another: no Not created line', (_field, wrong, fixed) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { ...base, ...wrong }, rejectedCreate);
    ledger.record('create_event', { ...base, ...fixed }, created);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });
});

describe('end spellings of one all-day date', () => {
  const tz = 'Europe/Belgrade';
  const day: Recorded = exec({ data: { id: 801, title: 'Board games', date: '2030-04-15', all_day: true } });
  const allDay = (start_at: string, end_at: string) => ({ title: 'Board games', all_day: true, start_at, end_at });

  test('a rejected repeat with the end spelled another way adds nothing', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', allDay('2030-04-14T22:00:00Z', '2030-04-14T22:00:00Z'), day, false, tz);
    ledger.record('create_event', allDay('2030-04-15', '2030-04-15'), rejectedCreate, false, tz);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });

  test('restating the end in another spelling does not retire the create', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', allDay('2030-04-14T22:00:00Z', '2030-04-14T22:00:00Z'), day, false, tz);
    ledger.record('update_event', { event_id: 801, end_at: '2030-04-15' }, day, false, tz);
    ledger.record('create_event', allDay('2030-04-14T22:00:00Z', '2030-04-14T22:00:00Z'), rejectedCreate, false, tz);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });
});

describe('create identity and retirement: pinned details', () => {
  const req = { title: 'Board games', start_at: '2026-10-31T10:00:00Z' };
  const row = (id: number, title: string): Recorded =>
    exec({ data: { id, title, date: '2026-10-31', time: '10:00', all_day: false } });

  test('the calendar owner is part of the create key', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { ...req, owner_id: OWNER }, rejectedCreate);
    ledger.record('create_event', req, row(701, 'Board games'));
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created');
  });

  test('deleting another event does not retire this create', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', req, row(701, 'Board games'));
    ledger.record('create_event', { title: 'Chess', start_at: '2026-10-31T12:00:00Z' }, row(702, 'Chess'));
    ledger.record('delete_event', { event_id: 702 }, exec({ effect: { kind: 'event_deleted' } }));
    ledger.record('create_event', req, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });

  test('an update whose confirmed result carries another title retires the create, whatever the input says', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', req, row(701, 'Board games'));
    ledger.record('update_event', { event_id: 701, category: 'work' }, row(701, 'Chess'));
    ledger.record('create_event', req, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created');
  });
});

describe('the duplicate warning names the repeated request, not the event as it is now', () => {
  const req = { title: 'Board games', start_at: '2026-10-31T17:00:00Z' };
  const ok = exec({ data: { id: 501, title: 'Board games', date: '2026-10-31', time: '17:00', all_day: false } });
  const view = (hide = false) => ({
    ...receiptViewFor('en'),
    hideTargets: hide,
    now: new Date('2026-10-31T08:00:00Z'),
  });

  test('an update after the repeat does not rename the event in the warning', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', req, ok);
    ledger.record('create_event', req, uncertain);
    ledger.record(
      'update_event',
      { event_id: 501, title: 'Chess', start_at: '2026-10-31T19:00:00Z' },
      exec({ data: { id: 501, title: 'Chess', date: '2026-10-31', time: '19:00', all_day: false } }),
    );
    expect(ledger.finalNotice(view())?.split('\n')).toContain(
      'A repeat of the creation could not be confirmed: event “Board games” (today, 17:00). Check the calendar for a duplicate.',
    );
  });

  test('the warning is built from the repeat itself, as it was worded', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', req, ok);
    ledger.record('create_event', { ...req, title: ' board   GAMES ' }, uncertain);
    expect(ledger.finalNotice(view())).toContain('event “board GAMES” (today, 17:00)');
  });
});

describe("an event's day and time come only from the write itself", () => {
  const seriesEvent = {
    id: 9,
    title: 'Standup',
    start_at: '2026-04-02T10:00:00.000Z',
    end_at: null,
    all_day: 0,
    recurrence_rule: 'FREQ=DAILY;COUNT=3',
  } as unknown as Parameters<typeof occurrenceToSummary>[0]['event'];
  const row = (start: string) =>
    occurrenceToSummary(
      { event: seriesEvent, occurrence_start: start, occurrence_end: null, is_exception: false },
      'UTC',
    );
  const occurrences = (): Recorded =>
    exec({ data: ['2026-04-02', '2026-04-03', '2026-04-04'].map((d) => row(`${d}T10:00:00.000Z`)) });
  const view = () => ({ ...receiptViewFor('en'), now: new Date('2026-03-01T09:00:00Z') });
  const failedUpdate = () => ({ event_id: 9, title: 'Daily' });

  test.each([
    'get_events',
    'get_upcoming',
  ])('occurrence rows of %s, then a failed update: the event is named by title alone', (read) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record(read, {}, occurrences());
    ledger.record('update_event', failedUpdate(), eventNotFound);
    const text = ledger.finalNotice(view()) ?? '';
    expect(text).toContain('Not updated: event “Standup”, fields: title — nothing was changed.');
    expect(text).not.toMatch(/April|10:00/);
  });

  test.each([
    ['get_event', exec({ data: row('2026-04-02T10:00:00.000Z') })],
    ['search_events', exec({ data: [row('2026-04-02T10:00:00.000Z')] })],
  ])('the first start of a series from %s is never a day for a later failed write', (read, result) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record(read, {}, result);
    ledger.record('update_event', failedUpdate(), eventNotFound);
    ledger.record('delete_event', { event_id: 9 }, eventNotFound);
    const text = ledger.finalNotice(view()) ?? '';
    expect(text).toContain('Not updated: event “Standup”');
    expect(text).toContain('Not deleted: event “Standup”');
    expect(text).not.toMatch(/April|10:00/);
  });

  test('a successful update without a start, and its summary, say nothing about the day', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('update_event', failedUpdate(), exec({ data: row('2026-04-02T10:00:00.000Z') }));
    ledger.record('send_invitation', { event_id: 9, invitee_id: FRIEND }, eventNotFound);
    const text = ledger.finalNotice(view()) ?? '';
    expect(text).toContain('Updated: event “Standup”');
    expect(text).not.toMatch(/April|10:00/);
  });

  test('a series the run created is told by its own start, and listing its occurrences changes nothing', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    const rule = 'FREQ=DAILY;COUNT=3';
    ledger.record(
      'create_event',
      { title: 'Standup', start_at: '2026-04-02T10:00:00Z', recurrence_rule: rule },
      exec({ data: row('2026-04-02T10:00:00.000Z') }),
    );
    ledger.record('get_events', {}, occurrences());
    ledger.record('update_event', failedUpdate(), eventNotFound);
    const lines = (ledger.finalNotice(view()) ?? '').split('\n');
    expect(lines).toContain('Created: event “Standup” (April 2, 10:00).');
    expect(lines.find((l) => l.startsWith('Not updated'))).toBe(
      'Not updated: event “Standup”, fields: title — nothing was changed.',
    );
  });

  test('a snooze and a list afterwards leave no pre-snooze time on a later write', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record(
      'create_event',
      { title: 'Standup', start_at: '2026-04-02T10:00:00Z' },
      exec({ data: row('2026-04-02T10:00:00.000Z') }),
    );
    ledger.record('snooze_event', { event_id: 9, minutes: 60 }, exec());
    ledger.record('get_events', {}, exec({ data: [row('2026-04-02T11:00:00.000Z')] }));
    ledger.record('update_event', failedUpdate(), eventNotFound);
    const lines = (ledger.finalNotice(view()) ?? '').split('\n');
    expect(lines.find((l) => l.startsWith('Not updated'))).toBe(
      'Not updated: event “Standup”, fields: title — nothing was changed.',
    );
    const snoozed = lines.find((l) => l.startsWith('Done: change'));
    expect(lines).toContain('Created: event “Standup” (April 2, 10:00).');
    expect(snoozed).toBeDefined();
    expect(snoozed).not.toMatch(/April|10:00|11:00/);
  });

  test.each([
    ['America/New_York', '2030-04-20'],
    ['America/New_York', '2030-04-20T04:00:00Z'],
    ['Europe/Belgrade', '2030-04-20'],
    ['Europe/Belgrade', '2030-04-19T22:00:00Z'],
    ['Pacific/Auckland', '2030-04-20'],
    ['Pacific/Auckland', '2030-04-19T12:00:00Z'],
  ])('%s: a successful update of an all-day start %s is told on the calendar day it wrote', (timezone, start) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    const moved = exec({ data: { id: 9, title: 'Camp', date: '2030-04-19', all_day: true } });
    ledger.record('update_event', { event_id: 9, start_at: start }, moved, false, timezone);
    ledger.record('send_invitation', { event_id: 9, invitee_id: FRIEND }, eventNotFound);
    const text = ledger.finalNotice({ ...receiptViewFor('en'), timezone, now: new Date('2030-04-01T09:00:00Z') }) ?? '';
    expect(text).toContain('Updated: event “Camp” (April 20), fields: start time.');
  });

  test('an all-day flag of null is no flag: a successful update with no summary names the event by title alone', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('get_event', { event_id: 9 }, exec({ data: row('2026-04-02T10:00:00.000Z') }));
    ledger.record(
      'update_event',
      { event_id: 9, start_at: '2030-04-20', all_day: null },
      exec(),
      false,
      'America/New_York',
    );
    expect(ledger.summary({ ...receiptViewFor('en'), timezone: 'America/New_York' })).toContain(
      'Updated: event “Standup”, fields: start time, all day.',
    );
  });

  test('a successful update with no summary and no all-day flag names the event by title alone', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('get_event', { event_id: 9 }, exec({ data: row('2026-04-02T10:00:00.000Z') }));
    ledger.record('update_event', { event_id: 9, start_at: '2030-04-20' }, exec(), false, 'America/New_York');
    ledger.record('send_invitation', { event_id: 9, invitee_id: FRIEND }, eventNotFound);
    const text = ledger.finalNotice({ ...receiptViewFor('en'), timezone: 'America/New_York' }) ?? '';
    expect(text).toContain('Updated: event “Standup”, fields: start time.');
  });

  test.each([
    [
      'a timed update with the flag as a string',
      { event_id: 9, start_at: '2026-04-05T10:00:00Z', all_day: 'false' },
      'Updated: event “Standup” (April 5, 06:00), fields: start time, all day.',
    ],
    [
      'an all-day update with the flag as a string',
      { event_id: 9, start_at: '2030-04-20', all_day: 'true' },
      'Updated: event “Standup” (April 20), fields: start time, all day.',
    ],
  ])('%s with no summary is told by its own start', (_name, input, expected) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('get_event', { event_id: 9 }, exec({ data: row('2026-04-02T10:00:00.000Z') }));
    ledger.record('update_event', input, exec(), false, 'America/New_York');
    expect(
      ledger.summary({ ...receiptViewFor('en'), timezone: 'America/New_York', now: new Date('2026-03-01T09:00:00Z') }),
    ).toContain(expected);
  });

  test('a failed or unconfirmed update that asked for a start names the event by title alone', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('get_event', { event_id: 9 }, exec({ data: row('2026-04-02T10:00:00.000Z') }));
    ledger.record('update_event', { event_id: 9, start_at: '2026-04-05T10:00:00Z' }, eventNotFound);
    ledger.record('update_event', { event_id: 10, start_at: '2026-04-06T10:00:00Z' }, uncertain);
    ledger.record('get_event', { event_id: 10 }, exec({ data: { ...row('2026-04-02T10:00:00.000Z'), id: 10 } }));
    const text = ledger.finalNotice(view()) ?? '';
    expect(text).toContain('Not updated: event “Standup”, fields: start time — nothing was changed.');
    expect(text).toContain('Could not confirm the update: event “Standup”, fields: start time.');
    expect(text).not.toMatch(/April|10:00/);
  });
});
