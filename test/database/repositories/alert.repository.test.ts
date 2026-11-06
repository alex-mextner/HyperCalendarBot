// test/database/repositories/alert.repository.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations';
import { AlertRepository } from '../../../src/database/repositories/alert.repository';
import { runMigrations } from '../../../src/database/schema';
import { FAKE_GETME_URL, FAKE_TELEGRAM_TOKEN } from '../../helpers/fake-secrets.ts';

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

  test('push stores the text without a Telegram bot token, whoever produced the alert (#972)', () => {
    repo.push(`Bot unhandled rejection: TypeError: request to ${FAKE_GETME_URL} failed`, 'bot-crash');

    const alert = repo.pop();
    expect(alert!.text).not.toContain(FAKE_TELEGRAM_TOKEN);
    expect(alert!.text).toContain('Bot unhandled rejection');
    expect(alert!.text).toContain('/getMe');
  });
});
