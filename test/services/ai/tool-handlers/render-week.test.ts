import { describe, expect, mock, test } from 'bun:test';
import { handleRenderWeekImage } from '../../../../src/services/ai/tool-handlers/render.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    user: { telegram_id: 1, language: 'ru', timezone: 'Europe/Moscow' },
    chatId: 1,
    isGroup: false,
    sender: {
      sendPhoto: mock(() => Promise.resolve({ message_id: 42 })),
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
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
  test('returns success after render + send photo', async () => {
    const ctx = makeCtx();
    const result = await handleRenderWeekImage(ctx, { week_start: '2026-04-07' });
    expect(result.success).toBe(true);
    expect(result.output).toBeTruthy();
  });

  test('output contains week start date and past-tense marker', async () => {
    const ctx = makeCtx();
    // 2026-04-06 is Monday
    const result = await handleRenderWeekImage(ctx, { week_start: '2026-04-06' });
    expect(result.output).toContain('2026-04-06');
    expect(result.output).toContain('отправлена');
  });

  test('sendPhoto is awaited before handler returns', async () => {
    const sendPhoto = mock(() => Promise.resolve({ message_id: 42 }));
    const ctx = makeCtx({
      sender: {
        sendPhoto,
        sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
      } as never,
    });
    await handleRenderWeekImage(ctx, { week_start: '2026-04-07' });
    expect(sendPhoto).toHaveBeenCalledTimes(1);
  });

  test('agentHint instructs the model not to retry', async () => {
    const ctx = makeCtx();
    const result = await handleRenderWeekImage(ctx, { week_start: '2026-04-07' });
    expect(result.agentHint).toBeDefined();
    expect(result.agentHint!).toContain('Do NOT call render_week_image again');
  });

  test('fails when renderService missing', async () => {
    const ctx = makeCtx({ renderService: undefined });
    const result = await handleRenderWeekImage(ctx, { week_start: '2026-04-07' });
    expect(result.success).toBe(false);
  });

  test('fails when sendPhoto missing', async () => {
    const ctx = makeCtx({ sender: {} as never });
    const result = await handleRenderWeekImage(ctx, { week_start: '2026-04-07' });
    expect(result.success).toBe(false);
  });

  test('fails when group scope but no groupChatId', async () => {
    const ctx = makeCtx({ groupChatId: undefined, isGroup: false });
    const result = await handleRenderWeekImage(ctx, { week_start: '2026-04-07', scope: 'group' });
    expect(result.success).toBe(false);
  });

  test('calls getEventsInRangeForGroup when scope is group', async () => {
    const getEventsInRangeForGroup = mock(() => []);
    const ctx = makeCtx({
      isGroup: true,
      groupChatId: 100,
      eventService: { getEventsInRange: mock(() => []), getEventsInRangeForGroup } as never,
    });
    await handleRenderWeekImage(ctx, { week_start: '2026-04-07', scope: 'group' });
    expect(getEventsInRangeForGroup).toHaveBeenCalled();
  });

  test('render failure returns success:false with error message', async () => {
    const ctx = makeCtx({
      renderService: {
        renderDirect: mock(() => Promise.reject(new Error('playwright down'))),
      },
    });
    const result = await handleRenderWeekImage(ctx, { week_start: '2026-04-07' });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('normalizes non-Monday week_start to Monday of same week', async () => {
    // 2026-04-28 is Tuesday; Monday of that week is 2026-04-27
    const ctx = makeCtx();
    const result = await handleRenderWeekImage(ctx, { week_start: '2026-04-28' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('2026-04-27');
    expect(result.output).not.toContain('2026-04-28');
  });
});
