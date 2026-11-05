import { describe, expect, mock, test } from 'bun:test';
import { TelegramError } from 'gramio';
import { t } from '../../../../src/config/constants.ts';
import { handleRenderTable } from '../../../../src/services/ai/tool-handlers/render.ts';
import type { AgentContext, TelegramSender } from '../../../../src/services/ai/types.ts';
import { asDouble } from '../../../fixtures/doubles.ts';
import { makeImageDelivery } from '../../../fixtures/image-delivery.ts';
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
    imageDelivery: makeImageDelivery(() => Promise.resolve(png())).delivery,
    eventService: {} as never,
    userRepo: {} as never,
    holidayService: {} as never,
    ...overrides,
  } as Partial<AgentContext> as AgentContext;
}

describe('handleRenderTable', () => {
  test('returns success once the table is queued', async () => {
    const ctx = makeCtx();
    const result = await handleRenderTable(ctx, {
      title: 'Тест',
      markdown: '| A |\n|---|\n| 1 |',
    });
    expect(result.success).toBe(true);
    expect(result.output).toBeTruthy();
  });

  test('output names the title and says the table is being prepared, never that it was sent', async () => {
    const ctx = makeCtx();
    const result = await handleRenderTable(ctx, {
      title: 'МойЗаголовок',
      markdown: '| A |\n|---|\n| 1 |',
    });
    expect(result.output).toContain('МойЗаголовок');
    expect(result.output).toContain('готовится');
    expect(result.output).not.toContain('отправлена');
    expect(result.agentHint).toContain('NOT sent yet');
  });

  test('the photo is sent by the background delivery, after the handler returned', async () => {
    const sendPhoto = mock(() => Promise.resolve({ message_id: 42 }));
    const ctx = makeCtx({
      sender: asDouble<TelegramSender>({
        sendPhoto,
        sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
      }),
    });
    await handleRenderTable(ctx, { title: 'T', markdown: '| A |\n|---|\n| 1 |' });
    expect(sendPhoto).not.toHaveBeenCalled();
    await ctx.imageDelivery!.whenIdle();
    expect(sendPhoto).toHaveBeenCalledTimes(1);
  });

  test('agentHint instructs the model not to retry', async () => {
    const ctx = makeCtx();
    const result = await handleRenderTable(ctx, { title: 'T', markdown: '| A |\n|---|\n| 1 |' });
    expect(result.agentHint).toBeDefined();
    expect(result.agentHint!).toContain('Do NOT call render_table again');
    expect(result.agentHint!).toContain('do NOT say the picture was sent or attached');
  });

  test('fails when image delivery is missing', async () => {
    const ctx = makeCtx({ imageDelivery: undefined });
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

  test('voice call: output tells the caller the picture follows in the chat, and only a live call hears it', async () => {
    const voice = t('ru').aiTools.meta.tableRenderingVoice;
    const args = { title: 'Тест', markdown: '| A |\n|---|\n| 1 |' };
    const live = await handleRenderTable(makeCtx({ inputMode: 'live_call' }), args);
    expect(live.success).toBe(true);
    expect(live.output).toContain(voice);
    const typed = await handleRenderTable(makeCtx(), args);
    expect(typed.output).not.toContain(voice);
  });

  test('a render failure is not a failed tool call: the user gets one note', async () => {
    const ctx = makeCtx({
      imageDelivery: makeImageDelivery(() => Promise.reject(new Error('playwright down'))).delivery,
    });
    const result = await handleRenderTable(ctx, { title: 'T', markdown: '| A |\n|---|\n| 1 |' });
    expect(result.success).toBe(true);
    await ctx.imageDelivery!.whenIdle();
    expect(ctx.sender!.sendMessage).toHaveBeenCalledTimes(1);
    expect(ctx.sender!.sendPhoto).not.toHaveBeenCalled();
  });

  test('an upload Telegram refused sends one note and is not reported as delivered', async () => {
    const sendMessage = mock(() => Promise.resolve({ message_id: 1 }));
    const refused = new TelegramError({ ok: false, error_code: 429, description: 'Too Many Requests' }, 'sendPhoto', {
      chat_id: 1,
      photo: 'photo',
    });
    const ctx = makeCtx({
      sender: asDouble<TelegramSender>({ sendPhoto: mock(() => Promise.reject(refused)), sendMessage }),
    });
    const result = await handleRenderTable(ctx, { title: 'T', markdown: '| A |\n|---|\n| 1 |' });
    expect(result.success).toBe(true);
    await ctx.imageDelivery!.whenIdle();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test('an upload that ended in a dropped connection may have landed: the note says it may not have arrived, not that it failed', async () => {
    const sendMessage = mock((_chatId: number, text: string) => Promise.resolve({ message_id: 1, text }));
    const sendPhoto = mock(() => Promise.reject(new Error('socket hang up')));
    const ctx = makeCtx({ sender: asDouble<TelegramSender>({ sendPhoto, sendMessage }) });
    await handleRenderTable(ctx, { title: 'T', markdown: '| A |\n|---|\n| 1 |' });
    await ctx.imageDelivery!.whenIdle();
    expect(sendPhoto).toHaveBeenCalledTimes(1); // the upload was attempted, then cut off
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(1, t('ru').aiTools.meta.imageNoteUncertain('T'));
  });
});
