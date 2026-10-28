// src/bootstrap/voice-calls.ts
//
// Startup phase: the outbound voice-call pipeline (Python bridge + BullMQ queue/worker + live-call
// WebSocket server).
//
// Ordering invariants:
//  - Runs only with REDIS_URL, an enabled MTProto service tier and voice not disabled. Anything that
//    throws is logged and swallowed: voice calls fail closed (the returned queue is undefined, so
//    make_call stays hidden) and startup continues.
//  - The live-call agent is registered with shutdown (`resources.voiceAgent`) as soon as it exists,
//    before the later steps that can still throw, so a half-built pipeline is still drained.
//  - The TTS adapter captures `ctx.speech`, not the services: Silero/Kokoro/fallback are created by
//    initSpeechServices() AFTER this phase and are read when a call actually speaks.
//  - Telegram messages go through `ctx.botRef`, which is patched after createBot().
//  - The queue modules are imported lazily, in this order, only when the feature is enabled.

import type { CalendarBotAgent } from '../services/ai/agent.ts';
import type { ConversationLogger } from '../services/conversation-logger.ts';
import type { EventService } from '../services/event/event-service.ts';
import type { HolidayService } from '../services/holiday/holiday-service.ts';
import type { ReminderMaterializer } from '../services/notification/materializer.ts';
import type { ServiceTier } from '../services/telegram-session/service-tier.ts';
import type { CallManager } from '../services/voice/call-manager.ts';
import type { CallSession, createCallAgent } from '../services/voice/call-session.ts';
import type { CallSessionManager } from '../services/voice/call-session-manager.ts';
import type { FluxStreamingSTT } from '../services/voice/flux-streaming-stt.ts';
import type { NovaStreamingSTT } from '../services/voice/nova-streaming-stt.ts';
import type { ThinkingPhrasePlayer } from '../services/voice/thinking-phrase-player.ts';
import { createVoiceSender } from '../services/voice/voice-sender.ts';
import { botLogger } from '../utils/logger.ts';
import type { CallRequest, createCallQueue, createCallWorker } from '../worker/call-queue.ts';
import type { SpeechServices, StartupContext } from './runtime.ts';

export interface CallQueueHandle {
  enqueue(data: CallRequest): Promise<void>;
}

/** Text normalisation applied before Silero synthesis (loaded lazily with the voice modules). */
export interface StressTextTools {
  markStress: (text: string, dictionary: NonNullable<SpeechServices['stressDictionary']>) => string;
  numbersToWords: (text: string) => string;
}

export interface VoiceCallTts {
  synthesize(text: string, lang: string): Promise<Buffer>;
}

interface TtsEngine {
  synthesize(clean: string): Promise<Buffer>;
  failureMessage: string;
}

function selectTtsEngine(speech: SpeechServices, tools: StressTextTools, lang: string): TtsEngine | undefined {
  const { sileroTts, stressDictionary, kokoroTts } = speech;
  if (lang === 'ru' && sileroTts && stressDictionary) {
    return {
      failureMessage: 'Silero TTS failed, falling back to Google',
      synthesize: (clean) => {
        const stressedText = tools.markStress(tools.numbersToWords(clean), stressDictionary);
        botLogger.info({ engine: 'silero', lang }, 'Voice call TTS');
        return sileroTts.synthesize(stressedText);
      },
    };
  }
  if (lang === 'en' && kokoroTts) {
    return {
      failureMessage: 'Kokoro TTS failed, falling back to Google',
      synthesize: async (clean) => {
        botLogger.info({ engine: 'kokoro', lang }, 'Voice call TTS');
        return kokoroTts.synthesize(clean);
      },
    };
  }
  return undefined;
}

/**
 * Language-aware TTS adapter: Silero (RU) → Kokoro (EN) → Google fallback. `speech` is read on every
 * call, so services created after this adapter are picked up.
 */
export function createVoiceCallTts(speech: SpeechServices, tools: StressTextTools): VoiceCallTts {
  return {
    synthesize: async (text: string, lang: string): Promise<Buffer> => {
      const clean = text.replace(/\n/g, ' ');
      const engine = selectTtsEngine(speech, tools, lang);
      if (engine) {
        try {
          return await engine.synthesize(clean);
        } catch (err) {
          botLogger.warn({ err }, engine.failureMessage);
        }
      } else {
        botLogger.info({ engine: 'google', lang }, 'Voice call TTS');
      }
      if (!speech.fallbackTts) throw new Error('Fallback TTS is not initialised');
      return speech.fallbackTts.synthesize(clean, lang);
    },
  };
}

/** The lazily imported voice modules, loaded together so a failure aborts the whole pipeline. */
interface VoiceModules {
  createCallQueue: typeof createCallQueue;
  createCallWorker: typeof createCallWorker;
  CallManager: typeof CallManager;
  CallSessionManager: typeof CallSessionManager;
  CallSession: typeof CallSession;
  createCallAgent: typeof createCallAgent;
  ConversationLogger: typeof ConversationLogger;
  NovaStreamingSTT: typeof NovaStreamingSTT;
  FluxStreamingSTT: typeof FluxStreamingSTT;
  ThinkingPhrasePlayer: typeof ThinkingPhrasePlayer;
  CalendarBotAgent: typeof CalendarBotAgent;
  EventService: typeof EventService;
  ReminderMaterializer: typeof ReminderMaterializer;
  HolidayService: typeof HolidayService;
}

