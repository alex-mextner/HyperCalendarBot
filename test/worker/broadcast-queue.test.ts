import { describe, expect, test } from 'bun:test';
import type { BroadcastEnqueuer, BroadcastJobData, BroadcastSender } from '../../src/worker/broadcast-queue.ts';
import { createBroadcastQueue, createBroadcastWorker } from '../../src/worker/broadcast-queue.ts';

// Unit tests here only verify the module's exported surface and type shapes.
// The real queue/worker behavior (Redis, BullMQ rate-limiter, retries) is
// covered by BullMQ's own tests — we'd need a live Redis for an integration
// test here, and Bun's test runner is in-process, so we just assert the
// contract at the TypeScript level. Handler-level tests in events.test.ts
// verify that tool handlers correctly enqueue jobs via the capability.

describe('broadcast-queue module exports', () => {
  test('createBroadcastQueue and createBroadcastWorker are callable functions', () => {
    expect(typeof createBroadcastQueue).toBe('function');
    expect(typeof createBroadcastWorker).toBe('function');
  });

  test('BroadcastJobData type accepts the documented shape', () => {
    const minimal: BroadcastJobData = {
      recipientId: 42,
      text: 'hello',
      origin: 'group_event_created:1',
    };
    expect(minimal.recipientId).toBe(42);

    const withParseMode: BroadcastJobData = {
      recipientId: 42,
      text: '<b>hi</b>',
      parseMode: 'HTML',
      origin: 'notify_participants:2',
    };
    expect(withParseMode.parseMode).toBe('HTML');
  });

  test('BroadcastEnqueuer contract: enqueue and enqueueBatch', async () => {
    const captured: BroadcastJobData[] = [];
    const fake: BroadcastEnqueuer = {
      enqueue: async (data) => {
        captured.push(data);
      },
      enqueueBatch: async (items) => {
        captured.push(...items);
      },
    };

    await fake.enqueue({ recipientId: 1, text: 'a', origin: 'test' });
    expect(captured).toHaveLength(1);

    await fake.enqueueBatch([
      { recipientId: 2, text: 'b', origin: 'test' },
      { recipientId: 3, text: 'c', origin: 'test' },
    ]);
    expect(captured).toHaveLength(3);
    expect(captured.map((c) => c.recipientId)).toEqual([1, 2, 3]);
  });

  test('BroadcastSender contract matches TelegramSender.sendMessage signature', async () => {
    const calls: { chatId: number; text: string; parseMode?: string }[] = [];
    const fakeSender: BroadcastSender = {
      sendMessage: async (chatId, text, parseMode) => {
        calls.push({ chatId, text, parseMode });
        return { message_id: 1 };
      },
    };

    await fakeSender.sendMessage(10, 'hi', 'HTML');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.chatId).toBe(10);
    expect(calls[0]!.parseMode).toBe('HTML');
  });
});
