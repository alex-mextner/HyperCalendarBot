import { describe, expect, mock, test } from 'bun:test';
import { handleRenderTable } from '../../../../src/services/ai/tool-handlers/render.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { png } from '../../../fixtures/png.ts';

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    user: { telegram_id: 1, language: 'ru', timezone: 'Europe/Moscow' },
    chatId: 1,
    isGroup: false,
    sender: {
      sendPhoto: mock(() => Promise.resolve({ message_id: 1 })),
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    },
    renderService: {
      renderDirect: mock(() => Promise.resolve(png())),
    },
    eventService: {} as never,
    userRepo: {} as never,
    holidayService: {} as never,
    ...overrides,
  } as Partial<AgentContext> as AgentContext;
}

describe('handleRenderTable', () => {
  test('returns success after render + send photo', async () => {
    const ctx = makeCtx();
    const result = await handleRenderTable(ctx, {
      title: 'Тест',
      markdown: '| A |\n|---|\n| 1 |',
    });
    expect(result.success).toBe(true);
    expect(result.output).toBeTruthy();
  });

  test('output contains the title and past-tense marker', async () => {
    const ctx = makeCtx();
    const result = await handleRenderTable(ctx, {
      title: 'МойЗаголовок',
      markdown: '| A |\n|---|\n| 1 |',
    });
    expect(result.output).toContain('МойЗаголовок');
    // Past tense — avoids the AI-loop class of bugs where models
    // retry because they think the render hasn't completed.
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
    await handleRenderTable(ctx, { title: 'T', markdown: '| A |\n|---|\n| 1 |' });
    expect(sendPhoto).toHaveBeenCalledTimes(1);
  });

  test('agentHint instructs the model not to retry', async () => {
    const ctx = makeCtx();
    const result = await handleRenderTable(ctx, { title: 'T', markdown: '| A |\n|---|\n| 1 |' });
    expect(result.agentHint).toBeDefined();
    expect(result.agentHint!).toContain('Do NOT call render_table again');
  });

  test('fails when renderService missing', async () => {
    const ctx = makeCtx({ renderService: undefined });
    const result = await handleRenderTable(ctx, {
      title: 'Тест',
      markdown: '| A |\n|---|\n| 1 |',
    });
    expect(result.success).toBe(false);
  });

  test('fails when sendPhoto missing', async () => {
    const ctx = makeCtx({ sender: {} as never });
    const result = await handleRenderTable(ctx, {
      title: 'Тест',
      markdown: '| A |\n|---|\n| 1 |',
    });
    expect(result.success).toBe(false);
  });

  test('voice call: output tells user to check chat', async () => {
    const ctx = makeCtx({ inputMode: 'live_call' });
    const result = await handleRenderTable(ctx, {
      title: 'Тест',
      markdown: '| A |\n|---|\n| 1 |',
    });
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/чат|chat/i);
  });

  test('render failure returns success:false with error message', async () => {
    const ctx = makeCtx({
      renderService: {
        renderDirect: mock(() => Promise.reject(new Error('playwright down'))),
      },
    });
    const result = await handleRenderTable(ctx, { title: 'T', markdown: '| A |\n|---|\n| 1 |' });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('sendPhoto failure returns success:false with error message', async () => {
    const ctx = makeCtx({
      sender: {
        sendPhoto: mock(() => Promise.reject(new Error('Telegram 429'))),
        sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
      } as never,
    });
    const result = await handleRenderTable(ctx, { title: 'T', markdown: '| A |\n|---|\n| 1 |' });
    expect(result.success).toBe(false);
  });
});
