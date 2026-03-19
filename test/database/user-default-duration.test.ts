import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';

let db: Database;
let repo: UserRepository;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, migrations);
  repo = new UserRepository(db);
});

afterEach(() => db.close());

test('users.default_event_duration_minutes defaults to 60', () => {
  repo.create({ telegram_id: 1, language: 'ru', timezone: 'UTC' });
  const user = repo.findByTelegramId(1)!;
  expect(user.default_event_duration_minutes).toBe(60);
});

test('UserRepository.update persists default_event_duration_minutes', () => {
  repo.create({ telegram_id: 2, language: 'ru', timezone: 'UTC' });
  const updated = repo.update(2, { default_event_duration_minutes: 30 });
  expect(updated?.default_event_duration_minutes).toBe(30);
});
