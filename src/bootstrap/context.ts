// src/bootstrap/context.ts
//
// Builds the StartupContext shared by every startup phase, right after the core phase.
//
// Ordering invariants:
//  - It runs once config and the database exist and before any phase that creates a queue/worker
//    (they need `onWorkerFailed`) or sends a message (they need `botRef`).
//  - It opens the summarizer Redis connection (always, as before) and builds the web-server deps.
//    The web server itself is started by src/index.ts right after this returns, so it is already
//    listening when the Google phase fills in its Google fields.
//  - `botRef` starts with inert placeholders; src/index.ts patches it right after createBot().

import { AiDebugLogger } from '../services/ai/debug-logger.ts';
import { HistorySummarizer } from '../services/ai/history-summarizer.ts';
import { aiStreamRound } from '../services/ai/streaming.ts';
import { hasChainAnswered, isAiChainDown } from '../utils/ai-provider-alert.ts';
import type { WebServerDeps } from '../web/server.ts';
import { createBotRef } from './bot-ref.ts';
import type { CoreServices } from './core.ts';
import { createSummarizerRedis } from './redis-adapters.ts';
import type { StartupContext } from './runtime.ts';
import { createWorkerFailedFactory } from './worker-failure.ts';

/** Mutable deps — Google fields are filled in once GOOGLE_CLIENT_ID is confirmed. */
export function createWebServerDeps({ config, db }: CoreServices): WebServerDeps {
  return {
    config,
    userRepo: db.users,
    botStarted: false,
    alertRepo: db.alerts,
    adminAlertToken: config.ADMIN_ALERT_TOKEN,
    // The cron watchdog polls /ready every two minutes, and this is what lets it
    // see a total provider outage. Process liveness alone never showed one.
    aiChainDown: isAiChainDown,
    aiChainVerified: hasChainAnswered,
  };
}

export function createStartupContext(core: CoreServices): StartupContext {
  const { config, db } = core;
  const summarizerRedis = new Bun.RedisClient(config.REDIS_URL);
  return {
    config,
    db,
    botRef: createBotRef(),
    webServerDeps: createWebServerDeps(core),
    onWorkerFailed: createWorkerFailedFactory({
      config,
      pushAlert: (msg, src) => db.alerts.push(msg, src),
    }),
    aiDebugLogger: new AiDebugLogger(!!config.AI_DEBUG_LOGS, 'logs'),
    historySummarizer: new HistorySummarizer(createSummarizerRedis(summarizerRedis), aiStreamRound),
    summarizerRedis,
    resources: {},
    speech: {},
  };
}
