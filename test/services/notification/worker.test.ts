import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { NotificationLogRepository } from '../../../src/database/repositories/notification-log.repository.ts';
import { processNotification } from '../../../src/services/notification/worker.ts';

describe('processNotification', () => {
  let db: Database;
  let logRepo: NotificationLogRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run(`CREATE TABLE users (
      telegram_id INTEGER PRIMARY KEY,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      language TEXT NOT NULL DEFAULT 'en',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.run(`CREATE TABLE notification_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL, type TEXT NOT NULL,
      reference_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      channel TEXT NOT NULL DEFAULT 'telegram_text',
      payload TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`);
    db.run('CREATE UNIQUE INDEX idx_notification_log_dedup ON notification_log(reference_key)');
    db.run('INSERT INTO users (telegram_id) VALUES (42)');
    logRepo = new NotificationLogRepository(db);
  });

  test('marks log as sent after successful delivery', async () => {
    const logId = logRepo.insert({
      user_id: 42,
      type: 'event_reminder',
      reference_key: 'er:1',
      channel: 'telegram_text',
      payload: '{"event_title":"Call","interval_label":"15 minutes"}',
    })!;

    const sendMessage = mock(() => Promise.resolve());
    await processNotification({ logId, telegramId: 42, type: 'event_reminder', payload: '{}' }, logRepo, sendMessage);

    const row = logRepo.getById(logId);
    expect(row!.status).toBe('sent');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test('skips already-sent notifications', async () => {
    const logId = logRepo.insert({
      user_id: 42,
      type: 'event_reminder',
      reference_key: 'er:2',
      channel: 'telegram_text',
      payload: '{}',
    })!;
    logRepo.markSent(logId);

    const sendMessage = mock(() => Promise.resolve());
    await processNotification({ logId, telegramId: 42, type: 'event_reminder', payload: '{}' }, logRepo, sendMessage);

    expect(sendMessage).not.toHaveBeenCalled();
  });
});
