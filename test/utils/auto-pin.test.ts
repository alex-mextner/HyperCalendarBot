import { describe, expect, test, mock } from 'bun:test';
import { autoPin } from '../../src/utils/auto-pin.ts';

describe('autoPin', () => {
  test('pins message silently', async () => {
    const pinFn = mock(() => Promise.resolve());
    await autoPin(123, 42, {
      pinChatMessage: pinFn,
      sendMessage: mock(() => Promise.resolve()),
      isGroupChat: false,
    });
    expect(pinFn).toHaveBeenCalledWith(123, 42, { disable_notification: true });
  });

  test('shows hint once when pin fails in group', async () => {
    const sendFn = mock(() => Promise.resolve());
    const setPinHintShown = mock(() => {});
    await autoPin(123, 42, {
      pinChatMessage: mock(() => Promise.reject(new Error('not admin'))),
      sendMessage: sendFn,
      isGroupChat: true,
      groupChatRepo: {
        findByChatId: () => ({ pin_hint_shown: 0 } as never),
        setPinHintShown,
      },
    });
    expect(sendFn).toHaveBeenCalled();
    expect(setPinHintShown).toHaveBeenCalledWith(123);
  });

  test('silently skips when hint already shown', async () => {
    const sendFn = mock(() => Promise.resolve());
    await autoPin(123, 42, {
      pinChatMessage: mock(() => Promise.reject(new Error('not admin'))),
      sendMessage: sendFn,
      isGroupChat: true,
      groupChatRepo: {
        findByChatId: () => ({ pin_hint_shown: 1 } as never),
        setPinHintShown: mock(() => {}),
      },
    });
    expect(sendFn).not.toHaveBeenCalled();
  });

  test('silently skips in private chat on failure', async () => {
    const sendFn = mock(() => Promise.resolve());
    await autoPin(123, 42, {
      pinChatMessage: mock(() => Promise.reject(new Error('failed'))),
      sendMessage: sendFn,
      isGroupChat: false,
    });
    expect(sendFn).not.toHaveBeenCalled();
  });

  test('handles send message failure gracefully', async () => {
    const setPinHintShown = mock(() => {});
    await autoPin(123, 42, {
      pinChatMessage: mock(() => Promise.reject(new Error('not admin'))),
      sendMessage: mock(() => Promise.reject(new Error('send failed'))),
      isGroupChat: true,
      groupChatRepo: {
        findByChatId: () => ({ pin_hint_shown: 0 } as never),
        setPinHintShown,
      },
    });
    expect(setPinHintShown).toHaveBeenCalledWith(123);
  });

  test('skips hint when repo is undefined', async () => {
    const sendFn = mock(() => Promise.resolve());
    await autoPin(123, 42, {
      pinChatMessage: mock(() => Promise.reject(new Error('not admin'))),
      sendMessage: sendFn,
      isGroupChat: true,
      groupChatRepo: undefined,
    });
    expect(sendFn).not.toHaveBeenCalled();
  });

  test('skips hint when chat is null', async () => {
    const sendFn = mock(() => Promise.resolve());
    await autoPin(123, 42, {
      pinChatMessage: mock(() => Promise.reject(new Error('not admin'))),
      sendMessage: sendFn,
      isGroupChat: true,
      groupChatRepo: {
        findByChatId: () => null,
        setPinHintShown: mock(() => {}),
      },
    });
    expect(sendFn).not.toHaveBeenCalled();
  });
});
