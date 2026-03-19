import { expect, test } from 'bun:test';
import { handleManageSettings } from '../../../../src/services/ai/tool-handlers/settings.ts';

function makeCtx(duration = 60) {
  const store = { default_event_duration_minutes: duration };
  return {
    user: { telegram_id: 1, timezone: 'UTC', language: 'ru', default_event_duration_minutes: duration } as never,
    userRepo: {
      update: (_id: number, data: Record<string, unknown>) => {
        Object.assign(store, data);
        return { ...store, telegram_id: 1 };
      },
    } as never,
  };
}

test('get general includes default_event_duration_minutes', () => {
  const ctx = makeCtx(45);
  const result = handleManageSettings(ctx as never, { action: 'get', category: 'general' });
  expect(result.success).toBe(true);
  const data = JSON.parse(result.output as string);
  expect(data.default_event_duration_minutes).toBe(45);
});

test('update general persists default_event_duration_minutes', () => {
  const ctx = makeCtx(60);
  const result = handleManageSettings(ctx as never, {
    action: 'update',
    category: 'general',
    updates: { default_event_duration_minutes: 30 },
  });
  expect(result.success).toBe(true);
  expect(result.output).toContain('30');
});

test('update general rejects invalid duration', () => {
  const ctx = makeCtx(60);
  const result = handleManageSettings(ctx as never, {
    action: 'update',
    category: 'general',
    updates: { default_event_duration_minutes: -5 },
  });
  expect(result.success).toBe(false);
});
