import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { PlaceRepository } from '../../../src/database/repositories/place.repository.ts';
import { PlaceAliasRepository } from '../../../src/database/repositories/place-alias.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { PlaceResolver } from '../../../src/services/places/place-resolver.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const USER_ID = 100;
const OTHER_USER_ID = 200;

describe('PlaceResolver', () => {
  let db: Database;
  let places: PlaceRepository;
  let aliases: PlaceAliasRepository;
  let resolver: PlaceResolver;

  beforeEach(() => {
    db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    new UserRepository(db).create({ telegram_id: OTHER_USER_ID });
    places = new PlaceRepository(db);
    aliases = new PlaceAliasRepository(db);
    resolver = new PlaceResolver(places, aliases);
  });

  test('unknown query resolves to none', () => {
    expect(resolver.resolve(USER_ID, 'Nowhere')).toEqual({ kind: 'none' });
  });

  test('blank query resolves to none without touching the database', () => {
    expect(resolver.resolve(USER_ID, '   ')).toEqual({ kind: 'none' });
  });

  test('exact label match resolves directly, no geocoder needed', () => {
    const place = places.create(USER_ID, { label: 'Дом', address: 'ул. Пушкина 1' });
    const result = resolver.resolve(USER_ID, 'дом');
    expect(result).toEqual({ kind: 'exact_unique', place, matchedAlias: 'Дом' });
  });

  test('exact alias match resolves directly', () => {
    const place = places.create(USER_ID, { label: 'Парк на Ушћу' });
    aliases.add(USER_ID, place.id, 'Ušće Park');
    const result = resolver.resolve(USER_ID, 'Ušće Park');
    expect(result.kind).toBe('exact_unique');
    if (result.kind !== 'exact_unique') throw new Error('unreachable');
    expect(result.place.id).toBe(place.id);
    expect(result.matchedAlias).toBe('Ušće Park');
  });

  // Two different places sharing an alias/label ("дом" for both a personal flat and the parents'
  // place) must require selection, never silently pick one.
  test('two places with the same label require selection, not a silent pick', () => {
    const home1 = places.create(USER_ID, { label: 'Дом' });
    const home2 = places.create(USER_ID, { label: 'Другой дом' });
    aliases.add(USER_ID, home2.id, 'Дом');
    const result = resolver.resolve(USER_ID, 'Дом');
    expect(result.kind).toBe('exact_ambiguous');
    if (result.kind !== 'exact_ambiguous') throw new Error('unreachable');
    expect(result.candidates.map((c) => c.place.id).sort()).toEqual([home1.id, home2.id].sort());
  });

  test('two places owned by different users are isolated', () => {
    places.create(USER_ID, { label: 'Дом' });
    places.create(OTHER_USER_ID, { label: 'Дом' });
    expect(resolver.resolve(USER_ID, 'Дом').kind).toBe('exact_unique');
    expect(resolver.resolve(OTHER_USER_ID, 'Дом').kind).toBe('exact_unique');
  });

  test('a trashed place is not exact-matched', () => {
    const place = places.create(USER_ID, { label: 'Дом' });
    places.softDelete(USER_ID, place.id);
    expect(resolver.resolve(USER_ID, 'Дом')).toEqual({ kind: 'none' });
  });

  test('fuzzy match falls back when no exact match exists', () => {
    places.create(USER_ID, { label: 'Ушће' });
    const result = resolver.resolve(USER_ID, 'Ушце');
    expect(result.kind).toBe('fuzzy_confirm');
    if (result.kind !== 'fuzzy_confirm') throw new Error('unreachable');
    expect(result.candidates).toHaveLength(1);
  });

  // Parent review finding (#655): a misspelled ALIAS, not just a misspelled label, must still
  // surface a fuzzy candidate needing confirmation — never silently fall through to none.
  test('fuzzy match also considers a misspelled alias, not just the label', () => {
    const place = places.create(USER_ID, { label: 'Парк' });
    aliases.add(USER_ID, place.id, 'Ушће');
    const result = resolver.resolve(USER_ID, 'Ушце');
    expect(result.kind).toBe('fuzzy_confirm');
    if (result.kind !== 'fuzzy_confirm') throw new Error('unreachable');
    expect(result.candidates.map((c) => c.place.id)).toEqual([place.id]);
  });

  test('fuzzy match never double-counts a place scored by both its label and an alias', () => {
    const place = places.create(USER_ID, { label: 'Ушће' });
    aliases.add(USER_ID, place.id, 'Ushche');
    const result = resolver.resolve(USER_ID, 'Ушце');
    expect(result.kind).toBe('fuzzy_confirm');
    if (result.kind !== 'fuzzy_confirm') throw new Error('unreachable');
    expect(result.candidates).toHaveLength(1);
  });
});
