// test/services/dialogue/resolvers.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { ContactRepository } from '../../../src/database/repositories/contact.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { createContactPeopleResolver, createManualPlaceResolver } from '../../../src/services/dialogue/resolvers.ts';

const USER_ID = 1001;

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('createContactPeopleResolver — backed by the real, live ContactRepository', () => {
  let db: Database;
  let contacts: ContactRepository;

  beforeEach(() => {
    db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    contacts = new ContactRepository(db);
  });

  test('an exact (trim+lowercase) name match resolves without confirmation', () => {
    const lena = contacts.add(USER_ID, 'Lena', undefined, 555);
    const resolver = createContactPeopleResolver(contacts);
    const resolution = resolver.resolve(USER_ID, 'Lena');
    expect(resolution).toEqual({ kind: 'exact', contactId: lena.id, telegramId: 555, displayName: 'Lena' });
  });

  test('an exact match is case/whitespace-insensitive but still "exact", not "fuzzy"', () => {
    const anton = contacts.add(USER_ID, 'Anton', undefined, 777);
    const resolver = createContactPeopleResolver(contacts);
    expect(resolver.resolve(USER_ID, '  anton  ')).toEqual({
      kind: 'exact',
      contactId: anton.id,
      telegramId: 777,
      displayName: 'Anton',
    });
  });

  test('a single fuzzy candidate still requires confirmation — never auto-accepted', () => {
    contacts.add(USER_ID, 'Kristina', undefined, 888);
    const resolver = createContactPeopleResolver(contacts);
    const resolution = resolver.resolve(USER_ID, 'Kristin');
    expect(resolution.kind).toBe('fuzzy');
    if (resolution.kind !== 'fuzzy') throw new Error('unreachable');
    expect(resolution.candidates).toHaveLength(1);
    expect(resolution.candidates[0]?.displayName).toBe('Kristina');
    expect(resolution.candidates[0]?.confidence).toBeLessThan(1);
  });

  test('a preferred_name is surfaced as the display name once resolved', () => {
    const raw = contacts.add(USER_ID, 'Александр Иванов', undefined, 999, 'Саша');
    const resolver = createContactPeopleResolver(contacts);
    const resolution = resolver.resolve(USER_ID, 'Александр Иванов');
    expect(resolution).toEqual({
      kind: 'exact',
      contactId: raw.id,
      telegramId: 999,
      displayName: 'Саша',
    });
  });
  test('no match at all resolves to none, never a false positive', () => {
    const resolver = createContactPeopleResolver(contacts);
    expect(resolver.resolve(USER_ID, 'Nobody Here')).toEqual({ kind: 'none' });
  });

  test('a name tied across two distinct contacts (name vs. preferred_name) is ambiguous, never a silent first-match (blocker: duplicate-name resolution must be ambiguity-safe)', () => {
    const dima = contacts.add(USER_ID, 'Дима', undefined, 111);
    const dmitry = contacts.add(USER_ID, 'Dmitry Petrov', undefined, 222, 'Дима');
    const resolver = createContactPeopleResolver(contacts);
    const resolution = resolver.resolve(USER_ID, 'Дима');
    expect(resolution.kind).toBe('fuzzy');
    if (resolution.kind !== 'fuzzy') throw new Error('unreachable');
    const contactIds = resolution.candidates.map((c) => c.contactId).sort();
    expect(contactIds).toEqual([dima.id, dmitry.id].sort());
    for (const candidate of resolution.candidates) expect(candidate.confidence).toBe(1);
  });
});

describe('createManualPlaceResolver — the existing manual/native behavior, not a stub', () => {
  test('manual free text is stored verbatim, trimmed, no geocoding invented', () => {
    const resolver = createManualPlaceResolver();
    expect(resolver.resolveManual('  Кафе Пушкин  ')).toEqual({ kind: 'manual', label: 'Кафе Пушкин' });
  });

  test('empty manual text is unresolved, never a silent empty place', () => {
    const resolver = createManualPlaceResolver();
    expect(resolver.resolveManual('   ')).toEqual({ kind: 'unresolved' });
  });

  test('a native Telegram venue/location fills coordinates and title without any LLM call', () => {
    const resolver = createManualPlaceResolver();
    const resolution = resolver.resolveNative({ latitude: 44.8, longitude: 20.46, title: 'Office' });
    expect(resolution).toEqual({ kind: 'native', label: 'Office', latitude: 44.8, longitude: 20.46 });
  });

  test('a native location with no title falls back to its address, then raw coordinates', () => {
    const resolver = createManualPlaceResolver();
    expect(resolver.resolveNative({ latitude: 1, longitude: 2, address: 'Main St 1' })).toEqual({
      kind: 'native',
      label: 'Main St 1',
      latitude: 1,
      longitude: 2,
    });
    expect(resolver.resolveNative({ latitude: 1, longitude: 2 })).toEqual({
      kind: 'native',
      label: '1,2',
      latitude: 1,
      longitude: 2,
    });
  });
});

describe('createManualPlaceResolver.resolveNative — coordinate validation (blocker: native coordinates must be finite and range-checked)', () => {
  test('non-finite coordinates (NaN/Infinity) are rejected, never accepted as a place', () => {
    const resolver = createManualPlaceResolver();
    expect(resolver.resolveNative({ latitude: Number.NaN, longitude: 20.46 })).toEqual({ kind: 'unresolved' });
    expect(resolver.resolveNative({ latitude: 44.8, longitude: Number.POSITIVE_INFINITY })).toEqual({
      kind: 'unresolved',
    });
  });

  test('out-of-range coordinates are rejected, never accepted as a place', () => {
    const resolver = createManualPlaceResolver();
    expect(resolver.resolveNative({ latitude: 91, longitude: 20 })).toEqual({ kind: 'unresolved' });
    expect(resolver.resolveNative({ latitude: 44, longitude: 181 })).toEqual({ kind: 'unresolved' });
    expect(resolver.resolveNative({ latitude: -91, longitude: -181 })).toEqual({ kind: 'unresolved' });
  });

  test('boundary coordinates (exactly 90/180) are still accepted', () => {
    const resolver = createManualPlaceResolver();
    expect(resolver.resolveNative({ latitude: 90, longitude: 180, title: 'Pole' })).toEqual({
      kind: 'native',
      label: 'Pole',
      latitude: 90,
      longitude: 180,
    });
  });
});
