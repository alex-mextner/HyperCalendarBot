import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { NotificationLogRepository } from '../../../src/database/repositories/notification-log.repository.ts';

describe('NotificationLogRepository', () => {
  let db: Database;
  let repo: NotificationLogRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    db.run(`CREATE TABLE users (
      telegram_id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.run(`CREATE TABLE notification_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      reference_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      channel TEXT NOT NULL DEFAULT 'telegram_text',
      payload TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`);
    db.run('CREATE UNIQUE INDEX idx_notification_log_dedup ON notification_log(reference_key)');
    db.run('INSERT INTO users (telegram_id) VALUES (42)');
    repo = new NotificationLogRepository(db);
  });

  test('insert returns id on success', () => {
    const id = repo.insert({
      user_id: 42,
      type: 'morning_agenda',
      reference_key: 'ma:42:2026-03-15',
      channel: 'telegram_text',
      payload: '{}',
    });
    expect(id).toBeGreaterThan(0);
  });

  test('insert returns null on duplicate reference_key', () => {
    repo.insert({
      user_id: 42,
      type: 'morning_agenda',
      reference_key: 'ma:42:2026-03-15',
      channel: 'telegram_text',
      payload: '{}',
    });
    const id2 = repo.insert({
      user_id: 42,
      type: 'morning_agenda',
      reference_key: 'ma:42:2026-03-15',
      channel: 'telegram_text',
      payload: '{}',
    });
    expect(id2).toBeNull();
  });

  test('markSent updates status and sent_at', () => {
    const id = repo.insert({
      user_id: 42,
      type: 'event_reminder',
      reference_key: 'er:1',
      channel: 'telegram_text',
      payload: '{}',
    })!;
    repo.markSent(id);
    const row = repo.getById(id);
    expect(row!.status).toBe('sent');
    expect(row!.sent_at).not.toBeNull();
  });

  test('markFailed updates status and error', () => {
    const id = repo.insert({
      user_id: 42,
      type: 'event_reminder',
      reference_key: 'er:2',
      channel: 'telegram_text',
      payload: '{}',
    })!;
    repo.markFailed(id, 'Bot blocked', 3);
    const row = repo.getById(id);
    expect(row!.status).toBe('failed');
    expect(row!.error).toBe('Bot blocked');
    expect(row!.attempts).toBe(3);
  });
});
