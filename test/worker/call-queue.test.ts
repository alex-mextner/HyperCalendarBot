import { describe, expect, mock, test } from 'bun:test';

mock.module('bullmq', () => {
  const mockAdd = mock(() => Promise.resolve());
  const mockQueue = { add: mockAdd, _mockAdd: mockAdd };
  const mockOn = mock(() => {});
  return {
    Queue: class {
      add = mockQueue.add;
      _mockAdd = mockQueue._mockAdd;
    },
    Worker: class {
      processor: ((job: { id: string; data: { userId: number } }) => Promise<void>) | null = null;
      opts: { concurrency?: number; limiter?: { max: number; duration: number } } = {};
      on = mockOn;

      constructor(
        _name: string,
        processor: (job: { id: string; data: { userId: number } }) => Promise<void>,
        opts: { concurrency?: number; limiter?: { max: number; duration: number } },
      ) {
        this.processor = processor;
        this.opts = opts;
      }
    },
  };
});

const { createCallQueue, createCallWorker } = await import('../../src/worker/call-queue.ts');

describe('createCallQueue', () => {
  test('returns object with queue and enqueue properties', () => {
    const result = createCallQueue({ host: 'localhost', port: 6379 });
    expect(result).toHaveProperty('queue');
    expect(result).toHaveProperty('enqueue');
    expect(typeof result.enqueue).toBe('function');
  });

  test('enqueue adds a job with sessionId appended to data', async () => {
    const result = createCallQueue({ host: 'localhost', port: 6379 });
    const addFn = result.queue.add as ReturnType<typeof mock>;

    await result.enqueue({
      userId: 42,
      callLogId: 1,
      ttsText: 'Reminder: meeting in 5 minutes',
      language: 'en',
    });

    expect(addFn).toHaveBeenCalledTimes(1);
    const [jobName, jobData, jobOpts] = addFn.mock.calls[0] as [
      string,
      { userId: number; callLogId: number; ttsText: string; language: string; sessionId: string },
      { attempts: number; removeOnComplete: boolean; removeOnFail: boolean },
    ];
    expect(jobName).toBe('call-reminder');
    expect(jobData.userId).toBe(42);
    expect(jobData.callLogId).toBe(1);
    expect(jobData.ttsText).toBe('Reminder: meeting in 5 minutes');
    expect(jobData.language).toBe('en');
    expect(typeof jobData.sessionId).toBe('string');
    expect(jobData.sessionId.length).toBeGreaterThan(0);
    expect(jobOpts.attempts).toBe(1);
    expect(jobOpts.removeOnComplete).toBe(true);
    expect(jobOpts.removeOnFail).toBe(true);
  });

  test('enqueue generates unique sessionId for each call', async () => {
    const result = createCallQueue({ host: 'localhost', port: 6379 });
    const addFn = result.queue.add as ReturnType<typeof mock>;

    const baseData = { userId: 42, callLogId: 1, ttsText: 'test', language: 'en' };
    await result.enqueue(baseData);
    await result.enqueue(baseData);

    const firstSessionId = (addFn.mock.calls[0] as [string, { sessionId: string }])[1].sessionId;
    const secondSessionId = (addFn.mock.calls[1] as [string, { sessionId: string }])[1].sessionId;
    expect(firstSessionId).not.toBe(secondSessionId);
  });
});

describe('createCallWorker', () => {
  test('creates a worker with concurrency=1 and limiter settings', () => {
    const executeCall = mock(() => Promise.resolve());
    const callManager = { executeCall } as unknown as Parameters<typeof createCallWorker>[1];
    const worker = createCallWorker({ host: 'localhost', port: 6379 }, callManager);

    expect(worker).toBeDefined();
    const opts = (worker as { opts: { concurrency?: number; limiter?: { max: number; duration: number } } }).opts;
    expect(opts.concurrency).toBe(1);
    expect(opts.limiter).toEqual({ max: 1, duration: 5000 });
  });

  test('worker processor calls callManager.executeCall with job data', async () => {
    const executeCall = mock(() => Promise.resolve());
    const callManager = { executeCall } as unknown as Parameters<typeof createCallWorker>[1];
    const worker = createCallWorker({ host: 'localhost', port: 6379 }, callManager);

    const processor = (
      worker as unknown as { processor: (job: { id: string; data: { userId: number } }) => Promise<void> }
    ).processor;
    if (processor) {
      await processor({
        id: 'job-1',
        data: { userId: 42, callLogId: 1, ttsText: 'test', language: 'en', sessionId: 'abc' } as never,
      });
    }
    expect(executeCall).toHaveBeenCalledTimes(1);
  });
});
