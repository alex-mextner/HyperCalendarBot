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

  test('tailText trims from the start keeping the tail', () => {
    const writer = new TelegramStreamWriter(sender, 123);
    writer.appendText('A'.repeat(100));
    writer.tailText(10);
    const text = writer.getText();
    expect(text.length).toBe(10);
    expect(text).toMatch(/^…A+$/);
  });

  test('tailText does nothing when text is within limit', () => {
    const writer = new TelegramStreamWriter(sender, 123);
    writer.appendText('hello');
    writer.tailText(100);
    expect(writer.getText()).toBe('hello');
  });

  test('finalize caps execution log so total fits in one message', async () => {
    const writer = new TelegramStreamWriter(sender, 123, 'ru');
    await writer.init();
    // Simulate many tool calls creating a large execution log
    for (let i = 0; i < 50; i++) {
      writer.appendText(`Searching batch ${i}...`);
      writer.setToolLabel('search_events', { query: `long query text number ${i}` });
      writer.markToolResult(true);
    }
    writer.commitIntermediate();
    // Final response
    writer.appendText('Не нашёл событие.');
    await writer.finalize();

    // Should edit the placeholder once (no extra sendMessage for overflow chunks)
    expect(editMock).toHaveBeenCalledTimes(1);
    // Only init + no overflow = 1 sendMessage call
    expect(sendMock).toHaveBeenCalledTimes(1);
    // The message should contain the response and a truncated blockquote
    const text = editMock.mock.calls[0]![2] as string;
    expect(text).toContain('Не нашёл событие');
    expect(text).toContain('<blockquote expandable>');
    expect(text.length).toBeLessThanOrEqual(4000);
  });

  test('finalize skips blockquote when response alone fills message', async () => {
    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    // Tool calls in execution log
    writer.setToolLabel('get_events');
    writer.markToolResult(true);
    writer.commitIntermediate();
    // Very long response that fills the whole message
    writer.appendText('A'.repeat(3950));
    await writer.finalize();

    const text = editMock.mock.calls[0]![2] as string;
    // Blockquote is skipped because response alone fills the message
    expect(text).not.toContain('blockquote');
    expect(text).toContain('A'.repeat(100));
  });

  test('sendErrorFallback edits existing message with error text', async () => {
    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    await writer.sendErrorFallback('⚠️ Error occurred');

    // Should edit the placeholder message (messageId=42 from init)
    expect(editMock).toHaveBeenCalledWith(123, 42, '⚠️ Error occurred');
  });

  test('sendErrorFallback sends new message when no placeholder exists', async () => {
    const writer = new TelegramStreamWriter(sender, 123, 'en', { noPlaceholder: true });
    await writer.init();
    await writer.sendErrorFallback('⚠️ Error occurred');

    // No placeholder was created, so it sends a fresh message
    expect(sendMock).toHaveBeenCalledWith(123, '⚠️ Error occurred');
  });

  test('concurrent flushes in noPlaceholder mode create only one placeholder', async () => {
    // Simulate slow sendMessage to trigger the race window
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
    await writer.init(); // does nothing (noPlaceholder)

    // Fire two concurrent flushes
    writer.appendText('A'.repeat(25));
    const flush1 = writer.flush(true);
    const flush2 = writer.flush(true);

    // Resolve the first sendMessage after both flushes have started
    resolveFirst!({ message_id: 50 });
    await flush1;
    await flush2;

    // Only ONE sendMessage call for the placeholder (second flush returns early)
    expect(slowSend).toHaveBeenCalledTimes(1);
  });

  test('sendErrorFallback falls back to sendMessage when edit fails', async () => {
    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    editMock.mockImplementationOnce(() => Promise.reject(new Error('edit failed')));
    await writer.sendErrorFallback('⚠️ Error occurred');

    // Edit failed, so it should try sendMessage as fallback
    const lastSendCall = sendMock.mock.calls[sendMock.mock.calls.length - 1] as unknown[];
    expect(lastSendCall[1]).toBe('⚠️ Error occurred');
  });

  test('sendErrorFallback skips fallback send on "message is not modified"', async () => {
    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    const initSendCount = sendMock.mock.calls.length;
    editMock.mockImplementationOnce(() => Promise.reject(new Error('message is not modified')));
    await writer.sendErrorFallback('⚠️ Error occurred');

    // "message is not modified" means text is already displayed — no extra send
    expect(sendMock.mock.calls.length).toBe(initSendCount);
  });

  // ── Regression tests: scenarios that were broken before the fix ──────────

  describe('regression: group chat race condition (issue #75)', () => {
    test('rapid tool-start + text-delta flushes in group produce one message', async () => {
      // Simulates the exact scenario from the bug report:
      // AI calls search_events, streaming fires onToolCallStart + onTextDelta
      // in quick succession. Both call flush() fire-and-forget. Before the fix,
      // both would create separate ⏳ placeholders → 2+ messages.
      let sendResolve: ((v: { message_id: number }) => void) | null = null;
      let sendCallCount = 0;
      const delayedSend = mock(
        () =>
          new Promise<{ message_id: number }>((resolve) => {
            sendCallCount++;
            if (sendCallCount === 1) {
              // First call: delay to simulate network latency
              sendResolve = resolve;
            } else {
              resolve({ message_id: 200 + sendCallCount });
            }
          }),
      );
      sender.sendMessage = delayedSend;

      const writer = new TelegramStreamWriter(sender, 123, 'ru', { noPlaceholder: true });
      await writer.init();

      // Simulate onToolCallStart → flush (fire-and-forget)
      writer.setToolLabel('search_events', { query: 'вечерняя прогулка', scope: 'group' });
      const f1 = writer.flush(true);

      // Simulate onTextDelta right after → flush (fire-and-forget)
      writer.appendText('Ищу...');
      const f2 = writer.flush(true);

      // Another onToolCallStart for second search call
      writer.setToolLabel('search_events', { query: 'вечерняя прогулка', scope: 'group' });
      const f3 = writer.flush(true);

      // Now resolve the first sendMessage
      sendResolve!({ message_id: 100 });
      await f1;
      await f2;
      await f3;

      // REGRESSION: old code would have created 3 separate ⏳ messages.
      // Fixed code creates exactly 1.
      expect(delayedSend).toHaveBeenCalledTimes(1);
    });

    test('group chat with 2 tool calls finalizes into exactly one message', async () => {
      const writer = new TelegramStreamWriter(sender, 123, 'ru', { noPlaceholder: true });
      await writer.init();

      // Round 1: AI thinks and calls search_events twice
      writer.setToolLabel('search_events', { query: 'вечерняя прогулка', scope: 'group' });
      writer.markToolResult(true);
      writer.setToolLabel('search_events', { query: 'вечерняя прогулка', scope: 'group' });
      writer.markToolResult(true);
      writer.commitIntermediate();

      // Round 2: AI responds
      writer.appendText('Не нашёл событие «вечерняя прогулка» ни в групповом, ни в личном календаре.');
      await writer.finalize();

      // REGRESSION: old code could split execution log + response into 3 messages.
      // Fixed code: everything fits in 1 message (1 send for lazy placeholder + 0 overflow).
      const totalSends = sendMock.mock.calls.length;
      expect(totalSends).toBe(1); // 1 send (lazy placeholder in finalize or fresh)
      expect(editMock).toHaveBeenCalledTimes(0); // no placeholder to edit → sent fresh

      // The single message contains both the blockquote and the response
      const sentText = sendMock.mock.calls[0]![1] as string;
      expect(sentText).toContain('вечерняя прогулка');
      expect(sentText).toContain('blockquote');
      expect(sentText.length).toBeLessThanOrEqual(4000);
    });
  });

  describe('regression: error delivery guarantee', () => {
    test('finalize swallows edit errors but sendErrorFallback delivers', async () => {
      const writer = new TelegramStreamWriter(sender, 123);
      await writer.init();
      writer.appendText('Some response');

      // Make finalize's editMessageText fail silently (caught internally)
      editMock.mockImplementationOnce(() => Promise.reject(new Error('Telegram API down')));
      await writer.finalize(); // does not throw — error is caught

      // Reset edit mock so sendErrorFallback can succeed
      editMock.mockImplementation(() => Promise.resolve());
      await writer.sendErrorFallback('⚠️ Ошибка');

      // Error was delivered via edit (messageId exists from init)
      const lastEditCall = editMock.mock.calls[editMock.mock.calls.length - 1] as unknown[];
      expect(lastEditCall[2]).toBe('⚠️ Ошибка');
    });

    test('typing loop is stopped even when finalize edit fails', async () => {
      const chatActionMock = mock(() => Promise.resolve());
      sender.sendChatAction = chatActionMock;

      const writer = new TelegramStreamWriter(sender, 123);
      await writer.init();

      // Record how many typing calls happened before finalize
      const callsBefore = chatActionMock.mock.calls.length;

      // Make finalize's edit fail (caught internally)
      editMock.mockImplementationOnce(() => Promise.reject(new Error('boom')));
      await writer.finalize();

      // Wait — if typing loop wasn't stopped, we'd see new calls
      await new Promise((resolve) => setTimeout(resolve, 100));
      const callsAfter = chatActionMock.mock.calls.length;

      // No new typing calls after finalize (loop was stopped in first line)
      expect(callsAfter).toBe(callsBefore);
    });
  });

  describe('regression: execution log overflow', () => {
    test('10 tool calls with long args still produce single message', async () => {
      const writer = new TelegramStreamWriter(sender, 123, 'ru');
      await writer.init();

      // 10 tool calls with long argument strings — realistic scenario
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

      // REGRESSION: old code would splitMessage and send 2+ messages.
      // Fixed code caps execution log body to fit in one message.
      expect(sendMock).toHaveBeenCalledTimes(1); // only init placeholder
      expect(editMock).toHaveBeenCalledTimes(1); // one final edit

      const text = editMock.mock.calls[0]![2] as string;
      expect(text.length).toBeLessThanOrEqual(4000);
      // Response text is preserved (not truncated)
      expect(text).toContain('ничего не найдено');
      // Execution log is truncated with ellipsis
      expect(text).toContain('…');
    });
  });

  // ── Known bugs: these tests document remaining issues ─────────────────
  // Skipped because they FAIL on the current implementation. Un-skip when fixing.

  describe('BUG: execution log cap can break HTML tags', () => {
    test('truncated body must have balanced HTML tags', async () => {
      const writer = new TelegramStreamWriter(sender, 123, 'ru');
      await writer.init();

      // Create tool lines that contain <i>...</i> tags (from markToolResult).
      // When the body is sliced at an arbitrary position, the <i> tag can be
      // left unclosed, making Telegram reject the message.
      // 80 lines × ~70 chars = ~5600 chars body — guaranteed to exceed budget.
      for (let i = 0; i < 80; i++) {
        writer.setToolLabel('search_events', { query: `search query number ${i} with extra padding words` });
        writer.markToolResult(true);
      }
      writer.commitIntermediate();

      // 500-char response leaves ~3400 chars for body → truncation at ~line 48
      // which almost certainly cuts inside an <i>...</i> tag
      writer.appendText('R'.repeat(500));
      await writer.finalize();

      const text = editMock.mock.calls[0]![2] as string;
      // Count opening and closing <i> tags — they must be balanced
      const openCount = (text.match(/<i>/g) ?? []).length;
      const closeCount = (text.match(/<\/i>/g) ?? []).length;
      expect(openCount).toBe(closeCount);
    });
  });

  describe('finalize awaits in-flight flush placeholder', () => {
    test('finalize during pending flush creates only one message', async () => {
      // Scenario: in group chat, flush starts creating placeholder (slow API),
      // then finalize is called before flush completes. finalize must await
      // the same placeholder promise and reuse the messageId.
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

      // Start a flush (fire-and-forget, like onTextDelta does)
      writer.appendText('A'.repeat(25));
      const flushPromise = writer.flush(true);

      // While flush is still waiting for sendMessage, call finalize
      writer.appendText(' — final answer');
      const finalizePromise = writer.finalize();

      // Now resolve the flush's sendMessage
      flushResolve!({ message_id: 100 });
      await flushPromise;
      await finalizePromise;

      // Fixed: finalize awaits the same placeholder promise, reuses messageId=100.
      // Only 1 sendMessage for the placeholder (not 2).
      expect(delayedSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('sendErrorFallback retries on failure regardless of messageId', () => {
    test('error delivery is retried even when placeholder was never created', async () => {
      const failingSend = mock(() => Promise.reject(new Error('network error')));
      sender.sendMessage = failingSend;

      const writer = new TelegramStreamWriter(sender, 123, 'en', { noPlaceholder: true });
      await writer.init(); // no placeholder created

      // sendErrorFallback: messageId is null → tries sendMessage → fails →
      // catch block: retries sendMessage regardless of messageId
      await writer.sendErrorFallback('⚠️ Error');

      // Fixed: retries even when messageId is null (2 attempts total)
      expect(failingSend.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
