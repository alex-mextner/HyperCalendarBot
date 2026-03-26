// test/database/repositories/user.repository.test.ts

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('UserRepository', () => {
  let db: Database;
  let repo: UserRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new UserRepository(db);
  });

  test('findByTelegramId returns null for non-existent user', () => {
    expect(repo.findByTelegramId(999)).toBeNull();
  });

  test('create inserts a new user and returns it', () => {
    const user = repo.create({ telegram_id: 123, username: 'alex', first_name: 'Alex' });
    expect(user.telegram_id).toBe(123);
    expect(user.username).toBe('alex');
    expect(user.language).toBe('en');
    expect(user.timezone).toBe('UTC');
    expect(user.onboarding_completed).toBe(0);
  });

  test('findByTelegramId returns existing user', () => {
    repo.create({ telegram_id: 123 });
    const user = repo.findByTelegramId(123);
    expect(user).not.toBeNull();
    expect(user!.telegram_id).toBe(123);
  });

  test('findOrCreate creates user if not found', () => {
    const user = repo.findOrCreate({ telegram_id: 456, username: 'bob' });
    expect(user.telegram_id).toBe(456);
    expect(user.username).toBe('bob');
  });

  test('findOrCreate returns existing user and updates cached fields', () => {
    repo.create({ telegram_id: 456, username: 'bob' });
    const user = repo.findOrCreate({ telegram_id: 456, username: 'bob_new' });
    expect(user.telegram_id).toBe(456);
    expect(user.username).toBe('bob_new');
  });

  test('update modifies user fields', () => {
    repo.create({ telegram_id: 123 });
    const updated = repo.update(123, { timezone: 'Europe/Moscow', language: 'ru' });
    expect(updated!.timezone).toBe('Europe/Moscow');
    expect(updated!.language).toBe('ru');
  });

  test('update returns null for non-existent user', () => {
    expect(repo.update(999, { language: 'ru' })).toBeNull();
  });

  test('findByUsername returns user by username (case-insensitive)', () => {
    repo.create({ telegram_id: 123, username: 'larichkina_b' });
    const user = repo.findByUsername('larichkina_b');
    expect(user).not.toBeNull();
    expect(user!.telegram_id).toBe(123);
  });

  test('findByUsername strips @ prefix', () => {
    repo.create({ telegram_id: 123, username: 'larichkina_b' });
    expect(repo.findByUsername('@larichkina_b')).not.toBeNull();
  });

  test('findByUsername returns null for unknown username', () => {
    expect(repo.findByUsername('nobody')).toBeNull();
  });

  test('findByUsername is case-insensitive', () => {
    repo.create({ telegram_id: 123, username: 'AlexUltra' });
    expect(repo.findByUsername('alexultra')).not.toBeNull();
  });

  test('findManyByTelegramIds returns map of found users', () => {
    repo.create({ telegram_id: 1, username: 'alice' });
    repo.create({ telegram_id: 2, username: 'bob' });
    const result = repo.findManyByTelegramIds([1, 2, 999]);
    expect(result.size).toBe(2);
    expect(result.get(1)?.username).toBe('alice');
    expect(result.get(2)?.username).toBe('bob');
    expect(result.has(999)).toBe(false);
  });

  test('findManyByTelegramIds returns empty map for empty input', () => {
    expect(repo.findManyByTelegramIds([]).size).toBe(0);
  });
});
