// src/bootstrap/scheduled-ai.ts
//
// Startup phase: scheduled AI calls + the trigger system (BullMQ ai-messages queue/worker, the
// synthetic pipeline runner, the retry job store and the one-minute event-starting checker).
// Runs only with REDIS_URL.
//
// Ordering invariants:
//  - It runs AFTER createBot(): it needs the agent, the intent pipeline, the repositories and the
//    `msgDeps` object, and it patches `msgDeps` (scheduledCallService, triggerService, aiRetryQueue,
//    aiRetryJobStore) so the agent context builder picks the services up.
//  - `msgDeps` is frozen by src/index.ts AFTER this phase returns, outside the REDIS_URL guard, so
//    the lock also applies to development without Redis. Nothing here may write to it after returning.
//  - The trigger service subscribes to the bus before the queue worker exists, and the checker's
//    repeating tick is added before its worker is created, as before.
//  - Modules are imported lazily, in this order, only when REDIS_URL is set.

import type { Queue as BullQueue, Worker as BullWorker, ConnectionOptions } from 'bullmq';
import type { AgentContextBuilder } from '../bot/agent-context-factory.ts';
import type { MessageHandlerDeps } from '../bot/handlers/message.handler.ts';
import type { CalendarBotAgent } from '../services/ai/agent.ts';
import type { IntentExecutor } from '../services/intent/intent-executor.ts';
import type { IntentMatcher } from '../services/intent/intent-matcher.ts';
import { runSyntheticIntent } from '../services/intent/synthetic-intent-run.ts';
import type { DomainEventBus } from '../services/scheduled/domain-event-bus.ts';
import type { ScheduledAiCallRepository } from '../services/scheduled/scheduled-ai-call.repository.ts';
import type { TriggerRepository } from '../services/scheduled/trigger.repository.ts';
import { botLogger } from '../utils/logger.ts';
import type { EventStartingChecker } from '../worker/event-starting-checker.ts';
import { createRetryJobStore } from './redis-adapters.ts';
import type { StartupContext } from './runtime.ts';

/** The pieces of createBot()'s result this phase builds on. */
export interface ScheduledAiInputs {
  domainEventBus: DomainEventBus;
  agentContextBuilder: AgentContextBuilder;
  agent: Pick<CalendarBotAgent, 'run'>;
  intentMatcher: IntentMatcher;
  intentExecutor: IntentExecutor;
  scheduleRepo: ScheduledAiCallRepository;
  triggerRepo: TriggerRepository;
  msgDeps: MessageHandlerDeps;
}

const EVENT_STARTING_CHECKER_QUEUE = 'event-starting-checker';
const EVENT_STARTING_CHECKER_INTERVAL_MS = 60_000;

/** EventStartingChecker — runs on a 1-minute BullMQ cron. */
async function startEventStartingChecker(
  ctx: StartupContext,
  bus: DomainEventBus,
  connection: ConnectionOptions,
  bull: { Queue: typeof BullQueue; Worker: typeof BullWorker },
  CheckerClass: typeof EventStartingChecker,
): Promise<{ close: () => Promise<void> }> {
  const { db } = ctx;
  const checker = new CheckerClass(db.db, bus, (withinMs) => db.events.findStartingWithin(withinMs));

  const checkerQueue = new bull.Queue(EVENT_STARTING_CHECKER_QUEUE, { connection });
  await checkerQueue.add(
    'tick',
    {},
    {
      repeat: { every: EVENT_STARTING_CHECKER_INTERVAL_MS },
      jobId: 'event-starting-checker-tick',
      removeOnComplete: { count: 100 },
    },
  );
  const checkerWorker = new bull.Worker(
    EVENT_STARTING_CHECKER_QUEUE,
    async () => {
      await checker.check();
    },
    { connection },
  );
  checkerWorker.on('failed', ctx.onWorkerFailed('event-starting-checker'));

  return {
    close: async () => {
      await checkerWorker.close();
      await checkerQueue.close();
    },
  };
}

export async function initScheduledAi(ctx: StartupContext, inputs: ScheduledAiInputs): Promise<void> {
  const { config, db } = ctx;
  if (!config.REDIS_URL) return;

  const { TriggerService } = await import('../services/scheduled/trigger.service.ts');
  const { ScheduledAiCallService } = await import('../services/scheduled/scheduled-ai-call.service.ts');
  const { createAiMessagesQueue, createAiMessagesWorker, SyntheticPipelineRunner } = await import(
    '../worker/ai-messages-queue.ts'
  );
  const { EventStartingChecker: CheckerClass } = await import('../worker/event-starting-checker.ts');
  const { executeTool } = await import('../services/ai/tool-executor.ts');
  const { Queue, Worker } = await import('bullmq');

  const { domainEventBus, msgDeps, scheduleRepo, triggerRepo } = inputs;
  const redisConnection = { url: config.REDIS_URL };
  const aiMsgQueue = createAiMessagesQueue(redisConnection);

  // TriggerService — subscribes to all domain events
  const triggerService = new TriggerService(domainEventBus, triggerRepo, (data) => aiMsgQueue.pushTrigger(data));
  triggerService.subscribe();

  // ScheduledAiCallService — manages BullMQ delayed/repeat jobs
  const scheduledCallService = new ScheduledAiCallService(scheduleRepo, aiMsgQueue);

  // Patch msgDeps so agentContextBuilder picks up the services.
  msgDeps.scheduledCallService = scheduledCallService;
  msgDeps.triggerService = { repo: triggerRepo };
  msgDeps.aiRetryQueue = aiMsgQueue;

  // Redis store for pending retry job IDs — enables cancellation when user sends new message
  const retryJobStore = createRetryJobStore(new Bun.RedisClient(config.REDIS_URL));
  msgDeps.aiRetryJobStore = retryJobStore;

  // SyntheticPipelineRunner — runs IntentMatcher → AiAgent without GramIO context
  const syntheticRunner = new SyntheticPipelineRunner({
    contextBuilder: (user, chatId, message) => {
      const agentCtx = inputs.agentContextBuilder(user, chatId, message);
      if (agentCtx.scheduled) {
        agentCtx.scheduled.domainEvents = domainEventBus;
      }
      return agentCtx;
    },
    intentRun: (agentCtx, message) =>
      runSyntheticIntent(
        {
          matcher: inputs.intentMatcher,
          intentRepo: msgDeps.intentRepo,
          executor: inputs.intentExecutor,
          executeTool,
        },
        agentCtx,
        message,
      ),
    agentRun: async (agentCtx) => {
      await inputs.agent.run(agentCtx);
    },
    retryQueue: aiMsgQueue,
    retryJobStore,
  });

  const aiWorker = createAiMessagesWorker(
    redisConnection,
    syntheticRunner,
    (userId) => db.users.findByTelegramId(userId),
    (scheduleId) => scheduleRepo.recordRun(scheduleId),
  );
  aiWorker.on('failed', ctx.onWorkerFailed('ai-messages'));

  const checkerCleanup = await startEventStartingChecker(
    ctx,
    domainEventBus,
    redisConnection,
    { Queue, Worker },
    CheckerClass,
  );

  ctx.resources.aiMessagesQueue = {
    close: async () => {
      await aiWorker.close();
      await aiMsgQueue.queue.close();
    },
  };
  ctx.resources.eventCheckerQueue = checkerCleanup;

  botLogger.info('Scheduled AI calls + trigger system initialized');
}
