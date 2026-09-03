import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { UserMemoryRepository } from '../../../src/database/repositories/user-memory.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

const USER_ID = 4242;
const OTHER_USER_ID = 777;

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  for (const id of [USER_ID, OTHER_USER_ID]) {
    db.run('INSERT INTO users (telegram_id, language, timezone) VALUES (?, ?, ?)', [id, 'en', 'Europe/Belgrade']);
  }
  return db;
}

describe('UserMemoryRepository', () => {
  let repo: UserMemoryRepository;

  beforeEach(() => {
    repo = new UserMemoryRepository(createTestDb());
  });

  test('returns nothing for a user who has been told nothing', () => {
    expect(repo.getAll(USER_ID)).toEqual([]);
  });

  test('returns the facts in the order they were learned', () => {
    repo.append(USER_ID, 'likes tea');
    repo.append(USER_ID, 'lives in Belgrade');
    expect(repo.getAll(USER_ID).map((f) => f.content)).toEqual(['likes tea', 'lives in Belgrade']);
  });

  test("one user's facts are not another's", () => {
    repo.append(USER_ID, 'likes tea');
    repo.append(OTHER_USER_ID, 'likes coffee');
    expect(repo.getAll(USER_ID).map((f) => f.content)).toEqual(['likes tea']);
  });

  // Past the limit, the page has to be taken from the recent end. Taken from the
  // old end, a long-standing user was served the same fifty first facts forever
  // and everything learned since never reached the prompt at all.
  test('past the limit it keeps the newest facts, still in order', () => {
    for (let i = 0; i < 60; i++) repo.append(USER_ID, `fact ${i}`);

    const kept = repo.getAll(USER_ID).map((f) => f.content);

    expect(kept).toHaveLength(50);
    expect(kept[0]).toBe('fact 10');
    expect(kept[49]).toBe('fact 59');
  });

  test('rewrite replaces everything with the single fact given', () => {
    repo.append(USER_ID, 'likes tea');
    repo.append(USER_ID, 'lives in Belgrade');
    repo.rewrite(USER_ID, 'moved to Novi Sad');
    expect(repo.getAll(USER_ID).map((f) => f.content)).toEqual(['moved to Novi Sad']);
  });
});
