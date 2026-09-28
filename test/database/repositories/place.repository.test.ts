import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { PlaceRepository } from '../../../src/database/repositories/place.repository.ts';
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

describe('PlaceRepository', () => {
  let db: Database;
  let repo: PlaceRepository;

  beforeEach(() => {
    db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    new UserRepository(db).create({ telegram_id: OTHER_USER_ID });
    repo = new PlaceRepository(db);
  });

  test('create stores an unconfirmed place by default', () => {
    const place = repo.create(USER_ID, { label: 'Дом' });
    expect(place.label).toBe('Дом');
    expect(place.verification).toBe('unconfirmed');
    expect(place.favorite).toBe(0);
    expect(place.revision).toBe(1);
  });

  test('create refuses a blank label', () => {
    expect(() => repo.create(USER_ID, { label: '   ' })).toThrow(/PLACE_LABEL_EMPTY/);
  });

  test('create can store a confirmed native pin', () => {
    const place = repo.create(USER_ID, {
      label: 'Офис',
      latitude: 44.8125,
      longitude: 20.4612,
      provider: 'telegram_pin',
      verification: 'confirmed',
    });
    expect(place.verification).toBe('confirmed');
    expect(place.latitude).toBe(44.8125);
  });

  test('create refuses out-of-range or non-finite coordinates', () => {
    expect(() => repo.create(USER_ID, { label: 'X', latitude: 91, longitude: 0 })).toThrow(/PLACE_COORDS_INVALID/);
    expect(() => repo.create(USER_ID, { label: 'X', latitude: -91, longitude: 0 })).toThrow(/PLACE_COORDS_INVALID/);
    expect(() => repo.create(USER_ID, { label: 'X', latitude: 0, longitude: 181 })).toThrow(/PLACE_COORDS_INVALID/);
    expect(() => repo.create(USER_ID, { label: 'X', latitude: 0, longitude: -181 })).toThrow(/PLACE_COORDS_INVALID/);
    expect(() => repo.create(USER_ID, { label: 'X', latitude: Number.NaN, longitude: 0 })).toThrow(
      /PLACE_COORDS_INVALID/,
    );
    expect(() => repo.create(USER_ID, { label: 'X', latitude: Number.POSITIVE_INFINITY, longitude: 0 })).toThrow(
      /PLACE_COORDS_INVALID/,
    );
  });

  test('list returns only active places, favorites first', () => {
    repo.create(USER_ID, { label: 'B' });
    const fav = repo.create(USER_ID, { label: 'A' });
    repo.setFavorite(USER_ID, fav.id, true);
    const list = repo.list(USER_ID);
    expect(list.map((p) => p.label)).toEqual(['A', 'B']);
  });

  test('list is isolated per user', () => {
    repo.create(USER_ID, { label: 'Дом' });
    repo.create(OTHER_USER_ID, { label: 'Дом' });
    expect(repo.list(USER_ID)).toHaveLength(1);
    expect(repo.list(OTHER_USER_ID)).toHaveLength(1);
  });

  test('list favoriteOnly filters to favorites', () => {
    const fav = repo.create(USER_ID, { label: 'A' });
    repo.create(USER_ID, { label: 'B' });
    repo.setFavorite(USER_ID, fav.id, true);
    expect(repo.list(USER_ID, { favoriteOnly: true }).map((p) => p.label)).toEqual(['A']);
  });

  test('update bumps revision and updated_at without touching verification for a label-only change', () => {
    const place = repo.create(USER_ID, { label: 'Дом', address: 'ул. Пушкина 1', verification: 'confirmed' });
    const updated = repo.update(USER_ID, place.id, { label: 'Мой дом' });
    expect(updated?.label).toBe('Мой дом');
    expect(updated?.revision).toBe(2);
    expect(updated?.verification).toBe('confirmed');
  });

  test('update resets verification to unconfirmed when the address changes', () => {
    const place = repo.create(USER_ID, { label: 'Дом', address: 'ул. Пушкина 1', verification: 'confirmed' });
    const updated = repo.update(USER_ID, place.id, { address: 'ул. Ленина 2' });
    expect(updated?.verification).toBe('unconfirmed');
  });

  test('update can re-confirm verification in the same patch as an address change', () => {
    const place = repo.create(USER_ID, { label: 'Дом', verification: 'unconfirmed' });
    const updated = repo.update(USER_ID, place.id, { address: 'ул. Ленина 2', verification: 'confirmed' });
    expect(updated?.verification).toBe('confirmed');
  });

  test('update returns null for a place outside the owner scope', () => {
    const theirs = repo.create(OTHER_USER_ID, { label: 'Дом' });
    expect(repo.update(USER_ID, theirs.id, { label: 'x' })).toBeNull();
  });

  test('update refuses to trim the label to empty', () => {
    const place = repo.create(USER_ID, { label: 'Дом' });
    expect(() => repo.update(USER_ID, place.id, { label: '   ' })).toThrow(/PLACE_LABEL_EMPTY/);
    expect(repo.findById(USER_ID, place.id)?.label).toBe('Дом');
  });

  test('update refuses out-of-range coordinates', () => {
    const place = repo.create(USER_ID, { label: 'Дом' });
    expect(() => repo.update(USER_ID, place.id, { latitude: 95 })).toThrow(/PLACE_COORDS_INVALID/);
  });

  test('setFavorite toggles the flag', () => {
    const place = repo.create(USER_ID, { label: 'Дом' });
    expect(repo.setFavorite(USER_ID, place.id, true)).toBe(true);
    expect(repo.findById(USER_ID, place.id)?.favorite).toBe(1);
    expect(repo.setFavorite(USER_ID, place.id, false)).toBe(true);
    expect(repo.findById(USER_ID, place.id)?.favorite).toBe(0);
  });

  test('softDelete moves a place to trash, out of list() and findById()', () => {
    const place = repo.create(USER_ID, { label: 'Дом' });
    expect(repo.softDelete(USER_ID, place.id)).toBe(true);
    expect(repo.list(USER_ID)).toEqual([]);
    expect(repo.findById(USER_ID, place.id)).toBeNull();
    expect(repo.findById(USER_ID, place.id, { includeDeleted: true })?.deleted_at).not.toBeNull();
    expect(repo.listTrash(USER_ID).map((p) => p.id)).toEqual([place.id]);
  });

  test('softDelete is idempotent (a no-op returning false on an already-trashed place)', () => {
    const place = repo.create(USER_ID, { label: 'Дом' });
    repo.softDelete(USER_ID, place.id);
    expect(repo.softDelete(USER_ID, place.id)).toBe(false);
  });

  test('restore brings a trashed place back', () => {
    const place = repo.create(USER_ID, { label: 'Дом' });
    repo.softDelete(USER_ID, place.id);
    expect(repo.restore(USER_ID, place.id)).toBe(true);
    expect(repo.findById(USER_ID, place.id)).not.toBeNull();
    expect(repo.listTrash(USER_ID)).toEqual([]);
  });

  test('purge permanently removes a place', () => {
    const place = repo.create(USER_ID, { label: 'Дом' });
    repo.softDelete(USER_ID, place.id);
    expect(repo.purge(USER_ID, place.id)).toBe(true);
    expect(repo.findById(USER_ID, place.id, { includeDeleted: true })).toBeNull();
  });

  test('purge refuses an active (not yet trashed) place — must soft-delete first', () => {
    const place = repo.create(USER_ID, { label: 'Дом' });
    expect(repo.purge(USER_ID, place.id)).toBe(false);
    expect(repo.findById(USER_ID, place.id)).not.toBeNull();
  });

  describe('searchByLabel', () => {
    test('scores exact label match at 1.0', () => {
      repo.create(USER_ID, { label: 'Ушће' });
      const results = repo.searchByLabel(USER_ID, 'Ушће');
      expect(results[0]?.confidence).toBe(1);
    });

    test('matches on venue_name and address too', () => {
      repo.create(USER_ID, { label: 'Мой любимый парк', venueName: 'Ušće Park', address: 'Bulevar Nikole Tesle' });
      expect(repo.searchByLabel(USER_ID, 'Ušće Park')[0]?.confidence).toBe(1);
    });

    test('never matches a trashed place', () => {
      const place = repo.create(USER_ID, { label: 'Дом' });
      repo.softDelete(USER_ID, place.id);
      expect(repo.searchByLabel(USER_ID, 'Дом')).toEqual([]);
    });

    test('returns empty for an unrelated query', () => {
      repo.create(USER_ID, { label: 'Дом' });
      expect(repo.searchByLabel(USER_ID, 'Совершенно другое место')).toEqual([]);
    });
  });
});
