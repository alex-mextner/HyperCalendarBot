import { describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../../../src/database/schema.ts';
import { migrations } from '../../../../src/database/migrations.ts';
import { TriggerRepository } from '../../../../src/services/scheduled/trigger.repository.ts';
import { ScheduledAiCallRepository } from '../../../../src/services/scheduled/scheduled-ai-call.repository.ts';
import { ScheduledAiCallService } from '../../../../src/services/scheduled/scheduled-ai-call.service.ts';
import {
  handleScheduleAiCall,
  handleScheduleAiCallsList,
  handleScheduleAiCallCancel,
  handleAddTrigger,
  handleListTriggers,
  handleRemoveTrigger,
} from '../../../../src/services/ai/tool-handlers/scheduled.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import type { User } from '../../../../src/database/types.ts';

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
    scheduledCallService,
    triggerService: { repo: triggerRepo },
    ...overrides,
  } as unknown as AgentContext;
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
