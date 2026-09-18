import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { DelayedError } from 'bullmq';
import { migrations } from '../../../src/database/migrations.ts';
import { NotificationLogRepository } from '../../../src/database/repositories/notification-log.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { processNotificationJob } from '../../../src/services/notification/queue.ts';
import {
  createNotificationSender,
  type NotificationJobData,
  processNotification,
} from '../../../src/services/notification/worker.ts';

function senderFor(sendMessage: Parameters<typeof createNotificationSender>[0]['sendMessage']) {
  return createNotificationSender({ sendMessage });
}

describe('production notification delivery contract (#301)', () => {
  let db: Database;
  let repo: NotificationLogRepository;
  let data: NotificationJobData;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    new UserRepository(db).create({ telegram_id: 42, timezone: 'UTC' });
    repo = new NotificationLogRepository(db);
    const logId = repo.insert({
      user_id: 42,
      type: 'daily_agenda',
      reference_key: 'synthetic:301',
      channel: 'telegram_text',
      payload: 'Synthetic notification',
    })!;
    data = { logId, telegramId: 42, type: 'daily_agenda', payload: 'ignored job payload' };
  });
  afterEach(() => db.close());
  function job() {
    return {
      name: 'notification',
      data,
      attemptsMade: 0,
      moveToDelayed: mock(async (_when: number, _token?: string) => {}),
    };
  }

  test('success marks sent exactly once and retains HTML formatting', async () => {
    const api = mock(async (_id: number, _text: string, _mode: 'HTML') => ({ message_id: 123 }));
    const sender = senderFor(api);
    await processNotificationJob(job(), repo, sender);
    await processNotificationJob(job(), repo, sender);
    expect(api.mock.calls).toEqual([[42, 'Synthetic notification', 'HTML']]);
    expect(repo.getById(data.logId)?.status).toBe('sent');
    expect(repo.getById(data.logId)?.sent_at).not.toBeNull();
  });

  test.each([403, 429, 500])('sender preserves exact Telegram error %s and never marks success', async (code) => {
    const error = Object.assign(new Error('Synthetic transport rejection'), { code, payload: { retry_after: 15 } });
    const sender = senderFor(async () => {
      throw error;
    });
    await expect(processNotification(data, repo, sender)).rejects.toBe(error);
    expect(repo.getById(data.logId)?.status).toBe('queued');
    expect(repo.getById(data.logId)?.sent_at).toBeNull();
  });

  test('actual queue processor records terminal 403 as failed rather than sent', async () => {
    const sender = senderFor(async () => {
      throw Object.assign(new Error('Forbidden: blocked'), { code: 403 });
    });
    await processNotificationJob(job(), repo, sender);
    expect(repo.getById(data.logId)?.status).toBe('failed');
    expect(repo.getById(data.logId)?.sent_at).toBeNull();
  });

  test('actual 429 reaches delay handling with the worker token', async () => {
    const item = job();
    const sender = senderFor(async () => {
      throw Object.assign(new Error('Rate limited'), { code: 429, payload: { retry_after: 15 } });
    });
    const before = Date.now();
    await expect(processNotificationJob(item, repo, sender, 'lock-token')).rejects.toBeInstanceOf(DelayedError);
    expect(item.moveToDelayed).toHaveBeenCalledTimes(1);
    expect(item.moveToDelayed.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(before + 15_000);
    expect(item.moveToDelayed.mock.calls[0]?.[1]).toBe('lock-token');
    expect(repo.getById(data.logId)?.status).toBe('queued');
  });

  test('unknown transport failure remains available for BullMQ retry', async () => {
    const error = new Error('Synthetic network outage');
    const sender = senderFor(async () => {
      throw error;
    });
    await expect(processNotificationJob(job(), repo, sender)).rejects.toBe(error);
    expect(repo.getById(data.logId)?.sent_at).toBeNull();
  });

  test('scheduler ticks never invoke the Telegram transport', async () => {
    const api = mock(async () => ({}));
    const scheduler = { tick: mock(async (_now: Date) => {}) };
    await processNotificationJob({ ...job(), name: 'tick' }, repo, senderFor(api), undefined, scheduler);
    expect(scheduler.tick).toHaveBeenCalledTimes(1);
    expect(api).not.toHaveBeenCalled();
  });
  test('late bot initialization replaces the transport without retaining the placeholder', async () => {
    const transport = { sendMessage: async () => ({ message_id: 0 }) };
    const send = createNotificationSender(transport);
    await expect(processNotification(data, repo, send)).rejects.toThrow('did not confirm');
    expect(repo.getById(data.logId)?.status).toBe('queued');
    const real = mock(async () => ({ message_id: 345 }));
    transport.sendMessage = real;
    await processNotification(data, repo, send);
    expect(real).toHaveBeenCalledTimes(1);
    expect(repo.getById(data.logId)?.status).toBe('sent');
  });
});
