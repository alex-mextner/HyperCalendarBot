import { Database } from 'bun:sqlite';
import { describe, expect, mock, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import type { User } from '../../../../src/database/types.ts';
import {
  handleAddTrigger,
  handleListTriggers,
  handleRemoveTrigger,
  handleScheduleAiCall,
  handleScheduleAiCallCancel,
  handleScheduleAiCallsList,
} from '../../../../src/services/ai/tool-handlers/scheduled.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { ScheduledAiCallRepository } from '../../../../src/services/scheduled/scheduled-ai-call.repository.ts';
import { ScheduledAiCallService } from '../../../../src/services/scheduled/scheduled-ai-call.service.ts';
import { TriggerRepository } from '../../../../src/services/scheduled/trigger.repository.ts';

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  const triggerRepo = new TriggerRepository(db);
  const scheduleRepo = new ScheduledAiCallRepository(db);
  const queue = {
    addDelayed: mock(async () => 'j1'),
    addRepeat: mock(async () => {}),
    removeDelayed: mock(async () => {}),
    removeRepeat: mock(async () => {}),
  };
  const scheduledCallService = new ScheduledAiCallService(scheduleRepo, queue);
  return {
    user: { telegram_id: 1, language: 'en', timezone: 'UTC' } as User,
    scheduled: { scheduledCallService, triggerService: { repo: triggerRepo } },
    ...overrides,
  } as Partial<AgentContext> as AgentContext;
}

describe('handleAddTrigger', () => {
  test('creates trigger and returns success', () => {
    const ctx = makeCtx();
    const result = handleAddTrigger(ctx, {
      topic: 'myCalendar.newEvent',
      action: 'call me',
      label: 'test',
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('myCalendar.newEvent');
  });

  test('rejects invalid topic', () => {
    const ctx = makeCtx();
    const result = handleAddTrigger(ctx, { topic: 'invalid.topic', action: 'x' });
    expect(result.success).toBe(false);
  });

  test('rejects invalid condition expression', () => {
    const ctx = makeCtx();
    const result = handleAddTrigger(ctx, { topic: 'myCalendar.newEvent', action: 'x', condition: '!!! bad' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('condition');
  });
});

describe('handleListTriggers', () => {
  test('returns empty list when none exist', () => {
    const ctx = makeCtx();
    const result = handleListTriggers(ctx);
    expect(result.success).toBe(true);
  });
});

describe('handleRemoveTrigger', () => {
  test('removes existing trigger', () => {
    const ctx = makeCtx();
    handleAddTrigger(ctx, { topic: 'myCalendar.newEvent', action: 'x' });
    const list = handleListTriggers(ctx);
    const id = (list.data as { id: string }[])[0]?.id;
    expect(id).toBeDefined();
    const result = handleRemoveTrigger(ctx, { id: id! });
    expect(result.success).toBe(true);
  });
});

describe('handleScheduleAiCall', () => {
  test('creates a one-time scheduled call', async () => {
    const ctx = makeCtx();
    const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const result = await handleScheduleAiCall(ctx, {
      message: 'Check your calendar',
      run_at: futureDate,
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Check your calendar');
  });
});

describe('handleScheduleAiCallsList', () => {
  test('returns empty list when no calls scheduled', () => {
    const ctx = makeCtx();
    const result = handleScheduleAiCallsList(ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('No scheduled calls');
  });

  test('lists scheduled calls after creation', async () => {
    const ctx = makeCtx();
    await handleScheduleAiCall(ctx, { message: 'Daily check', cron: '0 9 * * *' });
    const result = handleScheduleAiCallsList(ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Daily check');
  });
});

describe('handleScheduleAiCallCancel', () => {
  test('cancels an existing scheduled call', async () => {
    const ctx = makeCtx();
    await handleScheduleAiCall(ctx, {
      message: 'To cancel',
      run_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const list = handleScheduleAiCallsList(ctx);
    const id = (list.data as { id: string }[])[0]?.id;
    expect(id).toBeDefined();
    const result = await handleScheduleAiCallCancel(ctx, { id: id! });
    expect(result.success).toBe(true);
    expect(result.output).toContain(id!);
  });
});
