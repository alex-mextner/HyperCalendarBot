/**
 * Write-receipt suite, part 3: updates that rewrite an earlier create, refused creates and unsettled writes.
 * Fixtures live in write-receipt-helpers.ts; part 1 is write-receipt.test.ts.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { WRITE_TOOLS } from '../../../src/services/ai/tool-executor.ts';
import { WriteOutcomes } from '../../../src/services/ai/write-outcomes.ts';
import { receiptView } from '../../../src/services/ai/write-receipt.ts';
import {
  created,
  eventNotFound,
  exec,
  FRIEND,
  OWNER,
  okCall,
  type Recorded,
  receiptViewFor,
  rejectedCreate,
  secretaryContext,
  uncertain,
} from './write-receipt-helpers.ts';

beforeEach(() => setSystemTime(new Date('2026-10-31T09:00:00Z')));
afterEach(() => setSystemTime());

describe('an update rewrites what the earlier create now stands for', () => {
  const call = { title: 'Call', start_at: '2026-10-31T10:00:00Z', end_at: '2026-10-31T10:30:00Z' };
  const plain = { title: 'Call', start_at: '2026-10-31T10:00:00Z' };

  test('after a details-only update a failed repeat asking for those details is still folded', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('update_event', { event_id: 601, description: 'Bring snacks' }, okCall);
    ledger.record('create_event', { ...call, description: 'Bring snacks' }, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });

  test('a repeat asking for the old details is a visible failure after such an update', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('update_event', { event_id: 601, description: 'Bring snacks' }, okCall);
    ledger.record('create_event', call, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created');
  });

  test('a failure the update corrected no longer shows', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office' }, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created');
    ledger.record('update_event', { event_id: 601, location: 'Office' }, okCall);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });

  test('an unknown repeat with other details stays its own line and sets no duplicate warning', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office' }, uncertain);
    const text = ledger.finalNotice(receiptViewFor('en')) ?? '';
    expect(text).toContain('Could not confirm creation: event “Call”');
    expect(text).not.toContain('A repeat of the creation');
  });

  type ClearableField = 'end_at' | 'location' | 'description';
  interface CreateInput {
    title: string;
    start_at: string;
    end_at?: string;
    location?: string;
    description?: string;
  }

  test.each<[ClearableField, CreateInput]>([
    ['end_at', call],
    ['location', { ...call, location: 'Office' }],
    ['description', { ...call, description: 'Agenda' }],
  ])('clearing %s makes the event match a create that never had it', (field, original) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', original, okCall);
    ledger.record('update_event', { event_id: 601, [field]: null }, okCall);
    const bare: CreateInput = { ...original };
    delete bare[field];
    ledger.record('create_event', bare, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });

  test('a refused update leaves the create and its refused repeat as they were', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office' }, rejectedCreate);
    ledger.record('update_event', { event_id: 601, location: 'Office' }, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created: event “Call”');
    ledger.record('create_event', { ...call, location: 'Office' }, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created: event “Call”');
  });

  test('a skipped repeat the update then matches is settled', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office' }, { success: false, disposition: 'skipped' });
    ledger.record('update_event', { event_id: 601, location: 'Office' }, okCall);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });

  test('a renamed or moved event is keyed by its new identity: a repeat of the new one is folded, of the old one visible', () => {
    const moved = exec({ data: { id: 601, title: 'Sync', date: '2026-10-31', time: '11:00', all_day: false } });
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', plain, okCall);
    ledger.record('update_event', { event_id: 601, title: 'Sync', start_at: '2026-10-31T11:00:00Z' }, moved);
    ledger.record('create_event', { title: 'sync', start_at: '2026-10-31T11:00:00Z' }, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
    ledger.record('create_event', plain, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created: event “Call”');
  });

  test('a refused create is settled by an update that renames the event into it', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', plain, okCall);
    ledger.record('create_event', { title: 'Sync', start_at: '2026-10-31T11:00:00Z' }, rejectedCreate);
    ledger.record(
      'update_event',
      { event_id: 601, title: 'Sync', start_at: '2026-10-31T11:00:00Z' },
      exec({ data: { id: 601, title: 'Sync', date: '2026-10-31', time: '11:00', all_day: false } }),
    );
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });

  test('a successful recurrence removal on an all-day series, with no restated start, retires the create', () => {
    const series = { title: 'Camp', all_day: true, start_at: '2030-04-15', recurrence_rule: 'FREQ=DAILY;COUNT=3' };
    const day = exec({ data: { id: 802, title: 'Camp', date: '2030-04-15', all_day: true } });
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', series, day);
    ledger.record('update_event', { event_id: 802, recurrence_rule: null }, day);
    ledger.record('create_event', series, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created');
  });

  test('an all-day flip with the start restated is re-keyed: the repeat of the new event is folded', () => {
    const flipped = exec({ data: { id: 601, title: 'Call', date: '2026-10-31', all_day: true } });
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', plain, okCall);
    ledger.record('update_event', { event_id: 601, all_day: true, start_at: '2026-10-31' }, flipped);
    ledger.record('create_event', { ...plain, start_at: '2026-10-31', all_day: true }, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });
});

describe('a refused create is compared only with a success in the same calendar', () => {
  test('another owner or scope is not a field of the line', () => {
    const at = { title: 'Standup', start_at: '2026-10-31T09:00:00Z' };
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record(
      'create_event',
      at,
      exec({ data: { id: 701, title: 'Standup', date: '2026-10-31', time: '09:00', all_day: false } }),
    );
    ledger.record('create_event', { ...at, owner_id: OWNER, location: 'Office' }, rejectedCreate);
    const line = (ledger.finalNotice(receiptViewFor('en')) ?? '').split('\n').find((l) => l.startsWith('Not created'));
    expect(line).toBeDefined();
    expect(line).not.toContain('location');
  });
});

describe('a start without an offset is never read in the server zone', () => {
  test('refused with no offset, then created with one: the refused line names no day or time', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { title: 'Standup', start_at: '2026-10-31T10:00:00' }, rejectedCreate);
    ledger.record(
      'create_event',
      { title: 'Standup', start_at: '2026-10-31T10:00:00+03:00' },
      exec({ data: { id: 701, title: 'Standup', date: '2026-10-31', time: '10:00', all_day: false } }),
    );
    const view = { ...receiptViewFor('en'), timezone: 'Europe/Moscow', now: new Date('2026-10-31T05:00:00Z') };
    const lines = (ledger.finalNotice(view) ?? '').split('\n');
    expect(lines).toContain('Not created: event “Standup” — nothing was changed.');
    expect(lines).toContain('Created: event “Standup” (today, 10:00).');
  });
});

describe('a refused create that differs only by recurrence or all-day names that field', () => {
  const at = { title: 'Standup', start_at: '2026-10-31T09:00:00Z' };
  const standup = exec({ data: { id: 701, title: 'Standup', date: '2026-10-31', time: '09:00', all_day: false } });
  const lines = (ledger: WriteOutcomes, lang: 'ru' | 'en') =>
    (ledger.finalNotice({ ...receiptViewFor(lang), now: new Date('2026-10-31T08:00:00Z') }) ?? '').split('\n');

  test.each([
    [
      'en',
      { recurrence_rule: 'FREQ=WEEKLY' },
      'Not created: event “Standup” (today, 09:00), fields: recurrence — nothing was changed.',
    ],
    [
      'ru',
      { recurrence_rule: 'FREQ=WEEKLY' },
      'Не создано: событие «Standup» (сегодня, 09:00), поля: повторение — ничего не изменилось.',
    ],
    ['en', { all_day: true }, 'Not created: event “Standup” (today), fields: all day — nothing was changed.'],
  ] as const)('%s: refused with %j, then created plain', (lang, extra, expected) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { ...at, ...extra }, rejectedCreate);
    ledger.record('create_event', at, standup);
    expect(lines(ledger, lang)).toContain(expected);
    expect(lines(ledger, lang).filter((l) => /^(Created|Создано)/.test(l))).toHaveLength(1);
  });
});

describe('a failed create kept visible next to a success names what it asked for differently', () => {
  test.each([
    ['en', { end_at: '2026-10-31T11:00:00Z' }, 'end time'],
    ['en', { location: 'Office' }, 'location'],
    ['en', { description: 'Agenda' }, 'description'],
    ['ru', { location: 'Office' }, 'место'],
  ] as const)('%s: %j', (lang, other, label) => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    const call = { title: 'Call', start_at: '2026-10-31T10:00:00Z', end_at: '2026-10-31T10:30:00Z' };
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, ...other }, rejectedCreate);
    const line =
      ledger
        .finalNotice(receiptViewFor(lang))
        ?.split('\n')
        .find((l) => /Not created|Не создано/.test(l)) ?? '';
    expect(line).toContain(label);
  });
});

describe('failed creates next to one success stay separate lines', () => {
  const call = { title: 'Call', start_at: '2026-10-31T10:00:00Z' };

  test('two unconfirmed repeats that differ in different details are two lines', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office' }, uncertain);
    ledger.record('create_event', { ...call, description: 'Agenda' }, uncertain);
    const lines = (ledger.finalNotice(receiptViewFor('en')) ?? '').split('\n');
    expect(lines.filter((l) => l.startsWith('Could not confirm creation'))).toEqual([
      'Could not confirm creation: event “Call” (today, 10:00), fields: location.',
      'Could not confirm creation: event “Call” (today, 10:00), fields: description.',
    ]);
  });

  test('where targets are hidden, creates of different events do not merge', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    const other = { title: 'Retro', start_at: '2026-10-31T15:00:00Z' };
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Room 1' }, uncertain);
    ledger.record(
      'create_event',
      other,
      exec({ data: { id: 602, title: 'Retro', date: '2026-10-31', time: '15:00', all_day: false } }),
    );
    ledger.record('create_event', { ...other, description: 'Notes' }, uncertain);
    const lines = (ledger.finalNotice({ ...receiptViewFor('en'), hideTargets: true }) ?? '').split('\n');
    expect(lines.filter((l) => l.startsWith('Could not confirm creation'))).toHaveLength(2);
  });

  test('the fields follow the event as an update re-keys it', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office', description: 'Agenda' }, rejectedCreate);
    ledger.record('update_event', { event_id: 601, location: 'Office' }, okCall);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain(
      'Not created: event “Call” (today, 10:00), fields: description',
    );
    const line =
      ledger
        .finalNotice(receiptViewFor('en'))
        ?.split('\n')
        .find((l) => l.startsWith('Not created')) ?? '';
    expect(line).not.toContain('location');
  });

  test('a second success that adds a detail is told as a plain creation', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office' }, okCall);
    ledger.record('send_invitation', { event_id: 601, invitee_id: FRIEND }, eventNotFound);
    expect(ledger.finalNotice(receiptViewFor('en'))).not.toContain('fields:');
  });

  test('a folded unknown repeat makes the closing line ask to check the calendar', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', call, uncertain);
    ledger.record('send_invitation', { event_id: 601, invitee_id: FRIEND }, eventNotFound);
    const text = ledger.finalNotice(receiptViewFor('en')) ?? '';
    expect(text).toContain('Check the calendar before repeating anything');
    expect(text).not.toContain('Tell me what to repeat');
  });
});

describe('an unconfirmed update and the duplicate warnings', () => {
  const call = { title: 'Call', start_at: '2026-10-31T10:00:00Z' };

  test('an unconfirmed update does not settle a refused create it would match', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office' }, rejectedCreate);
    ledger.record('update_event', { event_id: 601, location: 'Office' }, uncertain);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created: event “Call”');
  });

  test('an unconfirmed update that changes nothing the create asked for keeps the create', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('update_event', { event_id: 601, category: 'work' }, uncertain);
    ledger.record('create_event', call, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).not.toContain('Not created');
  });

  test('a retry that worked after an unknown invitation, plus a refusal, asks to check the calendar', () => {
    const delivered: Recorded = exec({ effect: { kind: 'invitation', delivery: 'delivered' } });
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('send_invitation', { event_id: 601, invitee_id: FRIEND }, uncertain);
    ledger.record('send_invitation', { event_id: 601, invitee_id: FRIEND }, delivered);
    ledger.record('update_event', { event_id: 601, title: 'Sync' }, eventNotFound);
    const text = ledger.finalNotice(receiptViewFor('en')) ?? '';
    expect(text).toContain('Check the calendar before repeating anything');
    expect(text).not.toContain('Tell me what to repeat');
  });

  test('the repeat warning names the calendar the event lives in', () => {
    const req = { title: 'Board games', start_at: '2026-10-31T17:00:00Z', owner_id: OWNER };
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', req, created);
    ledger.record('create_event', req, uncertain);
    const view = { ...receiptView(secretaryContext('en')), now: new Date('2026-10-31T08:00:00Z') };
    expect(ledger.finalNotice(view)?.split('\n')).toContain(
      'A repeat of the creation could not be confirmed: event “Board games” (today, 17:00), calendar: Olga. Check the calendar for a duplicate.',
    );
  });

  test('a failed create is compared with the closest success of the event', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { ...call, location: 'Office' }, okCall);
    ledger.record('create_event', { ...call, location: 'Home' }, okCall);
    ledger.record('create_event', { ...call, location: 'Home', description: 'Agenda' }, rejectedCreate);
    const line =
      ledger
        .finalNotice(receiptViewFor('en'))
        ?.split('\n')
        .find((l) => l.startsWith('Not created')) ?? '';
    expect(line).toContain('fields: description');
    expect(line).not.toContain('location');
  });
});

describe('identical refused creates next to a success are one line', () => {
  const call = { title: 'Call', start_at: '2026-10-31T10:00:00Z' };

  test('the same refused call sent twice is told once', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office' }, rejectedCreate);
    ledger.record('create_event', { ...call, location: 'Office' }, rejectedCreate);
    const lines = ledger.finalNotice(receiptViewFor('en'))?.split('\n') ?? [];
    expect(lines.filter((l) => l.startsWith('Not created'))).toHaveLength(1);
  });

  test('a refused and an unconfirmed create with the same details stay separate lines', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office' }, rejectedCreate);
    ledger.record('create_event', { ...call, location: 'Office' }, uncertain);
    const lines = ledger.finalNotice(receiptViewFor('en'))?.split('\n') ?? [];
    expect(lines.filter((l) => /^(Not created|Could not confirm creation)/.test(l))).toHaveLength(2);
  });

  test('refused creates that differ in their details stay separate lines', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office' }, rejectedCreate);
    ledger.record('create_event', { ...call, location: 'Home' }, rejectedCreate);
    const lines = ledger.finalNotice(receiptViewFor('en'))?.split('\n') ?? [];
    expect(lines.filter((l) => l.startsWith('Not created'))).toHaveLength(2);
  });

  test('a refusal for another calendar or scope survives an update that matches it otherwise', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office', owner_id: OWNER }, rejectedCreate);
    ledger.record('create_event', { ...call, location: 'Office', scope: 'group' }, rejectedCreate);
    ledger.record('update_event', { event_id: 601, location: 'Office' }, okCall);
    const lines = ledger.finalNotice(receiptViewFor('en'))?.split('\n') ?? [];
    expect(lines.filter((l) => l.startsWith('Not created'))).toHaveLength(2);
  });
});

describe('a start-only update leaves the end as stored (update_event never shifts it)', () => {
  test('a refused repeat of the new start with the old end is folded, one with another end stays visible', () => {
    const call = { title: 'Call', start_at: '2026-10-31T10:00:00Z', end_at: '2026-10-31T12:00:00Z' };
    const moved = exec({ data: { id: 601, title: 'Call', date: '2026-10-31', time: '11:00', all_day: false } });
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('update_event', { event_id: 601, start_at: '2026-10-31T11:00:00Z' }, moved);
    ledger.record('create_event', { ...call, start_at: '2026-10-31T11:00:00Z' }, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
    ledger.record(
      'create_event',
      { ...call, start_at: '2026-10-31T11:00:00Z', end_at: '2026-10-31T11:30:00Z' },
      rejectedCreate,
    );
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('fields: end time');
  });
});

describe('an end that cannot be re-read in the other form', () => {
  test('a flip to all-day without a restated end retires the create: the original request stays visible', () => {
    const call = { title: 'Call', start_at: '2026-10-31T10:00:00Z', end_at: '2026-10-31T10:30:00Z' };
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record(
      'update_event',
      { event_id: 601, all_day: true, start_at: '2026-10-31' },
      exec({ data: { id: 601, title: 'Call', date: '2026-10-31', all_day: true } }),
    );
    ledger.record('create_event', call, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created: event “Call”');
  });
});

describe('what an update leaves unsettled', () => {
  const call = { title: 'Call', start_at: '2026-10-31T10:00:00Z' };

  test('an unknown failure that the update then matches still has to be checked', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record('create_event', { ...call, location: 'Office' }, uncertain);
    ledger.record('update_event', { event_id: 601, location: 'Office' }, okCall);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Could not confirm creation');
  });

  test('an all-day flag changed without a start cannot be re-keyed: a failed repeat stays visible', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', call, okCall);
    ledger.record(
      'update_event',
      { event_id: 601, all_day: true },
      exec({ data: { id: 601, title: 'Call', date: '2026-10-31', all_day: true } }),
    );
    ledger.record('create_event', call, rejectedCreate);
    expect(ledger.finalNotice(receiptViewFor('en'))).toContain('Not created');
  });

  test('an end restated in another all-day spelling keeps the end key', () => {
    const tz = 'Europe/Belgrade';
    const day = exec({ data: { id: 801, title: 'Camp', date: '2030-04-15', all_day: true } });
    const camp = { title: 'Camp', all_day: true, start_at: '2030-04-15', end_at: '2030-04-17' };
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', camp, day, false, tz);
    ledger.record('update_event', { event_id: 801, end_at: '2030-04-16T22:00:00Z' }, day, false, tz);
    ledger.record('create_event', camp, rejectedCreate, false, tz);
    expect(ledger.finalNotice(receiptViewFor('en'))).toBeNull();
  });
});

describe('two unknown repeats of one create keep both warnings', () => {
  test('even when an update moved the event between them', () => {
    const at = (time: string) => ({ title: 'Board games', start_at: `2026-10-31T${time}:00Z` });
    const row = (time: string): Recorded =>
      exec({ data: { id: 501, title: 'Board games', date: '2026-10-31', time, all_day: false } });
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', at('17:00'), row('17:00'));
    ledger.record('create_event', at('17:00'), uncertain);
    ledger.record('update_event', { event_id: 501, start_at: '2026-10-31T19:00:00Z' }, row('19:00'));
    ledger.record('create_event', at('19:00'), uncertain);
    const view = { ...receiptViewFor('en'), now: new Date('2026-10-31T08:00:00Z') };
    const warnings = (ledger.finalNotice(view) ?? '')
      .split('\n')
      .filter((l) => l.startsWith('A repeat of the creation'));
    expect(warnings).toHaveLength(2);
    expect(warnings.join('\n')).toContain('(today, 17:00)');
    expect(warnings.join('\n')).toContain('(today, 19:00)');
  });
});

describe('a repeat warning where targets are hidden', () => {
  test('two such repeats make one sentence', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    for (const [id, title] of [
      [1, 'A'],
      [2, 'B'],
    ] as const) {
      const input = { title, start_at: `2026-10-31T1${id}:00:00Z` };
      ledger.record(
        'create_event',
        input,
        exec({ data: { id, title, date: '2026-10-31', time: `1${id}:00`, all_day: false } }),
      );
      ledger.record('create_event', input, uncertain);
    }
    const lines = ledger.finalNotice({ ...receiptViewFor('en'), hideTargets: true })?.split('\n') ?? [];
    expect(lines.filter((l) => l.startsWith('A repeat of an event creation'))).toHaveLength(1);
  });

  test('is a sentence without an event', () => {
    const ledger = new WriteOutcomes(WRITE_TOOLS);
    ledger.record('create_event', { title: 'Board games', start_at: '2026-10-31T17:00:00Z' }, created);
    ledger.record('create_event', { title: 'Board games', start_at: '2026-10-31T17:00:00Z' }, uncertain);
    const view = { ...receiptViewFor('en'), hideTargets: true };
    expect(ledger.finalNotice(view)?.split('\n')).toContain(
      'A repeat of an event creation could not be confirmed. Check the calendar for a duplicate.',
    );
  });
});
