import { describe, expect, mock, test } from 'bun:test';

type JobProcessor = (job: { id: string; data: Record<string, unknown> }) => Promise<void>;
type FailedHandler = (job: { id?: string } | undefined, err: Error) => void;

let capturedQueueName = '';
let capturedWorkerName = '';
let capturedProcessor: JobProcessor = async () => {};
let capturedWorkerOpts: Record<string, unknown> = {};
let capturedFailedHandler: FailedHandler = () => {};

const mockQueueAdd = mock(async () => {});
const mockWorkerOn = mock((_event: string, handler: FailedHandler) => {
  capturedFailedHandler = handler;
});

mock.module('bullmq', () => ({
  Queue: class MockQueue {
    name: string;
    constructor(name: string) {
      capturedQueueName = name;
      this.name = name;
    }
    add = mockQueueAdd;
  },
  Worker: class MockWorker {
    constructor(name: string, processor: JobProcessor, opts: Record<string, unknown>) {
      capturedWorkerName = name;
      capturedProcessor = processor;
      capturedWorkerOpts = opts;
    }
    on = mockWorkerOn;
  },
}));

const { createCallQueue, createCallWorker } = await import('../../src/worker/call-queue.ts');

describe('createCallQueue', () => {
  test('returns queue and enqueue function', () => {
    const connection = { host: 'localhost', port: 6379 };
    const result = createCallQueue(connection);
    expect(result.queue).toBeDefined();
    expect(typeof result.enqueue).toBe('function');
  });

  test('queue is named call-reminders', () => {
    createCallQueue({ host: 'localhost', port: 6379 });
    expect(capturedQueueName).toBe('call-reminders');
  });

  test('enqueue adds job with generated sessionId', async () => {
    mockQueueAdd.mockClear();
    const { enqueue } = createCallQueue({ host: 'localhost', port: 6379 });
    await enqueue({
      userId: 42,
      callLogId: 1,
      ttsText: 'Hello',
      language: 'ru',
    });
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = mockQueueAdd.mock.calls[0] as [
      string,
      { userId: number; sessionId: string },
      { attempts: number; removeOnComplete: boolean; removeOnFail: boolean },
    ];
    expect(name).toBe('call-reminder');
    expect(data.userId).toBe(42);
    expect(typeof data.sessionId).toBe('string');
    expect(data.sessionId.length).toBeGreaterThan(0);
    expect(opts.attempts).toBe(1);
    expect(opts.removeOnComplete).toBe(true);
    expect(opts.removeOnFail).toBe(true);
  });

  test('enqueue generates unique sessionId per call', async () => {
    const { enqueue } = createCallQueue({ host: 'localhost', port: 6379 });
    const sessionIds = new Set<string>();
    for (let i = 0; i < 5; i++) {
      mockQueueAdd.mockClear();
      await enqueue({ userId: 1, callLogId: i, ttsText: 'x', language: 'en' });
      const [, data] = mockQueueAdd.mock.calls[0] as [string, { sessionId: string }];
      sessionIds.add(data.sessionId);
    }
    expect(sessionIds.size).toBe(5);
  });
});

describe('createCallWorker', () => {
  test('returns a worker instance', () => {
    const callManager = { executeCall: mock(async () => {}) };
    const worker = createCallWorker({ host: 'localhost', port: 6379 }, callManager as never);
    expect(worker).toBeDefined();
  });

  test('worker is named call-reminders', () => {
    const callManager = { executeCall: mock(async () => {}) };
    createCallWorker({ host: 'localhost', port: 6379 }, callManager as never);
    expect(capturedWorkerName).toBe('call-reminders');
  });

  test('worker runs with concurrency 1', () => {
    const callManager = { executeCall: mock(async () => {}) };
    createCallWorker({ host: 'localhost', port: 6379 }, callManager as never);
    expect((capturedWorkerOpts as { concurrency: number }).concurrency).toBe(1);
  });

  test('worker processor calls executeCall with job data', async () => {
    const executeCall = mock(async () => {});
    createCallWorker({ host: 'localhost', port: 6379 }, { executeCall } as never);
    const jobData = { userId: 7, callLogId: 2, ttsText: 'Test', language: 'en', sessionId: 'abc' };
    await capturedProcessor({ id: 'j1', data: jobData });
    expect(executeCall).toHaveBeenCalledTimes(1);
    expect(executeCall).toHaveBeenCalledWith(jobData);
  });

  test('failed handler does not throw when job is present', () => {
    const callManager = { executeCall: mock(async () => {}) };
    createCallWorker({ host: 'localhost', port: 6379 }, callManager as never);
    expect(() => capturedFailedHandler({ id: 'j1' }, new Error('call failed'))).not.toThrow();
  });

  test('failed handler does not throw when job is undefined', () => {
    const callManager = { executeCall: mock(async () => {}) };
    createCallWorker({ host: 'localhost', port: 6379 }, callManager as never);
    expect(() => capturedFailedHandler(undefined, new Error('no job'))).not.toThrow();
  });
});
