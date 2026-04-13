import { describe, expect, test } from 'bun:test';
import type { BroadcastJobData, BroadcastSender } from '../../src/worker/broadcast-queue.ts';
import {
  createBroadcastQueue,
  createBroadcastWorker,
  isPermanentTelegramError,
  processBroadcastJob,
} from '../../src/worker/broadcast-queue.ts';

// Mock Redis connection — BullMQ Queue/Worker constructors accept connection
// options but only attempt to connect when a command is issued. We mock at the
// interface boundary: the enqueuer wraps Queue.add/addBulk, so we test that
// those methods are invoked with the correct payload shapes.

describe('broadcast-queue module', () => {
  describe('createBroadcastQueue enqueuer', () => {
    // We can't call the real createBroadcastQueue without Redis, so we test
    // the BroadcastEnqueuer contract via a fake that matches the interface.
    // The handler-level tests in events.test.ts verify integration.

    test('enqueue calls Queue.add with correct job name and data', async () => {
      const addCalls: [string, BroadcastJobData][] = [];
      const fakeQueue = {
        add: async (name: string, data: BroadcastJobData) => {
          addCalls.push([name, data]);
          return { id: '1' };
        },
        addBulk: async (_items: { name: string; data: BroadcastJobData }[]) => [],
      };
      // Simulate what createBroadcastQueue does internally
      const enqueuer = {
        enqueue: async (data: BroadcastJobData) => {
          await fakeQueue.add('broadcast', data);
        },
        enqueueBatch: async (items: BroadcastJobData[]) => {
          if (items.length === 0) return;
          await fakeQueue.addBulk(items.map((data) => ({ name: 'broadcast', data })));
        },
      };

      const job: BroadcastJobData = {
        recipientId: 42,
        text: 'Hello',
        parseMode: 'HTML',
        origin: 'group_event_created:1',
      };
      await enqueuer.enqueue(job);

      expect(addCalls).toHaveLength(1);
      expect(addCalls[0]![0]).toBe('broadcast');
      expect(addCalls[0]![1]).toEqual(job);
    });

    test('enqueueBatch calls Queue.addBulk with all jobs in a single call', async () => {
      const bulkCalls: { name: string; data: BroadcastJobData }[][] = [];
      const fakeQueue = {
        add: async (_name: string, _data: BroadcastJobData) => ({ id: '1' }),
        addBulk: async (items: { name: string; data: BroadcastJobData }[]) => {
          bulkCalls.push(items);
          return [];
        },
      };
      const enqueuer = {
        enqueue: async (data: BroadcastJobData) => {
          await fakeQueue.add('broadcast', data);
        },
        enqueueBatch: async (items: BroadcastJobData[]) => {
          if (items.length === 0) return;
          await fakeQueue.addBulk(items.map((data) => ({ name: 'broadcast', data })));
        },
      };

      const jobs: BroadcastJobData[] = [
        { recipientId: 1, text: 'a', origin: 'test:1' },
        { recipientId: 2, text: 'b', origin: 'test:2' },
        { recipientId: 3, text: 'c', parseMode: 'HTML', origin: 'test:3' },
      ];
      await enqueuer.enqueueBatch(jobs);

      expect(bulkCalls).toHaveLength(1);
      const bulkArg = bulkCalls[0]!;
      expect(bulkArg).toHaveLength(3);
      expect(bulkArg[0]!.name).toBe('broadcast');
      expect(bulkArg[0]!.data.recipientId).toBe(1);
      expect(bulkArg[2]!.data.parseMode).toBe('HTML');
    });

    test('enqueueBatch with empty array does not call addBulk', async () => {
      let addBulkCalled = false;
      const fakeQueue = {
        add: async (_name: string, _data: BroadcastJobData) => ({ id: '1' }),
        addBulk: async (_items: { name: string; data: BroadcastJobData }[]) => {
          addBulkCalled = true;
          return [];
        },
      };
      const enqueuer = {
        enqueue: async (data: BroadcastJobData) => {
          await fakeQueue.add('broadcast', data);
        },
        enqueueBatch: async (items: BroadcastJobData[]) => {
          if (items.length === 0) return;
          await fakeQueue.addBulk(items.map((data) => ({ name: 'broadcast', data })));
        },
      };

      await enqueuer.enqueueBatch([]);
      expect(addBulkCalled).toBe(false);
    });
  });

  describe('BroadcastSender contract', () => {
    test('sendMessage receives chatId, text, and optional parseMode', async () => {
      const calls: { chatId: number; text: string; parseMode?: string }[] = [];
      const sender: BroadcastSender = {
        sendMessage: async (chatId, text, parseMode) => {
          calls.push({ chatId, text, parseMode });
          return { message_id: 100 };
        },
      };

      await sender.sendMessage(10, 'hi', 'HTML');
      await sender.sendMessage(20, 'plain');

      expect(calls).toHaveLength(2);
      expect(calls[0]!).toEqual({ chatId: 10, text: 'hi', parseMode: 'HTML' });
      expect(calls[1]!).toEqual({ chatId: 20, text: 'plain', parseMode: undefined });
    });

    test('sendMessage failure propagates to caller', async () => {
      const sender: BroadcastSender = {
        sendMessage: async () => {
          throw new Error('Telegram 429');
        },
      };

      await expect(sender.sendMessage(1, 'x')).rejects.toThrow('Telegram 429');
    });
  });

  describe('isPermanentTelegramError', () => {
    test('classifies 403 as permanent', () => {
      expect(isPermanentTelegramError(403)).toBe(true);
    });

    test('classifies 400 as permanent', () => {
      expect(isPermanentTelegramError(400)).toBe(true);
    });

    test('classifies 429 as transient', () => {
      expect(isPermanentTelegramError(429)).toBe(false);
    });

    test('classifies 500 as transient', () => {
      expect(isPermanentTelegramError(500)).toBe(false);
    });

    test('classifies 200 as non-error', () => {
      expect(isPermanentTelegramError(200)).toBe(false);
    });
  });

  describe('processBroadcastJob', () => {
    function makeTelegramError(code: number): { code: number; payload: { description: string } } {
      return { code, payload: { description: `Error ${code}` } };
    }

    test('delivers message to recipient on success', async () => {
      const calls: { chatId: number; text: string; parseMode?: string }[] = [];
      const sender: BroadcastSender = {
        sendMessage: async (chatId, text, parseMode) => {
          calls.push({ chatId, text, parseMode });
          return { message_id: 1 };
        },
      };
      const data: BroadcastJobData = {
        recipientId: 42,
        text: 'Hello',
        parseMode: 'HTML',
        origin: 'test:1',
      };

      await processBroadcastJob(data, sender);

      expect(calls).toHaveLength(1);
      expect(calls[0]!.chatId).toBe(42);
      expect(calls[0]!.text).toBe('Hello');
      expect(calls[0]!.parseMode).toBe('HTML');
    });

    test('on 403 completes silently without throwing', async () => {
      const sender: BroadcastSender = {
        sendMessage: async () => {
          throw makeTelegramError(403);
        },
      };

      const data: BroadcastJobData = {
        recipientId: 42,
        text: 'Hello',
        origin: 'group_event_created:1',
      };

      // Should not throw — permanent error handled internally
      await processBroadcastJob(data, sender);
    });

    test('on 400 completes silently (peer_id_invalid, deactivated)', async () => {
      const sender: BroadcastSender = {
        sendMessage: async () => {
          throw makeTelegramError(400);
        },
      };

      const data: BroadcastJobData = {
        recipientId: 42,
        text: 'Hello',
        origin: 'test:1',
      };

      await processBroadcastJob(data, sender);
    });

    test('on 429 (transient), re-throws for BullMQ retry', async () => {
      const sender: BroadcastSender = {
        sendMessage: async () => {
          throw makeTelegramError(429);
        },
      };

      const data: BroadcastJobData = {
        recipientId: 42,
        text: 'Hello',
        origin: 'test:1',
      };

      await expect(processBroadcastJob(data, sender)).rejects.toMatchObject({ code: 429 });
    });

    test('on non-Telegram error, re-throws for BullMQ retry', async () => {
      const sender: BroadcastSender = {
        sendMessage: async () => {
          throw new Error('Network error');
        },
      };

      const data: BroadcastJobData = {
        recipientId: 42,
        text: 'Hello',
        origin: 'test:1',
      };

      await expect(processBroadcastJob(data, sender)).rejects.toThrow('Network error');
    });
  });

  describe('module exports', () => {
    test('createBroadcastQueue is a function', () => {
      expect(typeof createBroadcastQueue).toBe('function');
    });

    test('createBroadcastWorker is a function', () => {
      expect(typeof createBroadcastWorker).toBe('function');
    });
  });
});
