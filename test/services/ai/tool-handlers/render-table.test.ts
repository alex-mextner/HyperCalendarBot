import { describe, expect, mock, test } from 'bun:test';
import { handleRenderTable } from '../../../../src/services/ai/tool-handlers/meta.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { flushPromises } from '../../../helpers/mock-context.ts';

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    user: { telegram_id: 1, language: 'ru', timezone: 'Europe/Moscow' },
    chatId: 1,
    isGroup: false,
    sender: {
      sendPhoto: mock(() => Promise.resolve()),
    },
    renderService: {
      renderDirect: mock(() => Promise.resolve(Buffer.from('png'))),
    },
    eventService: {} as never,
    userRepo: {} as never,
    holidayService: {} as never,
    ...overrides,
  } as unknown as AgentContext;
}

describe('handleRenderTable', () => {
  test('returns success with rendering message', () => {
    const ctx = makeCtx();
    const result = handleRenderTable(ctx, {
      title: 'Тест',
      markdown: '| A |\n|---|\n| 1 |',
    });
    expect(result.success).toBe(true);
    expect(result.output).toBeTruthy();
  });

  test('output contains the title', () => {
    const ctx = makeCtx();
    const result = handleRenderTable(ctx, {
      title: 'МойЗаголовок',
      markdown: '| A |\n|---|\n| 1 |',
    });
    expect(result.output).toContain('МойЗаголовок');
  });

  test('fails when renderService missing', () => {
    const ctx = makeCtx({ renderService: undefined });
    const result = handleRenderTable(ctx, {
      title: 'Тест',
      markdown: '| A |\n|---|\n| 1 |',
    });
    expect(result.success).toBe(false);
  });

  test('fails when sendPhoto missing', () => {
    const ctx = makeCtx({ sender: {} as never });
    const result = handleRenderTable(ctx, {
      title: 'Тест',
      markdown: '| A |\n|---|\n| 1 |',
    });
    expect(result.success).toBe(false);
  });

  test('voice call: returns success with chat-redirect message', () => {
    const ctx = makeCtx({ inputMode: 'live_call' });
    const result = handleRenderTable(ctx, {
      title: 'Тест',
      markdown: '| A |\n|---|\n| 1 |',
    });
    expect(result.success).toBe(true);
    // Should still render and send, but output tells user to check chat
    expect(result.output).toMatch(/чат|chat/i);
  });

  test('render failure is caught and does not throw', async () => {
    const ctx = makeCtx({
      renderService: {
        renderDirect: mock(() => Promise.reject(new Error('playwright down'))),
      },
    });
    const result = handleRenderTable(ctx, { title: 'T', markdown: '| A |\n|---|\n| 1 |' });
    // Synchronous return is still success
    expect(result.success).toBe(true);
    // Allow the fire-and-forget promise to settle — must not throw unhandled rejection
    await flushPromises();
  });
});
