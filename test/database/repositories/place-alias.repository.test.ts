import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { PlaceRepository } from '../../../src/database/repositories/place.repository.ts';
import { PlaceAliasRepository } from '../../../src/database/repositories/place-alias.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const USER_ID = 100;
const OTHER_USER_ID = 200;

describe('PlaceAliasRepository', () => {
  let db: Database;
  let repo: PlaceAliasRepository;
  let places: PlaceRepository;

  beforeEach(() => {
    db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    new UserRepository(db).create({ telegram_id: OTHER_USER_ID });
    repo = new PlaceAliasRepository(db);
    places = new PlaceRepository(db);
  });

  test('add creates an alias for a place', () => {
    const place = places.create(USER_ID, { label: 'Парк на Ушћу' });
    const alias = repo.add(USER_ID, place.id, 'Ušće Park');
    expect(alias.alias).toBe('Ušće Park');
    expect(repo.listForPlace(USER_ID, place.id).map((a) => a.alias)).toEqual(['Ušće Park']);
  });

  test('add refuses an empty alias', () => {
    const place = places.create(USER_ID, { label: 'Дом' });
    expect(() => repo.add(USER_ID, place.id, '   ')).toThrow(/PLACE_ALIAS_EMPTY/);
  });

  test('a single place cannot hold the same alias twice (case-insensitive)', () => {
    const place = places.create(USER_ID, { label: 'Дом' });
    repo.add(USER_ID, place.id, 'Home');
    expect(() => repo.add(USER_ID, place.id, 'home')).toThrow(/PLACE_ALIAS_CONFLICT/);
  });

  // Critical parity with #654's contact_aliases design: two DIFFERENT places owned by the same
  // user must be allowed to share an alias/label — e.g. both a personal and a parents' place
  // called "дом" — disambiguated at lookup time, never blocked at write time.
  test('two different places owned by the same user can share the same alias text', () => {
    const home1 = places.create(USER_ID, { label: 'Моя квартира' });
    const home2 = places.create(USER_ID, { label: 'Дом родителей' });
    repo.add(USER_ID, home1.id, 'дом');
    repo.add(USER_ID, home2.id, 'дом');
    const holders = repo.findByAlias(USER_ID, 'Дом');
    expect(holders.map((a) => a.place_id).sort()).toEqual([home1.id, home2.id].sort());
  });

  test('findByAlias is case-insensitive and scoped to the owner', () => {
    const mine = places.create(USER_ID, { label: 'Дом' });
    const theirs = places.create(OTHER_USER_ID, { label: 'Дом' });
    repo.add(OTHER_USER_ID, theirs.id, 'офис');
    const found = repo.findByAlias(USER_ID, 'дом');
    expect(found).toEqual([]);
    repo.add(USER_ID, mine.id, 'ДОМ');
    expect(repo.findByAlias(USER_ID, 'дом').map((a) => a.place_id)).toEqual([mine.id]);
  });

  test('delete removes an alias', () => {
    const place = places.create(USER_ID, { label: 'Дом' });
    const alias = repo.add(USER_ID, place.id, 'офис');
    expect(repo.delete(USER_ID, place.id, alias.id)).toBe(true);
    expect(repo.listForPlace(USER_ID, place.id)).toEqual([]);
  });

  test('delete is a no-op returning false for an alias outside the owner scope', () => {
    const theirs = places.create(OTHER_USER_ID, { label: 'Дом' });
    const theirAlias = repo.add(OTHER_USER_ID, theirs.id, 'офис');
    expect(repo.delete(USER_ID, theirs.id, theirAlias.id)).toBe(false);
  });

  test('deleting a place cascades its aliases', () => {
    const place = places.create(USER_ID, { label: 'Дом' });
    repo.add(USER_ID, place.id, 'офис');
    places.softDelete(USER_ID, place.id);
    places.purge(USER_ID, place.id);
    expect(repo.listForPlace(USER_ID, place.id)).toEqual([]);
  });
});
