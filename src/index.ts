// src/index.ts
//
// The executable entry point: a short orchestration script. Each startup phase lives in
// src/bootstrap/ with its own ordering notes; this file fixes the ORDER of the phases.
//
// Ordering invariants (a phase may only use what earlier phases produced):
//  1. Crash handlers are installed before anything can throw, including loadConfig().
//  2. Core: config -> database -> alert sink -> master-key check -> provider alerts/circuit/usage.
//     A missing required env variable throws here, which the crash handlers turn into exit 1.
//  3. The startup context, then the web server — listening early so /health answers while the
//     slower phases below run. Its Google fields are filled in by the Google phase.
//  4. The MTProto service tier is decided once, fail-closed (#753); everything below that needs it
//     receives `serviceTier`.
//  5. Infrastructure that createBot() takes as input: Google sync, image rendering, the broadcast
//     queue, voice calls, weather, notifications, bot-tasks crons, speech services, the event-mention
//     store, the domain event bus and location verification — in that order.
//  6. createBot(), then immediately the late-bound pieces that need the bot: the bot handle, botRef
//     and the broadcast worker (which sends from its first job on).
//  7. Scheduled AI patches `msgDeps`; msgDeps is frozen right after, outside the REDIS_URL guard.
//  8. Command menu hook, shutdown signal handlers, and last, launching the bot.

import { buildBotCommands, createOnStartHandler } from './bootstrap/bot-commands.ts';
import { createBotHandle, patchBotRef, type TelegramSendApi } from './bootstrap/bot-ref.ts';
import { initBotTasks } from './bootstrap/bot-tasks.ts';
import { createBroadcastInfra } from './bootstrap/broadcast.ts';
import { createStartupContext } from './bootstrap/context.ts';
import { initCore } from './bootstrap/core.ts';
import { installCrashHandlers } from './bootstrap/crash-handlers.ts';
import { createDomainEventBus } from './bootstrap/domain-events.ts';
import { initEventMentionStore } from './bootstrap/event-mentions.ts';
import { initGoogleSync } from './bootstrap/google-sync.ts';
import { initImageRender } from './bootstrap/image-render.ts';
import { launchBot } from './bootstrap/launch.ts';
import { initLocationVerification } from './bootstrap/location.ts';
import { initNotificationScheduler } from './bootstrap/notifications.ts';
import { initScheduledAi } from './bootstrap/scheduled-ai.ts';
import { createProcessShutdown, installShutdownSignals } from './bootstrap/shutdown.ts';
import { initSpeechServices } from './bootstrap/speech.ts';
import { initVoiceCalls } from './bootstrap/voice-calls.ts';
import { initWeatherService } from './bootstrap/weather.ts';
import { createBot } from './bot/index.ts';
import { createServiceTier } from './services/telegram-session/service-tier.ts';
import { botLogger } from './utils/logger.ts';
import { startWebServer } from './web/server.ts';

const crashHandlers = installCrashHandlers();

const core = await initCore(crashHandlers);
const { config } = core;
const ctx = createStartupContext(core);
const webServerHandle = startWebServer(ctx.webServerDeps);

// The shared MTProto service account: decided once here, fail-closed (#753). Everything that uses
// it receives `serviceTier`; nothing else reads MTPROTO_SERVICE_USER_ID or spawns a service script.
const serviceTier = await createServiceTier(config, { dataDirectory: 'data' });
if (serviceTier.enabled) {
  botLogger.info({ accountId: serviceTier.accountId }, 'MTProto service tier enabled');
} else {
  botLogger.info({ reason: serviceTier.reason }, 'MTProto service tier disabled');
}

// Closures wired before createBot() reach the bot through this handle, set right after it.
const botHandle = createBotHandle<{ api: TelegramSendApi }>();

const googleSync = await initGoogleSync(ctx, botHandle);
const renderService = await initImageRender(ctx);

// Broadcast queue — enqueuer created early so createBot() can wire it into tool handlers.
// The worker starts later, after botRef is patched.
const broadcast = await createBroadcastInfra(config);

const callQueue = await initVoiceCalls(ctx, serviceTier);
const weatherService = await initWeatherService(config);
await initNotificationScheduler(ctx, { callQueue, weatherService });
await initBotTasks(ctx, { googleSyncQueue: googleSync?.syncQueue, serviceTier });
await initSpeechServices(ctx);
const eventMentionStore = await initEventMentionStore(ctx);
const domainEventBus = createDomainEventBus(ctx, {
  participantPushScheduler: googleSync?.participantPushScheduler,
  weatherService,
});
const location = await initLocationVerification(ctx, {
  weatherService,
  pushEventCopies: googleSync?.pushEventCopies,
});

const { speech } = ctx;
const { bot, agentContextBuilder, agent, intentMatcher, intentExecutor, scheduleRepo, triggerRepo, msgDeps } =
  createBot(
    config.BOT_TOKEN,
    ctx.db,
    {
      debugLogger: ctx.aiDebugLogger,
      summarizer: ctx.historySummarizer,
      toolSchemaMode: config.AI_TOOL_SCHEMA_MODE,
    },
    {
      googleDeps: googleSync?.googleDeps,
      renderService,
      callQueue,
      transcriptionService: speech.transcriptionService,
      serviceTier,
      stressDictionary: speech.stressDictionary,
      sileroTts: speech.sileroTts,
      kokoroTts: speech.kokoroTts,
      fallbackTts: speech.fallbackTts,
      eventMentionStore,
      domainEventBus,
      nliClassifier: speech.nliClassifier,
      locationVerification: location.locationVerification,
      addressCache: location.addressCache,
      pendingGeoStore: location.pendingGeoStore,
      envConfig: {
        BOT_ADMIN_ID: config.BOT_ADMIN_ID,
        INTENT_LEARNER_DAILY_LIMIT: config.INTENT_LEARNER_DAILY_LIMIT,
        BOT_USERNAME: config.BOT_USERNAME,
        INLINE_BOT_TOKEN: config.INLINE_BOT_TOKEN,
        TELEGRAM_SESSION_MASTER_KEY: config.TELEGRAM_SESSION_MASTER_KEY,
      },
      weatherService,
      broadcastEnqueuer: broadcast.enqueuer,
      changeNotifier: googleSync?.changeNotifier,
    },
  );

botHandle.set(bot);
patchBotRef(ctx.botRef, bot.api);
// Created after botRef is patched so every send is the real implementation.
broadcast.startWorker(ctx, bot.api);

await initScheduledAi(ctx, {
  domainEventBus,
  agentContextBuilder,
  agent,
  intentMatcher,
  intentExecutor,
  scheduleRepo,
  triggerRepo,
  msgDeps,
});

// Freeze msgDeps after all potential mutation sites (onboardingScene in createBot,
// scheduledCallService/triggerService in the REDIS_URL phase above). All downstream
// consumers — AI agent context builder, pipeline layers, callback agent continuations —
// capture msgDeps by reference, so locking it here prevents accidental late writes
// from silently reshaping what those closures see.
Object.freeze(msgDeps);

bot.onStart(createOnStartHandler(buildBotCommands(config), bot.api, ctx.webServerDeps));

installShutdownSignals(createProcessShutdown(ctx, { bot, agent, webServerHandle }));

await launchBot(config, ctx.webServerDeps, bot);
