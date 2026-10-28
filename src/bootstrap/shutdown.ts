// src/bootstrap/shutdown.ts
//
// Graceful shutdown: the close order, the 8 s deadline and the SIGINT/SIGTERM handlers.
//
// Ordering invariants (each step depends on the previous ones; do not reorder):
//  1. Refuse webhook updates (`telegramUpdatesClosed`) BEFORE anything stops: Telegram keeps a refused
//     update and redelivers it to the next process instead of it dying in the stopped queue.
//  2. bot.stop() — in-flight handlers get up to 3 s — then drain the chat agent and the live-call
//     agent (AGENT_DRAIN_SETTLE_MS) so each running AI turn tells its user, queues its retry and
//     writes its debug log while the queues, Redis and the database are still open.
//  3. Close the queues in a fixed order: ai-messages, event checker, notifications, bot tasks, Google
//     sync, image render, broadcast, calls.
//  4. A second, shorter drain (LATE_AGENT_DRAIN_SETTLE_MS): turns started by handlers that outlived
//     bot.stop() while the queues closed. Nothing may still be writing when Redis and SQLite close.
//  5. Google Redis client, summarizer Redis, the web server.
//  6. LAST: configureAiUsageRecording(null) flushes what turns drained above still buffered, then the
//     database closes.
//  - bot.stop() + the first drain + the closes must fit the 8 s deadline and Docker's 10 s grace. When
//    the deadline passes, the process logs fatal and exits 1; on a clean close it exits 0.

import { AGENT_DRAIN_SETTLE_MS } from '../services/ai/agent.ts';
import { configureAiUsageRecording } from '../services/ai/usage-recorder.ts';
import { botLogger } from '../utils/logger.ts';
import type { ShutdownResources, StartupContext } from './runtime.ts';

/** Second, shorter drain; see the module header. */
export const LATE_AGENT_DRAIN_SETTLE_MS = 1_000;
export const SHUTDOWN_TIMEOUT_MS = 8_000;

export interface ShutdownDeps {
  bot: { stop(): Promise<unknown> };
  agent: { drain(settleMs: number): Promise<void> };
  resources: ShutdownResources;
  summarizerRedis: { close(): void };
  webServerHandle: { stop(): void } | undefined;
  webServerDeps: { telegramUpdatesClosed?: boolean };
  database: { close(): void };
  /** Flushes buffered AI-usage rows; injected so tests can observe the order. */
  flushAiUsageRecording: () => void;
  timeoutMs: number;
  logger: { fatal(obj: object, message: string): void };
  exit: (code: number) => void;
}

/** The queue handles in the order shutdown closes them. */
function closableQueues(resources: ShutdownResources) {
  return [
    resources.aiMessagesQueue,
    resources.eventCheckerQueue,
    resources.notificationQueue,
    resources.botTasksQueue,
    resources.syncQueue,
    resources.imageQueue,
    resources.broadcastQueue,
    resources.callQueue,
  ];
}

export function createShutdown(deps: ShutdownDeps): () => Promise<void> {
  const { resources } = deps;
  const drainAgents = async (settleMs: number): Promise<void> => {
    await Promise.all([deps.agent.drain(settleMs), resources.voiceAgent?.drain(settleMs)]);
  };

  return async () => {
    await deps.bot.stop();
    await drainAgents(AGENT_DRAIN_SETTLE_MS);
    for (const queue of closableQueues(resources)) {
      if (queue) await queue.close();
    }
    await drainAgents(LATE_AGENT_DRAIN_SETTLE_MS);
    resources.googleRedisClient?.close();
    deps.summarizerRedis.close();
    deps.webServerHandle?.stop();
    deps.flushAiUsageRecording();
    deps.database.close();
  };
}

export function createShutdownWithTimeout(deps: ShutdownDeps): () => Promise<void> {
  const shutdown = createShutdown(deps);
  return async () => {
    deps.webServerDeps.telegramUpdatesClosed = true;
    const deadline = Promise.withResolvers<void>();
    const timer = setTimeout(
      () => deadline.reject(new Error(`Shutdown timeout after ${deps.timeoutMs / 1000}s`)),
      deps.timeoutMs,
    );
    await Promise.race([shutdown(), deadline.promise])
      .catch((err: unknown) => {
        deps.logger.fatal({ err }, 'Shutdown timed out, forcing exit');
        deps.exit(1);
      })
      .finally(() => clearTimeout(timer));
  };
}

/** Wires the real process: real logger, real exit, the 8 s deadline. */
export function createProcessShutdown(
  ctx: StartupContext,
  parts: Pick<ShutdownDeps, 'bot' | 'agent' | 'webServerHandle'>,
): () => Promise<void> {
  return createShutdownWithTimeout({
    ...parts,
    resources: ctx.resources,
    summarizerRedis: ctx.summarizerRedis,
    webServerDeps: ctx.webServerDeps,
    database: ctx.db,
    flushAiUsageRecording: () => configureAiUsageRecording(null),
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    logger: botLogger,
    exit: (code) => process.exit(code),
  });
}

const SIGNAL_MESSAGES = [
  ['SIGINT', 'Shutting down...'],
  ['SIGTERM', 'Shutting down (SIGTERM)...'],
] as const;

export function installShutdownSignals(shutdownWithTimeout: () => Promise<void>): void {
  for (const [signal, message] of SIGNAL_MESSAGES) {
    process.on(signal, async () => {
      botLogger.info(message);
      await shutdownWithTimeout();
      process.exit(0);
    });
  }
}
