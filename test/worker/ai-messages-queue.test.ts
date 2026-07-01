import { describe, expect, mock, test } from 'bun:test';
import type { User } from '../../src/database/types.ts';
import type { AgentContext } from '../../src/services/ai/types.ts';
import { SyntheticPipelineRunner } from '../../src/worker/ai-messages-queue.ts';

// ─── BullMQ mock setup (must come before dynamic import) ──────────────────────

type JobProcessor = (job: { id: string; data: Record<string, unknown> }) => Promise<void>;
type FailedHandler = (job: { id?: string; data?: Record<string, unknown> } | undefined, err: Error) => void;

let capturedQueueName = '';
let capturedQueueOpts: Record<string, unknown> = {};
let capturedWorkerName = '';
let capturedProcessor: JobProcessor = async () => {};
let capturedWorkerOpts: Record<string, unknown> = {};
let capturedFailedHandler: FailedHandler = () => {};

const mockQueueAdd = mock(async () => ({ id: 'job-123' }));
const mockQueueGetDelayed = mock(async () => []);
const mockQueueGetJob = mock(async () => null);
const mockQueueRemoveRepeatable = mock(async () => {});
const mockWorkerOn = mock((_event: string, handler: FailedHandler) => {
  capturedFailedHandler = handler;
});

