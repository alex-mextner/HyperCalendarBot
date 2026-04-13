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
});
