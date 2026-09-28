// test/services/dialogue/full-field-parser.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { ContactRepository } from '../../../src/database/repositories/contact.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { type ParseContext, parseFullField } from '../../../src/services/dialogue/full-field-parser.ts';
import { createContactPeopleResolver, createManualPlaceResolver } from '../../../src/services/dialogue/resolvers.ts';

const USER_ID = 42;
const NOW = new Date('2026-09-29T08:00:00Z'); // 2026-09-29 10:00 local in Europe/Belgrade (CEST, UTC+2)

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function makeContext(db: Database): ParseContext {
  const contacts = new ContactRepository(db);
  contacts.add(USER_ID, 'Lena', undefined, 501);
  contacts.add(USER_ID, 'Anton', undefined, 502);
  contacts.add(USER_ID, 'Kristina', undefined, 503);
  return {
    timezone: 'Europe/Belgrade',
    now: NOW,
    actorId: USER_ID,
    peopleResolver: createContactPeopleResolver(contacts),
    placeResolver: createManualPlaceResolver(),
  };
}

describe('a fully specified command fills title, time, people and place in one turn', () => {
  let db: Database;
  let ctx: ParseContext;

  beforeEach(() => {
    db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    ctx = makeContext(db);
  });

  test('"Meeting tomorrow at 14:00 with Lena and Anton at the office" — the GH-652 acceptance example', () => {
    const result = parseFullField('Meeting tomorrow at 14:00 with Lena and Anton at the office', ctx);
    expect(result.patch.title).toBe('Meeting');
    expect(result.patch.schedule).toEqual({ kind: 'timed', startAt: '2026-09-30T12:00:00.000Z' });
    expect(result.patch.people).toEqual([
      { contactId: expect.any(Number), telegramId: 501, displayName: 'Lena', confirmed: true },
      { contactId: expect.any(Number), telegramId: 502, displayName: 'Anton', confirmed: true },
    ]);
    expect(result.patch.place).toEqual({ kind: 'manual', label: 'the office' });
    expect(result.unresolvedPeopleNames).toEqual([]);
    expect(result.fuzzyPeople).toEqual([]);
  });

  test('the Russian equivalent resolves the same fields', () => {
    const result = parseFullField('Встреча завтра в 14:00 с Lena и Anton в офисе', ctx);
    expect(result.patch.title).toBe('Встреча');
    expect(result.patch.schedule).toEqual({ kind: 'timed', startAt: '2026-09-30T12:00:00.000Z' });
    expect(result.patch.people?.map((p) => p.displayName)).toEqual(['Lena', 'Anton']);
    expect(result.patch.place).toEqual({ kind: 'manual', label: 'офисе' });
  });

  test('a single fuzzy person is reported for confirmation, not silently added or dropped (people-order family)', () => {
    const result = parseFullField('Meeting tomorrow at 14:00 with Kristin', ctx);
    expect(result.patch.people).toBeUndefined();
    expect(result.fuzzyPeople).toHaveLength(1);
    expect(result.fuzzyPeople[0]?.rawName).toBe('Kristin');
    expect(result.fuzzyPeople[0]?.candidates[0]?.displayName).toBe('Kristina');
  });

  test('a name matching no contact at all is surfaced as unresolved, never fabricated (people-order family)', () => {
    const result = parseFullField('Meeting tomorrow at 14:00 with Zorblax', ctx);
    expect(result.patch.people).toBeUndefined();
    expect(result.unresolvedPeopleNames).toEqual(['Zorblax']);
  });
});

describe('number-context family — a bare hour stays ambiguous, never silently guessed', () => {
  let ctx: ParseContext;
  beforeEach(() => {
    const db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    ctx = makeContext(db);
  });

  test('"Meeting tomorrow at 2" leaves schedule unset and the ambiguity available to the caller', () => {
    const result = parseFullField('Meeting tomorrow at 2', ctx);
    expect(result.patch.schedule).toBeUndefined();
    expect(result.patch.title).toBe('Meeting');
  });

  test('an unmatched date-less run of digits with no time marker stays in the title, never guessed as a time', () => {
    const result = parseFullField('Room 204 booking', ctx);
    expect(result.patch.schedule).toBeUndefined();
    expect(result.patch.title).toBe('Room 204 booking');
  });
});

describe('all-day family', () => {
  let ctx: ParseContext;
  beforeEach(() => {
    const db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    ctx = makeContext(db);
  });

  test('"Отпуск завтра весь день" sets an all_day schedule, date-only exclusive end, no time asked', () => {
    const result = parseFullField('Отпуск завтра весь день', ctx);
    expect(result.patch.schedule).toEqual({ kind: 'all_day', startDate: '2026-09-30', endDateExclusive: '2026-10-01' });
    expect(result.patch.title).toBe('Отпуск');
  });

  test('"послезавтра" (day after tomorrow) resolves two days ahead, distinct from "завтра"', () => {
    const result = parseFullField('Поездка послезавтра весь день', ctx);
    expect(result.patch.schedule).toEqual({ kind: 'all_day', startDate: '2026-10-01', endDateExclusive: '2026-10-02' });
  });

  test('an ISO yyyy-mm-dd date phrase resolves that exact date', () => {
    const result = parseFullField('Поездка 2026-12-25 весь день', ctx);
    expect(result.patch.schedule).toEqual({ kind: 'all_day', startDate: '2026-12-25', endDateExclusive: '2026-12-26' });
  });
});

describe('negative-entry family — negation is surfaced, never silently stripped into a false positive', () => {
  let ctx: ParseContext;
  beforeEach(() => {
    const db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    ctx = makeContext(db);
  });

  test('"не создавай встречу завтра" is flagged negated', () => {
    const result = parseFullField('не создавай встречу завтра', ctx);
    expect(result.negated).toBe(true);
  });

  test('a request with no negation marker is not flagged', () => {
    const result = parseFullField('Meeting tomorrow at 14:00', ctx);
    expect(result.negated).toBe(false);
  });
});

describe('natural-start family — a natural-language starter parses the same as /add args', () => {
  let ctx: ParseContext;
  beforeEach(() => {
    const db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    ctx = makeContext(db);
  });

  test('"сделай завтра встречу" resolves the same date as an explicit /add of the same text', () => {
    const result = parseFullField('сделай завтра встречу', ctx);
    expect(result.patch.title).toBe('сделай встречу');
    expect(result.patch.schedule).toBeUndefined();
  });
});

describe('an unrecognized trailing clause never becomes a phantom place', () => {
  let ctx: ParseContext;
  beforeEach(() => {
    const db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    ctx = makeContext(db);
  });

  test('no "at"/"в" marker leaves place unset', () => {
    const result = parseFullField('Meeting tomorrow at 14:00', ctx);
    expect(result.patch.place).toBeUndefined();
  });
});

describe('a bare time with no "at"/"в" prefix still resolves via the trailing-suffix fallback', () => {
  let ctx: ParseContext;
  beforeEach(() => {
    const db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    ctx = makeContext(db);
  });

  test('"Meeting tomorrow 14:00" (no "at") still resolves the explicit time', () => {
    const result = parseFullField('Meeting tomorrow 14:00', ctx);
    expect(result.patch.schedule).toEqual({ kind: 'timed', startAt: '2026-09-30T12:00:00.000Z' });
    expect(result.patch.title).toBe('Meeting');
  });
});