mock.module('bullmq', () => ({
  Queue: class MockQueue {
    name: string;
    constructor(name: string, opts: Record<string, unknown>) {
      capturedQueueName = name;
      capturedQueueOpts = opts;
      this.name = name;
    }
    add = mockQueueAdd;
    getDelayed = mockQueueGetDelayed;
    getJob = mockQueueGetJob;
    removeRepeatable = mockQueueRemoveRepeatable;
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

const { createAiMessagesQueue, createAiMessagesWorker } = await import('../../src/worker/ai-messages-queue.ts');

// ─── Test fixtures ─────────────────────────────────────────────────────────────

const fakeUser: User = {
  telegram_id: 1,
  language: 'en',
  timezone: 'UTC',
  username: null,
  first_name: null,
  country_code: null,
  google_refresh_token_enc: null,
  google_calendar_id: null,
  onboarding_completed: 1,
  timezone_updated_at: null,
  voice_response_enabled: null,
  default_event_duration_minutes: 60,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
} as User;

// ─── SyntheticPipelineRunner ───────────────────────────────────────────────────

describe('SyntheticPipelineRunner', () => {
  test('runs intent path when intent matches', async () => {
    const agentCtx = {
      user: fakeUser,
      sender: { sendMessage: mock(async () => ({ message_id: 1 })) },
    } as unknown as AgentContext;
    const contextBuilder = mock(() => agentCtx);
    const intentRun = mock(async () => ({ handled: true, response: 'ok' }));
    const agentRun = mock(async () => {});

    const runner = new SyntheticPipelineRunner({ contextBuilder, intentRun, agentRun });
    await runner.run(fakeUser, { userId: fakeUser.telegram_id, message: 'test message', source: 'trigger' });

    expect(intentRun).toHaveBeenCalledTimes(1);
    expect(agentRun).not.toHaveBeenCalled();
  });

  test('falls through to AI agent when no intent matches', async () => {
    const agentCtx = { user: fakeUser } as unknown as AgentContext;
    const contextBuilder = mock(() => agentCtx);
    const intentRun = mock(async () => ({ handled: false }));
    const agentRun = mock(async () => {});

    const runner = new SyntheticPipelineRunner({ contextBuilder, intentRun, agentRun });
    await runner.run(fakeUser, { userId: fakeUser.telegram_id, message: 'test message', source: 'trigger' });

    expect(intentRun).toHaveBeenCalledTimes(1);
    expect(agentRun).toHaveBeenCalledTimes(1);
  });

  test('catches errors and does not rethrow', async () => {
    const contextBuilder = mock(() => {
      throw new Error('context build failed');
    });
    const intentRun = mock(async () => ({ handled: false }));
    const agentRun = mock(async () => {});

    const runner = new SyntheticPipelineRunner({ contextBuilder, intentRun, agentRun });
    // Must not throw
    await expect(
      runner.run(fakeUser, { userId: fakeUser.telegram_id, message: 'test', source: 'trigger' }),
    ).resolves.toBeUndefined();
  });

  test('catches async errors from intentRun and does not rethrow', async () => {
    const agentCtx = { user: fakeUser } as unknown as AgentContext;
    const contextBuilder = mock(() => agentCtx);
    const intentRun = mock(async () => {
      throw new Error('intent exploded');
    });
    const agentRun = mock(async () => {});

    const runner = new SyntheticPipelineRunner({ contextBuilder, intentRun, agentRun });
    await expect(
      runner.run(fakeUser, { userId: fakeUser.telegram_id, message: 'test', source: 'trigger' }),
    ).resolves.toBeUndefined();
    expect(agentRun).not.toHaveBeenCalled();
  });

  test('catches async errors from agentRun and does not rethrow', async () => {
    const agentCtx = { user: fakeUser } as unknown as AgentContext;
    const contextBuilder = mock(() => agentCtx);
    const intentRun = mock(async () => ({ handled: false }));
    const agentRun = mock(async () => {
      throw new Error('agent exploded');
    });

    const runner = new SyntheticPipelineRunner({ contextBuilder, intentRun, agentRun });
    await expect(
      runner.run(fakeUser, { userId: fakeUser.telegram_id, message: 'test', source: 'trigger' }),
    ).resolves.toBeUndefined();
  });

  test('passes message to contextBuilder and intentRun', async () => {
    const agentCtx = { user: fakeUser } as unknown as AgentContext;
    const contextBuilder = mock(() => agentCtx);
    const intentRun = mock(async () => ({ handled: true }));
    const agentRun = mock(async () => {});

    const runner = new SyntheticPipelineRunner({ contextBuilder, intentRun, agentRun });
    await runner.run(fakeUser, { userId: fakeUser.telegram_id, message: 'remind me tomorrow', source: 'trigger' });

    expect(contextBuilder).toHaveBeenCalledWith(fakeUser, fakeUser.telegram_id, 'remind me tomorrow');
    expect(intentRun).toHaveBeenCalledWith(agentCtx, 'remind me tomorrow');
  });

  test('wires retryEnqueue on scheduled call at attempt=0', async () => {
    const captured: { ctx?: AgentContext } = {};
    const agentCtx = { user: fakeUser } as unknown as AgentContext;
    const contextBuilder = mock(() => agentCtx);
    const intentRun = mock(async (ctx: AgentContext) => {
      captured.ctx = ctx;
      return { handled: false };
    });
    const agentRun = mock(async () => {});

    const runner = new SyntheticPipelineRunner({
      contextBuilder,
      intentRun,
      agentRun,
      retryQueue: { addDelayed: mock(async () => 'job-1') },
    });
    await runner.run(fakeUser, { userId: fakeUser.telegram_id, message: 'check calendar', source: 'scheduled' });

    expect(captured.ctx?.retryEnqueue).toBeFunction();
  });

  test('wires retryEnqueue on trigger call at attempt=0', async () => {
    const captured: { ctx?: AgentContext } = {};
    const agentCtx = { user: fakeUser } as unknown as AgentContext;
    const contextBuilder = mock(() => agentCtx);
    const intentRun = mock(async (ctx: AgentContext) => {
      captured.ctx = ctx;
      return { handled: false };
    });
    const agentRun = mock(async () => {});

    const runner = new SyntheticPipelineRunner({
      contextBuilder,
      intentRun,
      agentRun,
      retryQueue: { addDelayed: mock(async () => 'job-1') },
    });
    await runner.run(fakeUser, { userId: fakeUser.telegram_id, message: 'trigger fired', source: 'trigger' });

    expect(captured.ctx?.retryEnqueue).toBeFunction();
  });

  test('scheduled call at attempt=0: retryEnqueue queues with 30s delay', async () => {
    const captured: { ctx?: AgentContext } = {};
    const agentCtx = { user: fakeUser } as unknown as AgentContext;
    const contextBuilder = mock(() => agentCtx);
    const intentRun = mock(async (ctx: AgentContext) => {
      captured.ctx = ctx;
      return { handled: false };
    });
    const agentRun = mock(async () => {});
    const addDelayed = mock(async (_data: unknown, _delay: number): Promise<string> => 'job-1');

    const runner = new SyntheticPipelineRunner({
      contextBuilder,
      intentRun,
      agentRun,
      retryQueue: { addDelayed },
    });
    await runner.run(fakeUser, { userId: fakeUser.telegram_id, message: 'check calendar', source: 'scheduled' });
    await captured.ctx!.retryEnqueue!('check calendar');

    const [, delay] = addDelayed.mock.calls[0] as unknown as [unknown, number];
    expect(delay).toBe(30_000);
    const [jobData] = addDelayed.mock.calls[0] as unknown as [{ retryAttempt: number }, number];
    expect(jobData.retryAttempt).toBe(1);
  });
});

// ─── createAiMessagesQueue ─────────────────────────────────────────────────────

describe('createAiMessagesQueue', () => {
  test('returns queue and helper functions', () => {
    const result = createAiMessagesQueue({ host: 'localhost', port: 6379 });
    expect(result.queue).toBeDefined();
    expect(typeof result.addDelayed).toBe('function');
    expect(typeof result.addRepeat).toBe('function');
    expect(typeof result.removeDelayed).toBe('function');
    expect(typeof result.removeRepeat).toBe('function');
    expect(typeof result.pushTrigger).toBe('function');
  });

  test('queue is named ai-messages', () => {
    createAiMessagesQueue({ host: 'localhost', port: 6379 });
    expect(capturedQueueName).toBe('ai-messages');
  });

  test('queue default job options have 3 attempts', () => {
    createAiMessagesQueue({ host: 'localhost', port: 6379 });
    const opts = capturedQueueOpts as { defaultJobOptions: { attempts: number } };
    expect(opts.defaultJobOptions.attempts).toBe(3);
  });

  test('queue default job options use exponential backoff', () => {
    createAiMessagesQueue({ host: 'localhost', port: 6379 });
    const opts = capturedQueueOpts as {
      defaultJobOptions: { backoff: { type: string; delay: number } };
    };
    expect(opts.defaultJobOptions.backoff.type).toBe('exponential');
    expect(opts.defaultJobOptions.backoff.delay).toBe(10_000);
  });

  test('addDelayed adds job and returns job id', async () => {
    mockQueueAdd.mockClear();
    const { addDelayed } = createAiMessagesQueue({ host: 'localhost', port: 6379 });
    const id = await addDelayed({ userId: 1, message: 'hello', source: 'scheduled' }, 5000);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(id).toBe('job-123');
    const [name, , opts] = mockQueueAdd.mock.calls[0] as unknown as [string, unknown, { delay: number }];
    expect(name).toBe('ai-schedule');
    expect(opts.delay).toBe(5000);
  });

  test('addRepeat adds job with cron pattern', async () => {
    mockQueueAdd.mockClear();
    const { addRepeat } = createAiMessagesQueue({ host: 'localhost', port: 6379 });
    await addRepeat({ userId: 2, message: 'daily check', source: 'scheduled' }, '0 9 * * *');
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [name, , opts] = mockQueueAdd.mock.calls[0] as unknown as [string, unknown, { repeat: { pattern: string } }];
    expect(name).toBe('ai-schedule');
    expect(opts.repeat.pattern).toBe('0 9 * * *');
  });

  test('removeDelayed removes matching job by scheduleId', async () => {
    const mockRemove = mock(async () => {});
    const fakeDelayedJobs = [
      { data: { scheduleId: 'sched-1', userId: 1 }, remove: mockRemove },
      { data: { scheduleId: 'sched-2', userId: 2 }, remove: mock(async () => {}) },
    ];
    mockQueueGetDelayed.mockImplementation(async () => fakeDelayedJobs as never);

    const { removeDelayed } = createAiMessagesQueue({ host: 'localhost', port: 6379 });
    await removeDelayed('sched-1');
    expect(mockRemove).toHaveBeenCalledTimes(1);

    mockQueueGetDelayed.mockImplementation(async () => []);
  });

  test('removeDelayed is a no-op when scheduleId not found', async () => {
    mockQueueGetDelayed.mockImplementation(async () => []);
    const { removeDelayed } = createAiMessagesQueue({ host: 'localhost', port: 6379 });
    await expect(removeDelayed('non-existent')).resolves.toBeUndefined();
  });

  test('removeRepeat calls removeRepeatable with cron pattern', async () => {
    mockQueueRemoveRepeatable.mockClear();
    const { removeRepeat } = createAiMessagesQueue({ host: 'localhost', port: 6379 });
    await removeRepeat('0 9 * * *');
    expect(mockQueueRemoveRepeatable).toHaveBeenCalledWith('ai-schedule', { pattern: '0 9 * * *' });
  });

  test('pushTrigger adds trigger job', async () => {
    mockQueueAdd.mockClear();
    const { pushTrigger } = createAiMessagesQueue({ host: 'localhost', port: 6379 });
    const data = { userId: 5, message: 'triggered', source: 'trigger' as const, triggerId: 't1' };
    await pushTrigger(data);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [name, jobData] = mockQueueAdd.mock.calls[0] as unknown as [string, typeof data];
    expect(name).toBe('ai-trigger');
    expect(jobData.userId).toBe(5);
    expect(jobData.triggerId).toBe('t1');
  });
});

// ─── createAiMessagesWorker ────────────────────────────────────────────────────

describe('createAiMessagesWorker', () => {
  function makeRunner(opts: { intentHandled?: boolean; throws?: boolean } = {}) {
    const agentCtx = { user: fakeUser } as unknown as AgentContext;
    const contextBuilder = mock(() => agentCtx);
    const intentRun = opts.throws
      ? mock(async () => {
          throw new Error('intent error');
        })
      : mock(async () => ({ handled: opts.intentHandled ?? false }));
    const agentRun = mock(async () => {});
    return {
      runner: new SyntheticPipelineRunner({ contextBuilder, intentRun, agentRun }),
      agentRun,
      intentRun,
    };
  }

  test('returns worker instance', () => {
    const { runner } = makeRunner();
    const worker = createAiMessagesWorker({ host: 'localhost', port: 6379 }, runner, () => null);
    expect(worker).toBeDefined();
  });

  test('worker is named ai-messages', () => {
    const { runner } = makeRunner();
    createAiMessagesWorker({ host: 'localhost', port: 6379 }, runner, () => null);
    expect(capturedWorkerName).toBe('ai-messages');
  });

  test('worker runs with concurrency 5', () => {
    const { runner } = makeRunner();
    createAiMessagesWorker({ host: 'localhost', port: 6379 }, runner, () => null);
    expect((capturedWorkerOpts as { concurrency: number }).concurrency).toBe(5);
  });

  test('processor skips and logs warn when user not found', async () => {
    const { runner } = makeRunner();
    createAiMessagesWorker({ host: 'localhost', port: 6379 }, runner, () => null);
    const job = { id: 'j1', data: { userId: 999, message: 'hello', source: 'trigger' } };
    await expect(capturedProcessor(job as never)).resolves.toBeUndefined();
  });

  test('processor calls runner.run when user is found', async () => {
    const agentCtx = { user: fakeUser } as unknown as AgentContext;
    const contextBuilder = mock(() => agentCtx);
    const intentRun = mock(async () => ({ handled: true }));
    const agentRun = mock(async () => {});
    const runner = new SyntheticPipelineRunner({ contextBuilder, intentRun, agentRun });

    createAiMessagesWorker({ host: 'localhost', port: 6379 }, runner, (id) =>
      id === fakeUser.telegram_id ? fakeUser : null,
    );

    const job = {
      id: 'j2',
      data: { userId: fakeUser.telegram_id, message: 'remind me', source: 'scheduled' },
    };
    await capturedProcessor(job as never);
    expect(intentRun).toHaveBeenCalledTimes(1);
  });

  test('processor calls onRunComplete with scheduleId when provided', async () => {
    const agentCtx = { user: fakeUser } as unknown as AgentContext;
    const contextBuilder = mock(() => agentCtx);
    const intentRun = mock(async () => ({ handled: true }));
    const agentRun = mock(async () => {});
    const runner = new SyntheticPipelineRunner({ contextBuilder, intentRun, agentRun });
    const onRunComplete = mock(() => {});

    createAiMessagesWorker(
      { host: 'localhost', port: 6379 },
      runner,
      (id) => (id === fakeUser.telegram_id ? fakeUser : null),
      onRunComplete,
    );

    const job = {
      id: 'j3',
      data: { userId: fakeUser.telegram_id, message: 'go', source: 'scheduled', scheduleId: 'sched-42' },
    };
    await capturedProcessor(job as never);
    expect(onRunComplete).toHaveBeenCalledTimes(1);
    expect(onRunComplete).toHaveBeenCalledWith('sched-42');
  });

  test('processor does not call onRunComplete when scheduleId is absent', async () => {
    const agentCtx = { user: fakeUser } as unknown as AgentContext;
    const contextBuilder = mock(() => agentCtx);
    const intentRun = mock(async () => ({ handled: true }));
    const agentRun = mock(async () => {});
    const runner = new SyntheticPipelineRunner({ contextBuilder, intentRun, agentRun });
    const onRunComplete = mock(() => {});

    createAiMessagesWorker(
      { host: 'localhost', port: 6379 },
      runner,
      (id) => (id === fakeUser.telegram_id ? fakeUser : null),
      onRunComplete,
    );

    const job = {
      id: 'j4',
      data: { userId: fakeUser.telegram_id, message: 'go', source: 'trigger' },
    };
    await capturedProcessor(job as never);
    expect(onRunComplete).not.toHaveBeenCalled();
  });

  test('failed handler logs error without throwing', () => {
    const { runner } = makeRunner();
    createAiMessagesWorker({ host: 'localhost', port: 6379 }, runner, () => null);
    expect(() =>
      capturedFailedHandler({ id: 'j1', data: { userId: 1, source: 'trigger' } }, new Error('boom')),
    ).not.toThrow();
  });

  test('failed handler does not throw when job is undefined', () => {
    const { runner } = makeRunner();
    createAiMessagesWorker({ host: 'localhost', port: 6379 }, runner, () => null);
    expect(() => capturedFailedHandler(undefined, new Error('no job'))).not.toThrow();
  });
});
