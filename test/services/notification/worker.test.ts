import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { NotificationLogRepository } from '../../../src/database/repositories/notification-log.repository.ts';
import { parseTelegramError, processNotification } from '../../../src/services/notification/worker.ts';

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

  test('sends with keyboard when buildReminderKeyboard provided and event_id present', async () => {
    const logId = logRepo.insert({
      user_id: 42,
      type: 'event_reminder',
      reference_key: 'er:10',
      channel: 'telegram_text',
      payload: '{"event_id":7,"event_title":"Call","interval_label":"15 min"}',
    })!;

    const sendMessage = mock(() => Promise.resolve());
    const sendWithKeyboard = mock(() => Promise.resolve());

    await processNotification(
      { logId, telegramId: 42, type: 'event_reminder', payload: '{}' },
      logRepo,
      sendMessage,
      sendWithKeyboard,
    );

    expect(sendWithKeyboard).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    const row = logRepo.getById(logId);
    expect(row!.status).toBe('sent');
  });

  test('falls back to sendMessage when event_id missing from payload', async () => {
    const logId = logRepo.insert({
      user_id: 42,
      type: 'event_reminder',
      reference_key: 'er:11',
      channel: 'telegram_text',
      payload: '{"event_title":"NoId","interval_label":"15 min"}',
    })!;

    const sendMessage = mock(() => Promise.resolve());
    const sendWithKeyboard = mock(() => Promise.resolve());

    await processNotification(
      { logId, telegramId: 42, type: 'event_reminder', payload: '{}' },
      logRepo,
      sendMessage,
      sendWithKeyboard,
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendWithKeyboard).not.toHaveBeenCalled();
  });

  test('re-throws on send failure so BullMQ can retry', async () => {
    const logId = logRepo.insert({
      user_id: 42,
      type: 'event_reminder',
      reference_key: 'er:99',
      channel: 'telegram_text',
      payload: '{}',
    })!;

    const sendMessage = mock(() => Promise.reject(new Error('network error')));
    await expect(
      processNotification({ logId, telegramId: 42, type: 'event_reminder', payload: '{}' }, logRepo, sendMessage),
    ).rejects.toThrow('network error');
  });

  describe('parseTelegramError', () => {
    test('returns null for non-objects', () => {
      expect(parseTelegramError('string error')).toBeNull();
      expect(parseTelegramError(null)).toBeNull();
      expect(parseTelegramError(42)).toBeNull();
    });

    test('returns null when code is not a number', () => {
      expect(parseTelegramError({ code: '429', message: 'Too Many Requests' })).toBeNull();
    });

    test('returns code for generic Telegram error', () => {
      const err = { code: 400, message: 'Bad Request' };
      expect(parseTelegramError(err)).toEqual({ code: 400, retryAfter: undefined });
    });

    test('extracts retryAfter from 429 error payload', () => {
      const err = { code: 429, message: 'Too Many Requests', payload: { retry_after: 15 } };
      expect(parseTelegramError(err)).toEqual({ code: 429, retryAfter: 15 });
    });

    test('returns code 403 without retryAfter', () => {
      const err = { code: 403, message: 'Forbidden: bot was blocked by the user' };
      expect(parseTelegramError(err)).toEqual({ code: 403, retryAfter: undefined });
    });

    test('handles missing payload gracefully', () => {
      const err = { code: 429, message: 'Too Many Requests' };
      expect(parseTelegramError(err)).toEqual({ code: 429, retryAfter: undefined });
    });
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