async function loadVoiceModules(): Promise<VoiceModules> {
  const { createCallQueue, createCallWorker } = await import('../worker/call-queue.ts');
  const { CallManager } = await import('../services/voice/call-manager.ts');
  const { CallSessionManager } = await import('../services/voice/call-session-manager.ts');
  const { CallSession, createCallAgent } = await import('../services/voice/call-session.ts');
  const { ConversationLogger } = await import('../services/conversation-logger.ts');
  const { NovaStreamingSTT } = await import('../services/voice/nova-streaming-stt.ts');
  const { FluxStreamingSTT } = await import('../services/voice/flux-streaming-stt.ts');
  const { ThinkingPhrasePlayer } = await import('../services/voice/thinking-phrase-player.ts');
  const { CalendarBotAgent } = await import('../services/ai/agent.ts');
  const { EventService } = await import('../services/event/event-service.ts');
  const { ReminderMaterializer } = await import('../services/notification/materializer.ts');
  const { HolidayService } = await import('../services/holiday/holiday-service.ts');
  return {
    createCallQueue,
    createCallWorker,
    CallManager,
    CallSessionManager,
    CallSession,
    createCallAgent,
    ConversationLogger,
    NovaStreamingSTT,
    FluxStreamingSTT,
    ThinkingPhrasePlayer,
    CalendarBotAgent,
    EventService,
    ReminderMaterializer,
    HolidayService,
  };
}

/** Live-call session registry; every session talks through the live-call agent and the shared TTS. */
function createCallSessionManager(
  ctx: StartupContext,
  mods: VoiceModules,
  deepgramApiKey: string,
  tts: VoiceCallTts,
): CallSessionManager {
  const { db, botRef, aiDebugLogger, historySummarizer } = ctx;
  // TelegramSender for voice calls — forwards to botRef, which wraps bot.api once the bot exists.
  const voiceSender = createVoiceSender(botRef);
  const voiceAgent = new mods.CalendarBotAgent(
    { debugLogger: aiDebugLogger, summarizer: historySummarizer },
    voiceSender,
  );
  ctx.resources.voiceAgent = voiceAgent;

  const voiceCallAgent = mods.createCallAgent(voiceAgent, {
    sender: voiceSender,
    eventService: new mods.EventService({
      eventRepo: db.events,
      materializer: new mods.ReminderMaterializer(db.eventReminders, db.notificationPreferences),
    }),
    chatHistory: db.chatHistory,
    conversationLogger: new mods.ConversationLogger(db.chatHistory),
    userRepo: db.users,
    eventReminderRepo: db.eventReminders,
    holidayService: new mods.HolidayService(db.holidays),
  });

  return new mods.CallSessionManager({
    createSession: (sessionId, userId, language, ws, openerText) =>
      mods.CallSession.create({
        sessionId,
        userId,
        language,
        ws,
        createNovaStt: () => new mods.NovaStreamingSTT(deepgramApiKey),
        createFluxStt: () => new mods.FluxStreamingSTT(deepgramApiKey),
        createThinkingPlayer: () => new mods.ThinkingPhrasePlayer(language),
        agent: voiceCallAgent,
        tts,
        openerText,
      }),
  });
}

async function buildVoicePipeline(
  ctx: StartupContext,
  mods: VoiceModules,
  voiceBridgeScript: string,
): Promise<CallQueueHandle> {
  const { config, db, botRef } = ctx;
  const { TtsTranslationService } = await import('../services/voice/tts-translation.ts');
  const ttsTranslationService = new TtsTranslationService();

  const deepgramApiKey = config.DEEPGRAM_API_KEY ?? '';
  if (!deepgramApiKey) {
    botLogger.warn('DEEPGRAM_API_KEY is not set — STT will not work');
  }

  const stressTools = await import('../services/voice/stress-marker.ts');
  const callSessionManager = createCallSessionManager(
    ctx,
    mods,
    deepgramApiKey,
    createVoiceCallTts(ctx.speech, stressTools),
  );
  callSessionManager.startServer();

  const callManager = new mods.CallManager({
    callLogRepo: db.callLog,
    translateText: (text, lang) => ttsTranslationService.translate(text, lang),
    pyBridgePath: voiceBridgeScript,
    registerSession: (sessionId, userId, language, openerText) =>
      callSessionManager.registerSession(sessionId, userId, language, openerText),
    unregisterSession: (sessionId) => callSessionManager.unregisterSession(sessionId),
    notifyUser: (userId, msg) => {
      botRef
        .sendMessage(userId, msg)
        .catch((err) => botLogger.error({ err, userId }, 'Failed to send call failure notification'));
    },
  });

  const cq = mods.createCallQueue({ url: config.REDIS_URL }, db.callLog);
  const worker = mods.createCallWorker({ url: config.REDIS_URL }, callManager);
  worker.on('failed', ctx.onWorkerFailed('call-reminders'));
  ctx.resources.callQueue = {
    close: async () => {
      await worker.close();
      await cq.queue.close();
    },
  };
  return cq;
}

/** Returns the call queue, or undefined when voice calls are disabled or failed to initialise. */
export async function initVoiceCalls(
  ctx: StartupContext,
  serviceTier: ServiceTier,
): Promise<CallQueueHandle | undefined> {
  const { config } = ctx;
  if (!(config.REDIS_URL && serviceTier.enabled && !config.DISABLE_VOICE)) return undefined;

  try {
    const mods = await loadVoiceModules();
    const queue = await buildVoicePipeline(ctx, mods, serviceTier.voiceBridgeScript);
    botLogger.info('Voice call pipeline initialized (Python bridge + BullMQ)');
    return queue;
  } catch (error) {
    // Fail closed: without a working pipeline no call can be placed, so make_call stays hidden
    // instead of queueing calls nobody will ever make.
    botLogger.warn({ err: error }, 'Voice call init failed; voice calls disabled');
    return undefined;
  }
}
