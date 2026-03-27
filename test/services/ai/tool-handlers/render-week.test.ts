import { describe, expect, mock, test } from 'bun:test';
import { handleRenderWeekImage } from '../../../../src/services/ai/tool-handlers/render.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { flushPromises } from '../../../helpers/mock-context.ts';

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    user: { telegram_id: 1, language: 'ru', timezone: 'Europe/Moscow' },
    chatId: 1,
    isGroup: false,
    sender: {
      sendPhoto: mock(() => Promise.resolve({ message_id: 42 })),
      sendMessage: mock(() => Promise.resolve()),
    },
    renderService: {
      renderDirect: mock(() => Promise.resolve(Buffer.from('png'))),
    },
    eventService: {
      getEventsInRange: mock(() => []),
      getEventsInRangeForGroup: mock(() => []),
    },
    userRepo: {} as never,
    holidayService: {} as never,
    ...overrides,
  } as Partial<AgentContext> as AgentContext;
}

describe('handleRenderWeekImage', () => {
  test('returns success with rendering message', () => {
    const ctx = makeCtx();
    const result = handleRenderWeekImage(ctx, { week_start: '2026-04-07' });
    expect(result.success).toBe(true);
    expect(result.output).toBeTruthy();
  });

  test('output contains week start date', () => {
    const ctx = makeCtx();
    const result = handleRenderWeekImage(ctx, { week_start: '2026-04-07' });
    expect(result.output).toContain('2026-04-07');
  });

  test('fails when renderService missing', () => {
    const ctx = makeCtx({ renderService: undefined });
    const result = handleRenderWeekImage(ctx, { week_start: '2026-04-07' });
    expect(result.success).toBe(false);
  });

  test('fails when sendPhoto missing', () => {
    const ctx = makeCtx({ sender: {} as never });
    const result = handleRenderWeekImage(ctx, { week_start: '2026-04-07' });
    expect(result.success).toBe(false);
  });

  test('fails when group scope but no groupChatId', () => {
    const ctx = makeCtx({ groupChatId: undefined, isGroup: false });
    const result = handleRenderWeekImage(ctx, { week_start: '2026-04-07', scope: 'group' });
    expect(result.success).toBe(false);
  });

  test('calls getEventsInRangeForGroup when scope is group', async () => {
    const getEventsInRangeForGroup = mock(() => []);
    const ctx = makeCtx({
      isGroup: true,
      groupChatId: 100,
      eventService: { getEventsInRange: mock(() => []), getEventsInRangeForGroup } as never,
    });
    handleRenderWeekImage(ctx, { week_start: '2026-04-07', scope: 'group' });
    await flushPromises();
    expect(getEventsInRangeForGroup).toHaveBeenCalled();
  });

  test('render failure is caught and does not throw', async () => {
    const ctx = makeCtx({
      renderService: {
        renderDirect: mock(() => Promise.reject(new Error('playwright down'))),
      },
    });
    const result = handleRenderWeekImage(ctx, { week_start: '2026-04-07' });
    expect(result.success).toBe(true);
    await flushPromises();
  });
});
