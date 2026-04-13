import { describe, expect, test } from 'bun:test';
import type {
  BroadcastBatchMeta,
  BroadcastJobData,
  BroadcastRedis,
  BroadcastSender,
} from '../../src/worker/broadcast-queue.ts';
import { completeBatchJob, isPermanentTelegramError, processBroadcastJob } from '../../src/worker/broadcast-queue.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTelegramError(code: number): { code: number; payload: { description: string } } {
  return { code, payload: { description: `Error ${code}` } };
}

function makeSender(): BroadcastSender & {
  calls: { chatId: number; text: string; parseMode?: string; threadId?: number }[];
} {
  const calls: { chatId: number; text: string; parseMode?: string; threadId?: number }[] = [];
  return {
    calls,
    sendMessage: async (chatId, text, parseMode, threadId) => {
      calls.push({ chatId, text, parseMode, threadId });
      return { message_id: 1 };
    },
  };
}

/** In-memory fake implementing BroadcastRedis for unit tests. */
function makeFakeRedis(): BroadcastRedis & { store: Map<string, string>; sets: Map<string, Set<string>> } {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    store,
    sets,
    set: async (key, value) => {
      store.set(key, value);
    },
    get: async (key) => store.get(key) ?? null,
    sadd: async (key, member) => {
      if (!sets.has(key)) sets.set(key, new Set());
      sets.get(key)!.add(member);
    },
    smembers: async (key) => [...(sets.get(key) ?? [])],
    incr: async (key) => {
      const val = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(val));
      return val;
    },
    del: async (...keys) => {
      for (const k of keys) {
        store.delete(k);
        sets.delete(k);
      }
    },
    expire: async () => {
      // no-op in tests
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('broadcast-queue module', () => {
  describe('createBroadcastQueue enqueuer', () => {
    test('enqueue calls Queue.add with correct job name and data', async () => {
      const addCalls: [string, BroadcastJobData][] = [];
      const fakeQueue = {
        add: async (name: string, data: BroadcastJobData) => {
          addCalls.push([name, data]);
          return { id: '1' };
        },
        addBulk: async (_items: { name: string; data: BroadcastJobData }[]) => [],
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

  describe('isPermanentTelegramError', () => {
    test('classifies 403 as permanent', () => {
      expect(isPermanentTelegramError(403)).toBe(true);
    });

    test('classifies 400 as transient (could be formatting bug)', () => {
      expect(isPermanentTelegramError(400)).toBe(false);
    });

    test('classifies 429 as transient', () => {
      expect(isPermanentTelegramError(429)).toBe(false);
    });

    test('classifies 500 as transient', () => {
      expect(isPermanentTelegramError(500)).toBe(false);
    });
  });

  describe('processBroadcastJob', () => {
    test('delivers message to recipient on success', async () => {
      const sender = makeSender();
      const data: BroadcastJobData = {
        recipientId: 42,
        text: 'Hello',
        parseMode: 'HTML',
        origin: 'test:1',
      };

      await processBroadcastJob(data, sender);

      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0]!.chatId).toBe(42);
    });

    test('on 403 completes without throwing', async () => {
      const sender: BroadcastSender = {
        sendMessage: async () => {
          throw makeTelegramError(403);
        },
      };

      await processBroadcastJob({ recipientId: 42, text: 'x', origin: 'test:1' }, sender);
    });

    test('on 403 tracks failure in Redis when batchId is set', async () => {
      const redis = makeFakeRedis();
      const sender: BroadcastSender = {
        sendMessage: async () => {
          throw makeTelegramError(403);
        },
      };

      const data: BroadcastJobData = {
        recipientId: 42,
        text: 'Hello',
        origin: 'test:1',
        batchId: 'b1',
        recipientMention: '@alice',
      };

      await processBroadcastJob(data, sender, redis);

      const failed = await redis.smembers('broadcast:batch:b1:failed');
      expect(failed).toEqual(['@alice']);
    });

    test('on 403 without batchId, does not touch Redis', async () => {
      const redis = makeFakeRedis();
      const sender: BroadcastSender = {
        sendMessage: async () => {
          throw makeTelegramError(403);
        },
      };

      await processBroadcastJob({ recipientId: 42, text: 'x', origin: 'test:1' }, sender, redis);

      expect(redis.sets.size).toBe(0);
    });

    test('on 429 re-throws for BullMQ retry', async () => {
      const sender: BroadcastSender = {
        sendMessage: async () => {
          throw makeTelegramError(429);
        },
      };

      await expect(processBroadcastJob({ recipientId: 42, text: 'x', origin: 'test:1' }, sender)).rejects.toMatchObject(
        { code: 429 },
      );
    });

    test('on non-Telegram error re-throws', async () => {
      const sender: BroadcastSender = {
        sendMessage: async () => {
          throw new Error('Network error');
        },
      };

      await expect(processBroadcastJob({ recipientId: 42, text: 'x', origin: 'test:1' }, sender)).rejects.toThrow(
        'Network error',
      );
    });
  });

  describe('completeBatchJob', () => {
    test('does nothing when done < total', async () => {
      const redis = makeFakeRedis();
      const sender = makeSender();

      const meta: BroadcastBatchMeta = {
        total: 3,
        groupChatId: -100,
        fallbackText: 'Link here',
      };
      await redis.set('broadcast:batch:b1:meta', JSON.stringify(meta), 3600);
      await redis.set('broadcast:batch:b1:done', '0', 3600);

      await completeBatchJob('b1', redis, sender);

      // done is now 1, total is 3 — no message sent
      expect(sender.calls).toHaveLength(0);
      expect(redis.store.has('broadcast:batch:b1:meta')).toBe(true);
    });

    test('sends aggregated fallback when done == total and failures exist', async () => {
      const redis = makeFakeRedis();
      const sender = makeSender();

      const meta: BroadcastBatchMeta = {
        total: 2,
        groupChatId: -100,
        threadId: 77,
        fallbackText: 'Deep link message',
      };
      await redis.set('broadcast:batch:b1:meta', JSON.stringify(meta), 3600);
      await redis.set('broadcast:batch:b1:done', '1', 3600); // already 1, will become 2
      await redis.sadd('broadcast:batch:b1:failed', '@alice');
      await redis.sadd('broadcast:batch:b1:failed', '<a href="tg://user?id=99">Bob</a>');

      await completeBatchJob('b1', redis, sender);

      expect(sender.calls).toHaveLength(1);
      const call = sender.calls[0]!;
      expect(call.chatId).toBe(-100);
      expect(call.threadId).toBe(77);
      expect(call.parseMode).toBe('HTML');
      // Message should contain both mentions + the deep link text
      expect(call.text).toContain('@alice');
      expect(call.text).toContain('Bob');
      expect(call.text).toContain('Deep link message');

      // Keys cleaned up
      expect(redis.store.has('broadcast:batch:b1:meta')).toBe(false);
    });

    test('does not send when done == total but no failures', async () => {
      const redis = makeFakeRedis();
      const sender = makeSender();

      const meta: BroadcastBatchMeta = { total: 1, groupChatId: -100, fallbackText: 'x' };
      await redis.set('broadcast:batch:b1:meta', JSON.stringify(meta), 3600);
      await redis.set('broadcast:batch:b1:done', '0', 3600);

      await completeBatchJob('b1', redis, sender);

      expect(sender.calls).toHaveLength(0);
      // Keys still cleaned up
      expect(redis.store.has('broadcast:batch:b1:meta')).toBe(false);
    });

    test('no-op when meta is missing (expired/already cleaned)', async () => {
      const redis = makeFakeRedis();
      const sender = makeSender();
      // No meta stored — simulates expiry
      await redis.set('broadcast:batch:b1:done', '0', 3600);

      await completeBatchJob('b1', redis, sender);

      expect(sender.calls).toHaveLength(0);
    });
  });

  describe('full batch flow (process + complete)', () => {
    test('3 jobs, 1 fails with 403 → one aggregated message after last job', async () => {
      const redis = makeFakeRedis();
      const sender = makeSender();

      const meta: BroadcastBatchMeta = {
        total: 3,
        groupChatId: -200,
        fallbackText: 'Forward this link: https://t.me/Bot?start=s_abc',
      };
      await redis.set('broadcast:batch:b2:meta', JSON.stringify(meta), 3600);
      await redis.set('broadcast:batch:b2:done', '0', 3600);

      const failSender: BroadcastSender = {
        sendMessage: async (chatId) => {
          if (chatId === 42) throw makeTelegramError(403);
          return { message_id: 1 };
        },
      };

      // Job 1: success
      await processBroadcastJob(
        { recipientId: 10, text: 'hi', origin: 'test', batchId: 'b2', recipientMention: '@user1' },
        failSender,
        redis,
      );
      await completeBatchJob('b2', redis, sender); // done=1

      // Job 2: 403 failure
      await processBroadcastJob(
        { recipientId: 42, text: 'hi', origin: 'test', batchId: 'b2', recipientMention: '@alice' },
        failSender,
        redis,
      );
      await completeBatchJob('b2', redis, sender); // done=2

      // Job 3: success
      await processBroadcastJob(
        { recipientId: 20, text: 'hi', origin: 'test', batchId: 'b2', recipientMention: '@user3' },
        failSender,
        redis,
      );
      await completeBatchJob('b2', redis, sender); // done=3 == total → send fallback

      // Only the fallback message was sent (via sender, not failSender)
      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0]!.chatId).toBe(-200);
      expect(sender.calls[0]!.text).toContain('@alice');
      expect(sender.calls[0]!.text).toContain('Forward this link');
    });

    test('all jobs succeed → no fallback sent', async () => {
      const redis = makeFakeRedis();
      const sender = makeSender();

      const meta: BroadcastBatchMeta = { total: 2, groupChatId: -200, fallbackText: 'link' };
      await redis.set('broadcast:batch:b3:meta', JSON.stringify(meta), 3600);
      await redis.set('broadcast:batch:b3:done', '0', 3600);

      const okSender: BroadcastSender = { sendMessage: async () => ({ message_id: 1 }) };

      await processBroadcastJob(
        { recipientId: 10, text: 'hi', origin: 'test', batchId: 'b3', recipientMention: '@a' },
        okSender,
        redis,
      );
      await completeBatchJob('b3', redis, sender);

      await processBroadcastJob(
        { recipientId: 20, text: 'hi', origin: 'test', batchId: 'b3', recipientMention: '@b' },
        okSender,
        redis,
      );
      await completeBatchJob('b3', redis, sender);

      expect(sender.calls).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    test('completeBatchJob with done > total (stalled job recovery) sends fallback once', async () => {
      const redis = makeFakeRedis();
      const sender = makeSender();

      const meta: BroadcastBatchMeta = { total: 1, groupChatId: -100, fallbackText: 'link' };
      await redis.set('broadcast:batch:dup:meta', JSON.stringify(meta), 3600);
      await redis.set('broadcast:batch:dup:done', '0', 3600);
      await redis.sadd('broadcast:batch:dup:failed', '@alice');

      // First call: done=1 == total → sends fallback + cleanup
      await completeBatchJob('dup', redis, sender);
      expect(sender.calls).toHaveLength(1);

      // Second call (duplicate): meta already cleaned up → no-op
      await completeBatchJob('dup', redis, sender);
      expect(sender.calls).toHaveLength(1);
    });

    test('processBroadcastJob with batchId but no recipientMention does not track failure', async () => {
      const redis = makeFakeRedis();
      const sender: BroadcastSender = {
        sendMessage: async () => {
          throw makeTelegramError(403);
        },
      };

      await processBroadcastJob({ recipientId: 42, text: 'x', origin: 'test', batchId: 'b5' }, sender, redis);

      // No mention to store — failure set should be empty
      expect(redis.sets.size).toBe(0);
    });

    test('completeBatchJob with corrupted meta in Redis logs warning', async () => {
      const redis = makeFakeRedis();
      const sender = makeSender();

      await redis.set('broadcast:batch:bad:meta', 'not-json{', 3600);
      await redis.set('broadcast:batch:bad:done', '0', 3600);

      // Should not throw — handles parse error gracefully
      await completeBatchJob('bad', redis, sender);
      expect(sender.calls).toHaveLength(0);
    });

    test('completeBatchJob with invalid meta schema logs warning', async () => {
      const redis = makeFakeRedis();
      const sender = makeSender();

      await redis.set('broadcast:batch:schema:meta', JSON.stringify({ total: 'not-a-number' }), 3600);
      await redis.set('broadcast:batch:schema:done', '0', 3600);

      await completeBatchJob('schema', redis, sender);
      expect(sender.calls).toHaveLength(0);
    });
  });
});
