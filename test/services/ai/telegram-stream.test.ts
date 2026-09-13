import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { TelegramStreamWriter } from '../../../src/services/ai/telegram-stream.ts';
import type { TelegramSender } from '../../../src/services/ai/types.ts';

describe('TelegramStreamWriter', () => {
  let sender: TelegramSender;
  let sendMock: ReturnType<typeof mock>;
  let editMock: ReturnType<typeof mock>;

  beforeEach(() => {
    sendMock = mock(() => Promise.resolve({ message_id: 42 }));
    editMock = mock(() => Promise.resolve());
    sender = {
      sendMessage: sendMock,
      editMessageText: editMock,
    };
  });

  test('sends initial message on init', async () => {
    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  test('appendText accumulates text', async () => {
    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    writer.appendText('Hello');
    writer.appendText(' world');
    expect(writer.getText()).toBe('Hello world');
  });

  test('flush sends edit when enough text accumulated', async () => {
    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    writer.appendText('A'.repeat(25));
    await writer.flush(true);
    expect(editMock).toHaveBeenCalledTimes(1);
  });

  test('flush skips edit when delta is too small and not forced', async () => {
    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    writer.appendText('Hi');
    await writer.flush(false);
    expect(editMock).toHaveBeenCalledTimes(0);
  });

  test('concurrent non-forced flushes coalesce to one Telegram edit', async () => {
    let resolveEdit: (() => void) | null = null;
    editMock = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveEdit = resolve;
        }),
    );
    sender.editMessageText = editMock;

    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    writer.appendText('A'.repeat(30));

    const flush1 = writer.flush(false);
    const flush2 = writer.flush(false);
    const flush3 = writer.flush(false);

    resolveEdit!();
    await Promise.all([flush1, flush2, flush3]);

    expect(editMock).toHaveBeenCalledTimes(1);
  });

  test('finalize always sends final edit', async () => {
    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    writer.appendText('Done');
    await writer.finalize();
    expect(editMock).toHaveBeenCalledTimes(1);
  });

  test('flush uses HTML parse mode', async () => {
    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    writer.appendText('A'.repeat(25));
    await writer.flush(true);
    const parseMode = editMock.mock.calls[0]![3];
    expect(parseMode).toBe('HTML');
  });

  test('setToolLabel shows tool indicator in flush', async () => {
    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    writer.setToolLabel('get_events');
    await writer.flush(true);
    expect(editMock).toHaveBeenCalled();
    const text = editMock.mock.calls[0]![2] as string;
    expect(text).toContain('<i>');
  });

  test('handles 429 errors gracefully', async () => {
    const error429 = new Error('429 Too Many Requests');
    editMock = mock()
      .mockImplementationOnce(() => Promise.reject(error429))
      .mockImplementation(() => Promise.resolve());
    sender.editMessageText = editMock;

    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    writer.appendText('A'.repeat(30));
    await writer.flush(true);
  });

  test('on stream 429 defers retry and sends only final text', async () => {
    const error429 = { code: 429, message: 'Too Many Requests', payload: { retry_after: 0 } };
    editMock = mock()
      .mockImplementationOnce(() => Promise.reject(error429))
      .mockImplementation(() => Promise.resolve());
    sender.editMessageText = editMock;

    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    writer.appendText('Partial');
    await writer.flush(true);

    writer.appendText(' intermediate');
    await writer.flush(true);

    writer.appendText(' final');
    await writer.finalize();

    expect(editMock).toHaveBeenCalledTimes(2);
    expect(editMock.mock.calls[0]![2]).toBe('Partial...');
    expect(editMock.mock.calls[1]![2]).toBe('Partial intermediate final');
  });

  test('finalize retries 429 using Telegram parameters.retry_after', async () => {
    const error429 = { code: 429, message: 'Too Many Requests', parameters: { retry_after: 0 } };
    editMock = mock()
      .mockImplementationOnce(() => Promise.reject(error429))
      .mockImplementation(() => Promise.resolve());
    sender.editMessageText = editMock;

    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    writer.appendText('Final response');
    await writer.finalize();

    expect(editMock).toHaveBeenCalledTimes(2);
    expect(editMock.mock.calls[0]![2]).toBe('Final response');
    expect(editMock.mock.calls[1]![2]).toBe('Final response');
  });

  test('does NOT downgrade to plain text on HTML parse error — always sends with HTML', async () => {
    const parseError = new Error("Bad Request: can't parse entities");
    editMock = mock()
      .mockImplementationOnce(() => Promise.reject(parseError))
      .mockImplementation(() => Promise.resolve());
    sender.editMessageText = editMock;

    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    writer.appendText('Hello @larichkina_b');
    await writer.flush(true);

    // Only one edit attempt — no fallback to plain text
    expect(editMock).toHaveBeenCalledTimes(1);
  });

  test('finalize splits long messages and sends extras as new messages', async () => {
    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    const para1 = 'a'.repeat(3000);
    const para2 = 'b'.repeat(3000);
    writer.appendText(`${para1}\n\n${para2}`);
    await writer.finalize();

    expect(editMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(2); // init + overflow
  });

  test('setToolLabel with args shows tool arguments in display', async () => {
    const writer = new TelegramStreamWriter(sender, 123, 'ru');
    await writer.init();
    writer.appendText('Создаю...');
    writer.setToolLabel('create_event', { title: 'Спортзал с Леной', start_at: '2026-03-16T20:00:00Z' });
    await writer.flush(true);

    const text = editMock.mock.calls[0]![2] as string;
    expect(text).toContain('Спортзал с Леной');
    expect(text).toContain('start_at');
  });

  test('setToolLabel truncates long arg values', async () => {
    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    writer.setToolLabel('create_event', { title: 'A'.repeat(100) });
    await writer.flush(true);

    const text = editMock.mock.calls[0]![2] as string;
    expect(text).toContain('…');
  });

  test('commitIntermediate + finalize puts reasoning and tools into expandable blockquote', async () => {
    const writer = new TelegramStreamWriter(sender, 123, 'ru');
    await writer.init();
    // Round 1: AI thinks + calls tools
    writer.appendText('Ищу все события...');
    writer.setToolLabel('get_events', { start_date: '2020-01-01' });
    writer.markToolResult(true);
    writer.setToolLabel('delete_event', { event_id: 1 });
    writer.markToolResult(true);
    writer.commitIntermediate();
    // Round 2: final answer
    writer.appendText('Готово! Все удалено.');
    await writer.finalize();

    const text = editMock.mock.calls[0]![2] as string;
    expect(text).toContain('<blockquote expandable>');
    expect(text).toContain('Ход выполнения');
    expect(text).toContain('Ищу все события');
    expect(text).toContain('✅');
    // Final answer is outside blockquote
    expect(text).toMatch(/blockquote>\n\n.*Готово/s);
  });

  test('finalize without tools has no blockquote', async () => {
    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    writer.appendText('Just text');
    await writer.finalize();

    const text = editMock.mock.calls[0]![2] as string;
    expect(text).not.toContain('blockquote');
    expect(text).toContain('Just text');
  });

  test('finalize does not send extra messages when text fits', async () => {
    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    writer.appendText('short text');
    await writer.finalize();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(editMock).toHaveBeenCalledTimes(1);
  });

  // ── Execution log cap ───────────────────────────────────────────────────

  test('finalize caps execution log so total fits in one message', async () => {
    const writer = new TelegramStreamWriter(sender, 123, 'ru');
    await writer.init();
    for (let i = 0; i < 50; i++) {
      writer.appendText(`Searching batch ${i}...`);
      writer.setToolLabel('search_events', { query: `long query text number ${i}` });
      writer.markToolResult(true);
    }
    writer.commitIntermediate();
    writer.appendText('Не нашёл событие.');
    await writer.finalize();

    expect(editMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const text = editMock.mock.calls[0]![2] as string;
    expect(text).toContain('Не нашёл событие');
    expect(text).toContain('<blockquote expandable>');
    expect(text.length).toBeLessThanOrEqual(4000);
  });

  test('finalize skips blockquote when response alone fills message', async () => {
    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    writer.setToolLabel('get_events');
    writer.markToolResult(true);
    writer.commitIntermediate();
    writer.appendText('A'.repeat(3950));
    await writer.finalize();

    const text = editMock.mock.calls[0]![2] as string;
    expect(text).not.toContain('blockquote');
    expect(text).toContain('A'.repeat(100));
  });

  test('truncated execution log body has balanced HTML tags', async () => {
    const writer = new TelegramStreamWriter(sender, 123, 'ru');
    await writer.init();
    for (let i = 0; i < 80; i++) {
      writer.setToolLabel('search_events', { query: `search query number ${i} with extra padding words` });
      writer.markToolResult(true);
    }
    writer.commitIntermediate();
    writer.appendText('R'.repeat(500));
    await writer.finalize();

    const text = editMock.mock.calls[0]![2] as string;
    const openCount = (text.match(/<i>/g) ?? []).length;
    const closeCount = (text.match(/<\/i>/g) ?? []).length;
    expect(openCount).toBe(closeCount);
  });

  // ── Error fallback ──────────────────────────────────────────────────────

  test('sendErrorFallback edits existing message with error text', async () => {
    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    await writer.sendErrorFallback('⚠️ Error occurred');
    expect(editMock).toHaveBeenCalledWith(123, 42, '⚠️ Error occurred');
  });

  test('sendErrorFallback sends new message when no placeholder exists', async () => {
    const writer = new TelegramStreamWriter(sender, 123, 'en', { noPlaceholder: true });
    await writer.init();
    await writer.sendErrorFallback('⚠️ Error occurred');
    expect(sendMock).toHaveBeenCalledWith(123, '⚠️ Error occurred');
  });

  test('sendErrorFallback falls back to sendMessage when edit fails', async () => {
    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    editMock.mockImplementationOnce(() => Promise.reject(new Error('edit failed')));
    await writer.sendErrorFallback('⚠️ Error occurred');
    const lastSendCall = sendMock.mock.calls[sendMock.mock.calls.length - 1] as unknown[];
    expect(lastSendCall[1]).toBe('⚠️ Error occurred');
  });

  test('sendErrorFallback skips fallback send on "message is not modified"', async () => {
    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    const initSendCount = sendMock.mock.calls.length;
    editMock.mockImplementationOnce(() => Promise.reject(new Error('message is not modified')));
    await writer.sendErrorFallback('⚠️ Error occurred');
    expect(sendMock.mock.calls.length).toBe(initSendCount);
  });

  test('sendErrorFallback retries even when placeholder was never created', async () => {
    const failingSend = mock(() => Promise.reject(new Error('network error')));
    sender.sendMessage = failingSend;
    const writer = new TelegramStreamWriter(sender, 123, 'en', { noPlaceholder: true });
    await writer.init();
    await writer.sendErrorFallback('⚠️ Error');
    expect(failingSend.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  // ── Concurrent flush / placeholder races ────────────────────────────────

  test('concurrent flushes in noPlaceholder mode create only one placeholder', async () => {
    let resolveFirst: ((v: { message_id: number }) => void) | null = null;
    const slowSend = mock(
      () =>
        new Promise<{ message_id: number }>((resolve) => {
          if (!resolveFirst) {
            resolveFirst = resolve;
          } else {
            resolve({ message_id: 99 });
          }
        }),
    );
    sender.sendMessage = slowSend;

    const writer = new TelegramStreamWriter(sender, 123, 'en', { noPlaceholder: true });
    await writer.init();

    writer.appendText('A'.repeat(25));
    const flush1 = writer.flush(true);
    const flush2 = writer.flush(true);

    resolveFirst!({ message_id: 50 });
    await flush1;
    await flush2;

    expect(slowSend).toHaveBeenCalledTimes(1);
    expect(writer.getMessageId()).toBe(50);
  });

  test('finalize during pending flush creates only one message', async () => {
    let flushResolve: ((v: { message_id: number }) => void) | null = null;
    const delayedSend = mock(
      () =>
        new Promise<{ message_id: number }>((resolve) => {
          if (!flushResolve) {
            flushResolve = resolve;
          } else {
            resolve({ message_id: 200 });
          }
        }),
    );
    sender.sendMessage = delayedSend;

    const writer = new TelegramStreamWriter(sender, 123, 'ru', { noPlaceholder: true });
    await writer.init();

    writer.appendText('A'.repeat(25));
    const flushPromise = writer.flush(true);

    writer.appendText(' — final answer');
    const finalizePromise = writer.finalize();

    flushResolve!({ message_id: 100 });
    await flushPromise;
    await finalizePromise;

    // finalize awaits the same placeholder promise → reuses messageId=100
    expect(delayedSend).toHaveBeenCalledTimes(1);
  });

  test('rapid tool-start + text-delta flushes in group produce one message', async () => {
    let sendResolve: ((v: { message_id: number }) => void) | null = null;
    let sendCallCount = 0;
    const delayedSend = mock(
      () =>
        new Promise<{ message_id: number }>((resolve) => {
          sendCallCount++;
          if (sendCallCount === 1) {
            sendResolve = resolve;
          } else {
            resolve({ message_id: 200 + sendCallCount });
          }
        }),
    );
    sender.sendMessage = delayedSend;

    const writer = new TelegramStreamWriter(sender, 123, 'ru', { noPlaceholder: true });
    await writer.init();

    writer.setToolLabel('search_events', { query: 'вечерняя прогулка', scope: 'group' });
    const f1 = writer.flush(true);
    writer.appendText('Ищу...');
    const f2 = writer.flush(true);
    writer.setToolLabel('search_events', { query: 'вечерняя прогулка', scope: 'group' });
    const f3 = writer.flush(true);

    sendResolve!({ message_id: 100 });
    await f1;
    await f2;
    await f3;

    expect(delayedSend).toHaveBeenCalledTimes(1);
  });

  // ── Discard ─────────────────────────────────────────────────────────────

  test('discard deletes message created by flush in noPlaceholder mode', async () => {
    const deleteMock = mock(() => Promise.resolve());
    const testSender: TelegramSender = {
      sendMessage: sendMock,
      editMessageText: editMock,
      deleteMessage: deleteMock,
    };

    const writer = new TelegramStreamWriter(testSender, 123, 'en', { noPlaceholder: true });
    await writer.init();

    writer.setToolLabel('get_events');
    await writer.flush(true);
    await writer.discard();

    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledWith(123, 42);
  });

  test('discard during pending flush still deletes the message', async () => {
    let resolveCreate: ((v: { message_id: number }) => void) | null = null;
    const slowSend = mock(
      () =>
        new Promise<{ message_id: number }>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const deleteMock = mock(() => Promise.resolve());
    const testSender: TelegramSender = {
      sendMessage: slowSend,
      editMessageText: editMock,
      deleteMessage: deleteMock,
    };

    const writer = new TelegramStreamWriter(testSender, 123, 'en', { noPlaceholder: true });
    await writer.init();

    writer.appendText('A'.repeat(25));
    writer.setToolLabel('get_events');

    // Fire-and-forget flush — starts creating message (pending)
    writer.flush(true).catch(() => {});

    // Resolve create → discard flag is set, so the promise deletes it
    resolveCreate!({ message_id: 50 });
    await writer.discard();

    expect(deleteMock).toHaveBeenCalledWith(123, 50);
  });

  // ── Error recovery ──────────────────────────────────────────────────────

  test('finalize swallows edit errors but sendErrorFallback delivers', async () => {
    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    writer.appendText('Some response');
    editMock.mockImplementationOnce(() => Promise.reject(new Error('Telegram API down')));
    await writer.finalize();
    editMock.mockImplementation(() => Promise.resolve());
    await writer.sendErrorFallback('⚠️ Ошибка');
    const lastEditCall = editMock.mock.calls[editMock.mock.calls.length - 1] as unknown[];
    expect(lastEditCall[2]).toBe('⚠️ Ошибка');
  });

  test('typing loop is stopped even when finalize edit fails', async () => {
    const chatActionMock = mock(() => Promise.resolve());
    sender.sendChatAction = chatActionMock;

    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    const callsBefore = chatActionMock.mock.calls.length;

    editMock.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    await writer.finalize();

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(chatActionMock.mock.calls.length).toBe(callsBefore);
  });

  // ── Execution log overflow regression ───────────────────────────────────

  test('10 tool calls with long args still produce single message', async () => {
    const writer = new TelegramStreamWriter(sender, 123, 'ru');
    await writer.init();
    for (let i = 0; i < 10; i++) {
      writer.appendText(`Думаю что нужно сделать запрос номер ${i} для получения данных...`);
      writer.setToolLabel('search_events', {
        query: `длинный запрос с множеством слов для поиска событий номер ${i}`,
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        scope: 'group',
      });
      writer.markToolResult(true);
    }
    writer.commitIntermediate();
    writer.appendText('Вот результаты поиска: ничего не найдено по вашему запросу.');
    await writer.finalize();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(editMock).toHaveBeenCalledTimes(1);
    const text = editMock.mock.calls[0]![2] as string;
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toContain('ничего не найдено');
    expect(text).toContain('…');
  });

  test('group chat with 2 tool calls finalizes into exactly one message', async () => {
    const writer = new TelegramStreamWriter(sender, 123, 'ru', { noPlaceholder: true });
    await writer.init();
    writer.setToolLabel('search_events', { query: 'вечерняя прогулка', scope: 'group' });
    writer.markToolResult(true);
    writer.setToolLabel('search_events', { query: 'вечерняя прогулка', scope: 'group' });
    writer.markToolResult(true);
    writer.commitIntermediate();
    writer.appendText('Не нашёл событие «вечерняя прогулка» ни в групповом, ни в личном календаре.');
    await writer.finalize();

    expect(sendMock.mock.calls.length).toBe(1);
    expect(editMock).toHaveBeenCalledTimes(0);
    const sentText = sendMock.mock.calls[0]![1] as string;
    expect(sentText).toContain('вечерняя прогулка');
    expect(sentText).toContain('blockquote');
    expect(sentText.length).toBeLessThanOrEqual(4000);
  });

  // ── RED: bugs that exist right now ──────────────────────────────────────

  test('BUG: line-boundary truncation off-by-one — total can exceed 4000', async () => {
    // body.slice(0, lastNewline) + '\n…' adds 2 chars. When lastNewline
    // equals maxBodyLen-1, the result is maxBodyLen+1 → total exceeds 4000.
    //
    // We can't easily control intermediateChunks content via public API
    // (tool lines have HTML wrappers), so we simulate via commitIntermediate
    // with controlled text. The text path in commitIntermediate uses escapeHtml
    // which doesn't change plain ASCII.

    const header = '⚙️ <b>Execution log</b>';
    const overhead = `<blockquote expandable>${header}\n</blockquote>\n\n`.length;
    const responseLen = 200;
    const maxBodyLen = 4000 - responseLen - overhead;

    const writer = new TelegramStreamWriter(sender, 123, 'en');
    await writer.init();

    // Feed text that will become intermediateChunks via commitIntermediate.
    // Place \n exactly at maxBodyLen-1 position in the joined body.
    // First chunk: exactly maxBodyLen-1 chars (fills up to the \n position)
    writer.appendText('X'.repeat(maxBodyLen - 1));
    writer.commitIntermediate();
    // Second chunk: 100 chars (will be after the \n, gets truncated)
    writer.appendText('Y'.repeat(100));
    writer.commitIntermediate();

    writer.appendText('R'.repeat(responseLen));
    await writer.finalize();

    const text = editMock.mock.calls[editMock.mock.calls.length - 1]![2] as string;
    expect(text.length).toBeLessThanOrEqual(4000);
  });

  test('BUG: flush displayText truncation can break HTML tags', async () => {
    // flush() does: displayText.slice(0, MAX_MESSAGE_LENGTH - 3) + '...'
    // This can cut inside <i>tool label</i>, leaving a broken partial tag like '<i...'
    const writer = new TelegramStreamWriter(sender, 123, 'ru');
    await writer.init();

    // Build text + tool label that together exceed 4000 chars
    writer.appendText('A'.repeat(3990));
    writer.setToolLabel('search_events', { query: 'длинный поисковый запрос для тестирования' });
    await writer.flush(true);

    const text = editMock.mock.calls[0]![2] as string;
    // Must not have broken partial HTML tags (e.g. '<i...' without closing '>')
    expect(text).not.toMatch(/<[^>]*$/);
  });
});
