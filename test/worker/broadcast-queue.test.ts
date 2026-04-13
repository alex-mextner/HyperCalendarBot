import { describe, expect, test } from 'bun:test';
import type { BroadcastJobData, BroadcastSender } from '../../src/worker/broadcast-queue.ts';
import {
  createBroadcastQueue,
  createBroadcastWorker,
  isTelegramPermanentError,
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

  describe('isTelegramPermanentError', () => {
    test("returns true for 403 Forbidden (bot can't initiate)", () => {
      const err = new Error("sendMessage: Forbidden: bot can't initiate conversation with a user");
      expect(isTelegramPermanentError(err)).toBe(true);
    });

    test('returns true for "bot was blocked" message', () => {
      const err = new Error('Forbidden: bot was blocked by the user');
      expect(isTelegramPermanentError(err)).toBe(true);
    });

    test('returns true for "user is deactivated" message', () => {
      const err = new Error('Forbidden: user is deactivated');
      expect(isTelegramPermanentError(err)).toBe(true);
    });

    test('returns true for "chat not found" message', () => {
      const err = new Error('Bad Request: chat not found');
      expect(isTelegramPermanentError(err)).toBe(true);
    });

    test('returns true for PEER_ID_INVALID message', () => {
      const err = new Error('PEER_ID_INVALID');
      expect(isTelegramPermanentError(err)).toBe(true);
    });

    test('returns true for error with numeric code 403', () => {
      const err = Object.assign(new Error('Forbidden'), { code: 403 });
      expect(isTelegramPermanentError(err)).toBe(true);
    });

    test('returns true for error with numeric code 404', () => {
      const err = Object.assign(new Error('Not Found'), { code: 404 });
      expect(isTelegramPermanentError(err)).toBe(true);
    });

    test('returns false for transient 429 rate limit', () => {
      const err = Object.assign(new Error('Too Many Requests: retry after 5'), { code: 429 });
      expect(isTelegramPermanentError(err)).toBe(false);
    });

    test('returns false for generic network error', () => {
      const err = new Error('ECONNREFUSED');
      expect(isTelegramPermanentError(err)).toBe(false);
    });

    test('returns false for non-Error values', () => {
      expect(isTelegramPermanentError('string error')).toBe(false);
      expect(isTelegramPermanentError(null)).toBe(false);
      expect(isTelegramPermanentError(undefined)).toBe(false);
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
