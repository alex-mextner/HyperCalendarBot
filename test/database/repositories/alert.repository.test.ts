// test/database/repositories/alert.repository.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations';
import { AlertRepository } from '../../../src/database/repositories/alert.repository';
import { runMigrations } from '../../../src/database/schema';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('AlertRepository', () => {
  let repo: AlertRepository;

  beforeEach(() => {
    repo = new AlertRepository(createTestDb());
  });

  test('pop returns null when queue is empty', () => {
    expect(repo.pop()).toBeNull();
  });

  test('push then pop returns the alert', () => {
    repo.push('bot crashed', 'bot');
    const alert = repo.pop();
    expect(alert).not.toBeNull();
    expect(alert!.text).toBe('bot crashed');
    expect(alert!.source).toBe('bot');
  });

  test('pop marks alert as consumed — second pop returns null', () => {
    repo.push('ci failed', 'ci');
    repo.pop();
    expect(repo.pop()).toBeNull();
  });

  test('pop returns alerts in FIFO order', () => {
    repo.push('first', 'ci');
    repo.push('second', 'bot');
    repo.push('third', 'ci');

    expect(repo.pop()!.text).toBe('first');
    expect(repo.pop()!.text).toBe('second');
    expect(repo.pop()!.text).toBe('third');
    expect(repo.pop()).toBeNull();
  });

  test('alert has id and created_at fields', () => {
    repo.push('test alert', 'ci');
    const alert = repo.pop();
    expect(typeof alert!.id).toBe('number');
    expect(typeof alert!.created_at).toBe('string');
    expect(alert!.created_at.length).toBeGreaterThan(0);
  });
});
