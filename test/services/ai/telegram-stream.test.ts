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

  test('setToolLabel updates tool status in display', async () => {
    const writer = new TelegramStreamWriter(sender, 123);
    await writer.init();
    writer.setToolLabel('get_events');
    await writer.flush(true);
    expect(editMock).toHaveBeenCalled();
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
    // Should not throw
    await writer.flush(true);
  });
});
