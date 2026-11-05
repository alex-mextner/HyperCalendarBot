import { describe, expect, mock, test } from 'bun:test';
import { handleRenderMonthImage } from '../../../../src/services/ai/tool-handlers/render.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { makeImageDelivery } from '../../../fixtures/image-delivery.ts';
import { png } from '../../../fixtures/png.ts';

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    user: { telegram_id: 1, language: 'ru', timezone: 'Europe/Moscow' },
    chatId: 1,
    isGroup: false,
    sender: {
      sendPhoto: mock(() => Promise.resolve({ message_id: 42 })),
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    },
    imageDelivery: makeImageDelivery(() => Promise.resolve(png())).delivery,
    eventService: {
      getEventsInRange: mock(() => []),
      getEventsInRangeForGroup: mock(() => []),
    },
    userRepo: {} as never,
    holidayService: {} as never,
    ...overrides,
  } as Partial<AgentContext> as AgentContext;
}

describe('handleRenderMonthImage', () => {
  test('returns success once the picture is queued', async () => {
    const ctx = makeCtx();
    const result = await handleRenderMonthImage(ctx, { month: '2026-04' });
    expect(result.success).toBe(true);
    expect(result.output).toBeTruthy();
  });

  test('output names the month and says it is being prepared, never that it was sent', async () => {
    const ctx = makeCtx();
    const result = await handleRenderMonthImage(ctx, { month: '2026-04' });
    expect(result.output).toContain('2026-04');
    expect(result.output).toContain('готовится');
    expect(result.output).not.toContain('отправлена');
  });

  test('the photo is sent by the background delivery, after the handler returned', async () => {
    const sendPhoto = mock(() => Promise.resolve({ message_id: 42 }));
    const ctx = makeCtx({
      sender: {
        sendPhoto,
        sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
      } as never,
    });
    await handleRenderMonthImage(ctx, { month: '2026-04' });
    expect(sendPhoto).not.toHaveBeenCalled();
    await ctx.imageDelivery!.whenIdle();
    expect(sendPhoto).toHaveBeenCalledTimes(1);
  });

  test('agentHint instructs the model not to retry', async () => {
    const ctx = makeCtx();
    const result = await handleRenderMonthImage(ctx, { month: '2026-04' });
    expect(result.agentHint).toBeDefined();
    expect(result.agentHint!).toContain('Do NOT call render_month_image again');
    expect(result.agentHint!).toContain('do NOT say the picture was sent or attached');
  });

  test('fails when image delivery is missing', async () => {
    const ctx = makeCtx({ imageDelivery: undefined });
    const result = await handleRenderMonthImage(ctx, { month: '2026-04' });
    expect(result.success).toBe(false);
  });

  test('fails when sendPhoto missing', async () => {
    const ctx = makeCtx({ sender: {} as never });
    const result = await handleRenderMonthImage(ctx, { month: '2026-04' });
    expect(result.success).toBe(false);
  });

  test('fails when group scope but no groupChatId', async () => {
    const ctx = makeCtx({ groupChatId: undefined, isGroup: false });
    const result = await handleRenderMonthImage(ctx, { month: '2026-04', scope: 'group' });
    expect(result.success).toBe(false);
  });

  test('calls getEventsInRangeForGroup when scope is group', async () => {
    const getEventsInRangeForGroup = mock(() => []);
    const ctx = makeCtx({
      isGroup: true,
      groupChatId: 100,
      eventService: { getEventsInRange: mock(() => []), getEventsInRangeForGroup } as never,
    });
    await handleRenderMonthImage(ctx, { month: '2026-04', scope: 'group' });
    expect(getEventsInRangeForGroup).toHaveBeenCalled();
  });

  test('accepts YYYY-MM-DD format and parses correctly', async () => {
    const ctx = makeCtx();
    const result = await handleRenderMonthImage(ctx, { month: '2026-04-01' });
    expect(result.success).toBe(true);
  });

  test('a render failure is not a failed tool call: the user gets one note', async () => {
    const ctx = makeCtx({
      imageDelivery: makeImageDelivery(() => Promise.reject(new Error('playwright down'))).delivery,
    });
    const result = await handleRenderMonthImage(ctx, { month: '2026-04' });
    expect(result.success).toBe(true);
    await ctx.imageDelivery!.whenIdle();
    expect(ctx.sender!.sendMessage).toHaveBeenCalledTimes(1);
    expect(ctx.sender!.sendPhoto).not.toHaveBeenCalled();
  });
});
