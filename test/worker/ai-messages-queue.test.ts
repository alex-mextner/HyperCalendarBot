import { describe, expect, mock, test } from 'bun:test';
import type { User } from '../../src/database/types.ts';
import { aiFailureNotices } from '../../src/services/ai/agent.ts';
import type { AgentContext } from '../../src/services/ai/types.ts';
import type { AiMessageJobData, RetryJobStore } from '../../src/services/scheduled/types.ts';
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

/** Agent context factory: the runner only reads `user` (and writes retry fields) here. */
const userCtx = () => ({ user: fakeUser }) as unknown as AgentContext;

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

  test.each([
    ['cannot be saved', () => Promise.reject(new Error('READONLY You can not write against a read only replica'))],
    ['never answers', () => Promise.withResolvers<void>().promise],
  ])('a stored retry counts at once even when its cancellation pointer %s', async (_label, pointerWrite) => {
    const captured: { ctx?: AgentContext } = {};
    const agentCtx = { user: fakeUser } as unknown as AgentContext;
    const intentRun = mock(async (ctx: AgentContext) => {
      captured.ctx = ctx;
      return { handled: false };
    });
    const runner = new SyntheticPipelineRunner({
      contextBuilder: mock(() => agentCtx),
      intentRun,
      agentRun: mock(async () => {}),
      retryQueue: { addDelayed: mock(async () => 'job-1') },
      retryJobStore: {
        set: mock(pointerWrite),
        get: mock(async () => null),
        del: mock(async () => {}),
        delIfMatch: mock(async () => {}),
      },
    });
    await runner.run(fakeUser, { userId: fakeUser.telegram_id, message: 'check calendar', source: 'scheduled' });
    expect(await captured.ctx!.retryEnqueue!('check calendar')).toBe(true);
  });

  test('a spent budget still reports "gave up" and the job still succeeds when clearing the pointer fails', async () => {
    const answers: boolean[] = [];
    const sendMessage = mock(async (_userId: number, _text: string) => ({ message_id: 1 }));
    const agentCtx = { user: fakeUser, sender: { sendMessage } } as unknown as AgentContext;
    const runner = new SyntheticPipelineRunner({
      contextBuilder: mock(() => agentCtx),
      intentRun: mock(async () => ({ handled: false })),
      agentRun: async (ctx: AgentContext) => {
        answers.push((await ctx.retryEnqueue?.('что у меня завтра?')) ?? true);
      },
      retryQueue: { addDelayed: mock(async () => 'job-1') },
      retryJobStore: {
        set: mock(async () => {}),
        get: mock(async () => null),
        del: mock(async () => {}),
        delIfMatch: mock(async () => {
          throw new Error('READONLY You can not write against a read only replica');
        }),
      },
    });
    const run = runner.run(
      fakeUser,
      { userId: fakeUser.telegram_id, message: 'что у меня завтра?', source: 'trigger', retryAttempt: 3 },
      'job-3',
    );
    await expect(run).resolves.toBeUndefined();
    // The give-up line decision is made; a rejection here would make the agent add a contradicting notice.
    expect(answers).toEqual([false]);
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
    expect(await captured.ctx!.retryEnqueue!('check calendar')).toBe(true);

    const [, delay] = addDelayed.mock.calls[0] as unknown as [unknown, number];
    expect(delay).toBe(30_000);
    const [jobData] = addDelayed.mock.calls[0] as unknown as [{ retryAttempt: number }, number];
    expect(jobData.retryAttempt).toBe(1);
  });

  // A scheduled/trigger run (and its own retries) may end silently; a retry of the user's
  // own message, enqueued by the chat pipeline without `unprompted`, must answer (#508).
  test.each([
    ['a scheduled run', true, { retryAttempt: undefined, unprompted: undefined }],
    ["a retry of the user's message", false, { retryAttempt: 1, unprompted: undefined }],
    ['a retry of a scheduled run', true, { retryAttempt: 2, unprompted: true }],
  ])('%s runs the agent with unprompted=%p and its retry keeps that origin', async (_label, unprompted, job) => {
    const seen: (boolean | undefined)[] = [];
    const addDelayed = mock(async (_data: AiMessageJobData, _delay: number): Promise<string> => 'job-1');
    const runner = new SyntheticPipelineRunner({
      contextBuilder: () => ({ user: fakeUser }) as unknown as AgentContext,
      intentRun: async () => ({ handled: false }),
      agentRun: async (ctx: AgentContext) => {
        seen.push(ctx.unprompted);
        if (seen.length === 1) await ctx.retryEnqueue?.('check calendar');
      },
      retryQueue: { addDelayed },
    });
    await runner.run(fakeUser, { userId: fakeUser.telegram_id, message: 'check calendar', source: 'trigger', ...job });
    const retryJob = addDelayed.mock.calls[0]?.[0];
    if (!retryJob) throw new Error('the failed run did not enqueue a retry');
    await runner.run(fakeUser, retryJob);

    expect(seen).toEqual([unprompted, unprompted]);
  });
});

