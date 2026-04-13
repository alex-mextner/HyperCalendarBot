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

  test('cleanup deletes rows older than N days and returns count', () => {
    repo.insert({
      user_id: 42,
      type: 'event_reminder',
      reference_key: 'er:old1',
      channel: 'telegram_text',
      payload: '{}',
    });
    repo.insert({
      user_id: 42,
      type: 'event_reminder',
      reference_key: 'er:old2',
      channel: 'telegram_text',
      payload: '{}',
    });
    repo.insert({
      user_id: 42,
      type: 'event_reminder',
      reference_key: 'er:new',
      channel: 'telegram_text',
      payload: '{}',
    });
    // Manually age two rows to 31 days ago
    db.run(
      "UPDATE notification_log SET created_at = datetime('now', '-31 days') WHERE reference_key IN ('er:old1', 'er:old2')",
    );

    const deleted = repo.cleanup(30);
    expect(deleted).toBe(2);

    const remaining = db.prepare('SELECT COUNT(*) as n FROM notification_log').get() as { n: number };
    expect(remaining.n).toBe(1);
  });

  test('cleanup returns 0 when nothing is old enough', () => {
    repo.insert({
      user_id: 42,
      type: 'event_reminder',
      reference_key: 'er:recent',
      channel: 'telegram_text',
      payload: '{}',
    });
    const deleted = repo.cleanup(30);
    expect(deleted).toBe(0);
  });

  test('recentByChannel returns entries for the specified channel', () => {
    repo.insert({ user_id: 42, type: 'invitation', reference_key: 'inv:1', channel: 'mtproto_user', payload: '{}' });
    repo.insert({ user_id: 42, type: 'reminder', reference_key: 'rem:1', channel: 'telegram_text', payload: '{}' });
    repo.insert({ user_id: 42, type: 'invitation', reference_key: 'inv:2', channel: 'mtproto_user', payload: '{}' });

    const rows = repo.recentByChannel('mtproto_user', 10);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.type).toBe('invitation');
    }
  });

  test('recentByChannel respects limit', () => {
    repo.insert({ user_id: 42, type: 'inv', reference_key: 'a:1', channel: 'mtproto_user', payload: '{}' });
    repo.insert({ user_id: 42, type: 'inv', reference_key: 'a:2', channel: 'mtproto_user', payload: '{}' });
    repo.insert({ user_id: 42, type: 'inv', reference_key: 'a:3', channel: 'mtproto_user', payload: '{}' });

    const rows = repo.recentByChannel('mtproto_user', 2);
    expect(rows).toHaveLength(2);
  });

  test('recentByChannel returns empty array when no matches', () => {
    repo.insert({ user_id: 42, type: 'reminder', reference_key: 'r:1', channel: 'telegram_text', payload: '{}' });
    const rows = repo.recentByChannel('mtproto_user', 5);
    expect(rows).toHaveLength(0);
  });

  test('getDeliveryStats returns total count and last error for mtproto_user channel', () => {
    repo.insert({ user_id: 42, type: 'inv', reference_key: 'ds:1', channel: 'mtproto_user', payload: '{}' });
    const id2 = repo.insert({
      user_id: 42,
      type: 'inv',
      reference_key: 'ds:2',
      channel: 'mtproto_user',
      payload: '{}',
    })!;
    repo.insert({ user_id: 42, type: 'inv', reference_key: 'ds:3', channel: 'mtproto_user', payload: '{}' });
    // One on a different channel — should not count
    repo.insert({ user_id: 42, type: 'rem', reference_key: 'ds:4', channel: 'telegram_text', payload: '{}' });

    repo.markFailed(id2, 'FloodWait: 30', 1);

    const stats = repo.getDeliveryStats(42);
    expect(stats.total).toBe(3);
    expect(stats.lastError).toBe('FloodWait: 30');
  });

  test('getDeliveryStats returns zero and null when no deliveries', () => {
    const stats = repo.getDeliveryStats(42);
    expect(stats.total).toBe(0);
    expect(stats.lastError).toBeNull();
  });

  test('getDeliveryStats returns null lastError when all succeeded', () => {
    const id = repo.insert({
      user_id: 42,
      type: 'inv',
      reference_key: 'ds:ok',
      channel: 'mtproto_user',
      payload: '{}',
    })!;
    repo.markSent(id);

    const stats = repo.getDeliveryStats(42);
    expect(stats.total).toBe(1);
    expect(stats.lastError).toBeNull();
  });
});
