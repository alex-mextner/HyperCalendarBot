import { Database } from 'bun:sqlite';
import { describe, expect, mock, test } from 'bun:test';
import type { JobsOptions, WorkerOptions } from 'bullmq';
import { migrations } from '../../src/database/migrations.ts';
import { CallLogRepository } from '../../src/database/repositories/call-log.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import type { CallReminderJobData } from '../../src/services/voice/types.ts';

type JobProcessor = (job: { id: string; data: CallReminderJobData }) => Promise<void>;
type FailedHandler = (job: { id?: string } | undefined, err: Error) => void;

let capturedQueueName = '';
let capturedWorkerName = '';
let capturedProcessor: JobProcessor = async () => {};
let capturedWorkerOpts: WorkerOptions | undefined;
let capturedFailedHandler: FailedHandler = () => {};

const mockQueueAdd = mock(async (_name: string, _data: CallReminderJobData, _opts: JobsOptions) => {});
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
    constructor(name: string, processor: JobProcessor, opts: WorkerOptions) {
      capturedWorkerName = name;
      capturedProcessor = processor;
      capturedWorkerOpts = opts;
    }
    on = mockWorkerOn;
  },
}));

const { createCallQueue, createCallWorker } = await import('../../src/worker/call-queue.ts');

function makeCallLog() {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  return new CallLogRepository(db);
}

describe('createCallQueue', () => {
  test('returns queue and enqueue function', () => {
    const connection = { host: 'localhost', port: 6379 };
    const result = createCallQueue(connection, makeCallLog());
    expect(result.queue).toBeDefined();
    expect(typeof result.enqueue).toBe('function');
  });

  test('queue is named call-reminders', () => {
    createCallQueue({ host: 'localhost', port: 6379 }, makeCallLog());
    expect(capturedQueueName).toBe('call-reminders');
  });

  test('enqueue logs the call as queued and queues it under that log row', async () => {
    mockQueueAdd.mockClear();
    const callLog = makeCallLog();
    const { enqueue } = createCallQueue({ host: 'localhost', port: 6379 }, callLog);
    await enqueue({ userId: 5000000001, ttsText: 'Hello', language: 'ru' });
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = mockQueueAdd.mock.calls[0]!;
    expect(name).toBe('call-reminder');
    expect(data.userId).toBe(5000000001);
    expect(callLog.findById(data.callLogId)).toMatchObject({
      user_id: 5000000001,
      tts_text: 'Hello',
      status: 'queued',
    });
    expect(typeof data.sessionId).toBe('string');
    expect(data.sessionId.length).toBeGreaterThan(0);
    expect(opts.attempts).toBe(1);
    expect(opts.removeOnComplete).toBe(true);
    expect(opts.removeOnFail).toBe(true);
  });

  test('a failed queue write rejects and marks the logged call failed', async () => {
    mockQueueAdd.mockClear();
    mockQueueAdd.mockImplementationOnce(async () => {
      throw new Error('Redis connection lost');
    });
    const callLog = makeCallLog();
    const { enqueue } = createCallQueue({ host: 'localhost', port: 6379 }, callLog);
    await expect(enqueue({ userId: 5000000001, ttsText: 'Hello', language: 'en' })).rejects.toThrow(
      'Redis connection lost',
    );
    expect(callLog.getRecent(5000000001, 5)).toMatchObject([{ status: 'failed', error: 'Redis connection lost' }]);
  });

  test('enqueue generates unique sessionId per call', async () => {
    const { enqueue } = createCallQueue({ host: 'localhost', port: 6379 }, makeCallLog());
    const sessionIds = new Set<string>();
    for (let i = 0; i < 5; i++) {
      mockQueueAdd.mockClear();
      await enqueue({ userId: 1, ttsText: 'x', language: 'en' });
      const [, data] = mockQueueAdd.mock.calls[0]!;
      sessionIds.add(data.sessionId);
    }
    expect(sessionIds.size).toBe(5);
  });
});

describe('createCallWorker', () => {
  test('returns a worker instance', () => {
    const callManager = { executeCall: mock(async () => {}) };
    const worker = createCallWorker({ host: 'localhost', port: 6379 }, callManager);
    expect(worker).toBeDefined();
  });

  test('worker is named call-reminders', () => {
    const callManager = { executeCall: mock(async () => {}) };
    createCallWorker({ host: 'localhost', port: 6379 }, callManager);
    expect(capturedWorkerName).toBe('call-reminders');
  });

  test('worker runs with concurrency 1', () => {
    const callManager = { executeCall: mock(async () => {}) };
    createCallWorker({ host: 'localhost', port: 6379 }, callManager);
    expect(capturedWorkerOpts?.concurrency).toBe(1);
  });

  test('worker processor calls executeCall with job data', async () => {
    const executeCall = mock(async () => {});
    createCallWorker({ host: 'localhost', port: 6379 }, { executeCall });
    const jobData = { userId: 7, callLogId: 2, ttsText: 'Test', language: 'en', sessionId: 'abc' };
    await capturedProcessor({ id: 'j1', data: jobData });
    expect(executeCall).toHaveBeenCalledTimes(1);
    expect(executeCall).toHaveBeenCalledWith(jobData);
  });

  test('failed handler does not throw when job is present', () => {
    const callManager = { executeCall: mock(async () => {}) };
    createCallWorker({ host: 'localhost', port: 6379 }, callManager);
    expect(() => capturedFailedHandler({ id: 'j1' }, new Error('call failed'))).not.toThrow();
  });

  test('failed handler does not throw when job is undefined', () => {
    const callManager = { executeCall: mock(async () => {}) };
    createCallWorker({ host: 'localhost', port: 6379 }, callManager);
    expect(() => capturedFailedHandler(undefined, new Error('no job'))).not.toThrow();
  });
});