// ─── SyntheticPipelineRunner: finished retry job clears its own pointer (#126) ──

describe('SyntheticPipelineRunner retry pointer cleanup', () => {
  /** In-memory RetryJobStore honouring the interface contract (delIfMatch deletes only on an exact match). */
  function memoryJobStore() {
    const pointers = new Map<number, string>();
    const store: RetryJobStore = {
      async set(userId, jobId) {
        pointers.set(userId, jobId);
      },
      async get(userId) {
        return pointers.get(userId) ?? null;
      },
      async del(userId) {
        pointers.delete(userId);
      },
      async delIfMatch(userId, jobId) {
        if (pointers.get(userId) === jobId) pointers.delete(userId);
      },
    };
    return { store, pointers };
  }

  const retryJob: AiMessageJobData = {
    userId: fakeUser.telegram_id,
    message: 'what is on tomorrow?',
    source: 'trigger',
    retryAttempt: 1,
  };

  function runnerWith(store: RetryJobStore, agentRun: (ctx: AgentContext) => Promise<void>) {
    return new SyntheticPipelineRunner({
      contextBuilder: userCtx,
      intentRun: async () => ({ handled: false }),
      agentRun,
      retryQueue: { addDelayed: async () => 'job-2' },
      retryJobStore: store,
    });
  }

  test('a retry that answered without asking for another clears the pointer to itself', async () => {
    const { store, pointers } = memoryJobStore();
    pointers.set(fakeUser.telegram_id, 'job-1');
    await runnerWith(store, async () => {}).run(fakeUser, retryJob, 'job-1');
    expect(await store.get(fakeUser.telegram_id)).toBeNull();
  });

  test('a retry whose agent run failed outright still clears the pointer to itself', async () => {
    const { store, pointers } = memoryJobStore();
    pointers.set(fakeUser.telegram_id, 'job-1');
    await runnerWith(store, async () => {
      throw new Error('boom');
    }).run(fakeUser, retryJob, 'job-1');
    expect(await store.get(fakeUser.telegram_id)).toBeNull();
  });

  test("a newer retry's pointer survives the finished job's cleanup", async () => {
    const { store, pointers } = memoryJobStore();
    pointers.set(fakeUser.telegram_id, 'job-9');
    await runnerWith(store, async () => {}).run(fakeUser, retryJob, 'job-1');
    expect(await store.get(fakeUser.telegram_id)).toBe('job-9');
  });

  test('a retry that schedules the next attempt leaves the pointer on that attempt', async () => {
    const { store, pointers } = memoryJobStore();
    pointers.set(fakeUser.telegram_id, 'job-1');
    await runnerWith(store, async (ctx) => {
      await ctx.retryEnqueue?.('what is on tomorrow?');
    }).run(fakeUser, retryJob, 'job-1');
    expect(await store.get(fakeUser.telegram_id)).toBe('job-2');
  });

  test('an unawaited retryEnqueue still leaves the pointer on the next attempt', async () => {
    const { store, pointers } = memoryJobStore();
    pointers.set(fakeUser.telegram_id, 'job-1');
    const scheduled = Promise.withResolvers<boolean | undefined>();
    await runnerWith(store, async (ctx) => {
      // The agent fires the retry without awaiting it, so run() may finish first.
      void ctx.retryEnqueue?.('what is on tomorrow?').then(scheduled.resolve);
    }).run(fakeUser, retryJob, 'job-1');
    // retryEnqueue starts the pointer write before it resolves; the in-memory write is synchronous.
    await scheduled.promise;
    expect(await store.get(fakeUser.telegram_id)).toBe('job-2');
  });

  test("a last attempt that gives up keeps a newer retry's pointer", async () => {
    const { store, pointers } = memoryJobStore();
    pointers.set(fakeUser.telegram_id, 'job-9');
    const answers: (boolean | undefined)[] = [];
    await runnerWith(store, async (ctx) => {
      answers.push(await ctx.retryEnqueue?.('what is on tomorrow?'));
    }).run(fakeUser, { ...retryJob, retryAttempt: 3 }, 'job-3');
    expect(answers).toEqual([false]);
    expect(await store.get(fakeUser.telegram_id)).toBe('job-9');
  });

  test("a first run (not a retry) leaves another job's pointer alone", async () => {
    const { store, pointers } = memoryJobStore();
    pointers.set(fakeUser.telegram_id, 'job-0');
    await runnerWith(store, async () => {}).run(fakeUser, { ...retryJob, retryAttempt: undefined }, 'job-0');
    expect(await store.get(fakeUser.telegram_id)).toBe('job-0');
  });

  test('a Redis failure while clearing the pointer does not fail the job', async () => {
    const { store } = memoryJobStore();
    store.delIfMatch = async () => {
      throw new Error('READONLY You can not write against a read only replica');
    };
    await expect(runnerWith(store, async () => {}).run(fakeUser, retryJob, 'job-1')).resolves.toBeUndefined();
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

  test("processor hands the job's own id to the run, so a finished retry clears its pointer", async () => {
    const pointers = new Map<number, string>([[fakeUser.telegram_id, 'j-retry']]);
    const runner = new SyntheticPipelineRunner({
      contextBuilder: userCtx,
      intentRun: async () => ({ handled: true }),
      agentRun: async () => {},
      retryQueue: { addDelayed: async () => 'unused' },
      retryJobStore: {
        set: async () => {},
        get: async (userId) => pointers.get(userId) ?? null,
        del: async () => {},
        delIfMatch: async (userId, jobId) => {
          if (pointers.get(userId) === jobId) pointers.delete(userId);
        },
      },
    });

    createAiMessagesWorker({ host: 'localhost', port: 6379 }, runner, (id) =>
      id === fakeUser.telegram_id ? fakeUser : null,
    );

    await capturedProcessor({
      id: 'j-retry',
      data: { userId: fakeUser.telegram_id, message: 'remind me', source: 'trigger', retryAttempt: 1 },
    });
    expect(pointers.has(fakeUser.telegram_id)).toBe(false);
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

  test('exhausted retry budget closes the loop on the earlier promise', async () => {
    aiFailureNotices.reset();
    aiFailureNotices.decide(fakeUser.telegram_id, 'en', { hardOutage: false, willRetry: true, isRetryAttempt: false });

    const sendMessage = mock(async (_userId: number, _text: string) => ({ message_id: 1 }));
    const agentCtx = { user: fakeUser, sender: { sendMessage } } as unknown as AgentContext;
    const pointers = new Map<number, string>([[fakeUser.telegram_id, 'job-3']]);

    const runner = new SyntheticPipelineRunner({
      contextBuilder: mock(() => agentCtx),
      intentRun: mock(async () => ({ handled: false })),
      agentRun: async (ctx: AgentContext) => {
        await ctx.retryEnqueue?.('что у меня завтра?');
      },
      retryQueue: { addDelayed: mock(async () => 'job-1') },
      retryJobStore: {
        set: async (userId, jobId) => {
          pointers.set(userId, jobId);
        },
        get: async (userId) => pointers.get(userId) ?? null,
        del: async (userId) => {
          pointers.delete(userId);
        },
        delIfMatch: async (userId, jobId) => {
          if (pointers.get(userId) === jobId) pointers.delete(userId);
        },
      },
    });
    await runner.run(
      fakeUser,
      { userId: fakeUser.telegram_id, message: 'что у меня завтра?', source: 'trigger', retryAttempt: 3 },
      'job-3',
    );

    const [, text] = sendMessage.mock.calls[0] as unknown as [number, string];
    // fakeUser.language is English, so the English give-up must render.
    expect(text).toContain('Promised to come back');
    expect(text).toContain('/today');
    // The finished last attempt cleared the pointer to itself.
    expect(pointers.has(fakeUser.telegram_id)).toBe(false);
  });

  test('exhausted retry budget sends nothing when the outage was already admitted', async () => {
    aiFailureNotices.reset();
    aiFailureNotices.decide(fakeUser.telegram_id, 'en', { hardOutage: true, willRetry: true, isRetryAttempt: false });

    const sendMessage = mock(async (_userId: number, _text: string) => ({ message_id: 1 }));
    const captured: { ctx?: AgentContext } = {};
    const agentCtx = { user: fakeUser, sender: { sendMessage } } as unknown as AgentContext;

    const runner = new SyntheticPipelineRunner({
      contextBuilder: mock(() => agentCtx),
      intentRun: mock(async (ctx: AgentContext) => {
        captured.ctx = ctx;
        return { handled: false };
      }),
      agentRun: mock(async () => {}),
      retryQueue: { addDelayed: mock(async () => 'job-1') },
    });
    await runner.run(fakeUser, {
      userId: fakeUser.telegram_id,
      message: 'что у меня завтра?',
      source: 'trigger',
      retryAttempt: 3,
    });
    expect(await captured.ctx!.retryEnqueue!('что у меня завтра?')).toBe(false);

    expect(sendMessage).not.toHaveBeenCalled();
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
