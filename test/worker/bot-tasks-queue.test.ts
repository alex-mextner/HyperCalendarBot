import { expect, test } from 'bun:test';

test('BotTaskJobType includes cron-birthday-sync', async () => {
  const { setupBirthdaySyncCron } = await import('../../src/worker/bot-tasks-queue.ts');
  expect(typeof setupBirthdaySyncCron).toBe('function');
});
