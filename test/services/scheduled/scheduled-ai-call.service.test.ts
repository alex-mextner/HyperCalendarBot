import { Database } from 'bun:sqlite';
import { describe, expect, mock, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { ScheduledAiCallRepository } from '../../../src/services/scheduled/scheduled-ai-call.repository.ts';
import { ScheduledAiCallService } from '../../../src/services/scheduled/scheduled-ai-call.service.ts';

function makeService() {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  const repo = new ScheduledAiCallRepository(db);
  const addDelayed = mock(async (_data: unknown, _delayMs: number) => 'job-1');
  const addRepeat = mock(async (_data: unknown, _cron: string) => {});
  const removeDelayed = mock(async (_scheduleId: string) => {});
  const removeRepeat = mock(async (_cron: string) => {});
  const removeJobById = mock(async (_jobId: string) => {});
  const service = new ScheduledAiCallService(repo, {
    addDelayed,
    addRepeat,
    removeDelayed,
    removeRepeat,
    removeJobById,
  });
  return { service, repo, addDelayed, addRepeat, removeDelayed, removeRepeat };
}

describe('ScheduledAiCallService', () => {
  test('create one-time schedule: saves to DB and calls addDelayed', async () => {
    const { service, repo, addDelayed } = makeService();
    const futureTime = new Date(Date.now() + 60_000).toISOString();
    const id = await service.create({ userId: 1, message: 'call me', runAt: futureTime, cron: null, label: 'test' });
    expect(addDelayed).toHaveBeenCalledTimes(1);
    expect(repo.findById(id)).not.toBeNull();
  });

  test('create recurring schedule: saves to DB and calls addRepeat', async () => {
    const { service, repo, addRepeat } = makeService();
    const id = await service.create({ userId: 1, message: 'ping', runAt: null, cron: '0 11 * * *', label: null });
    expect(addRepeat).toHaveBeenCalledTimes(1);
    expect(repo.findById(id)?.cron).toBe('0 11 * * *');
  });

  test('enforces per-user limit of 50', async () => {
    const { service } = makeService();
    const futureTime = new Date(Date.now() + 60_000).toISOString();
    for (let i = 0; i < 50; i++) {
      await service.create({ userId: 1, message: 'x', runAt: futureTime, cron: null, label: null });
    }
    await expect(
      service.create({ userId: 1, message: 'x', runAt: futureTime, cron: null, label: null }),
    ).rejects.toThrow('limit');
  });

  test('cancel disables in DB and calls removeDelayed', async () => {
    const { service, repo, removeDelayed } = makeService();
    const futureTime = new Date(Date.now() + 60_000).toISOString();
    const id = await service.create({ userId: 1, message: 'x', runAt: futureTime, cron: null, label: null });
    await service.cancel(id, 1);
    expect(removeDelayed).toHaveBeenCalledWith(id);
    expect(repo.findById(id)?.enabled).toBe(0);
  });

  test('cancel recurring calls removeRepeat with cron pattern', async () => {
    const { service, repo, removeRepeat } = makeService();
    const id = await service.create({ userId: 1, message: 'x', runAt: null, cron: '0 9 * * 1', label: null });
    await service.cancel(id, 1);
    expect(removeRepeat).toHaveBeenCalledWith('0 9 * * 1');
    expect(repo.findById(id)?.enabled).toBe(0);
  });
});
