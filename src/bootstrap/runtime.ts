// src/bootstrap/runtime.ts
//
// The state shared by the startup phases. src/index.ts creates one StartupContext after the
// database is open and hands it to each phase in a fixed order; a phase reads what earlier phases
// produced and registers what shutdown has to close.
//
// Ordering invariants:
//  - `resources` is only ever filled in by a phase and read by shutdown.ts, which closes them in a
//    fixed order that is documented there; filling order has no effect on shutdown order.
//  - `speech` is created empty and populated by initSpeechServices() late in startup. The voice-call
//    TTS closure reads it at call time, exactly like the module-level `let`s it replaces.
//  - `webServerDeps` is created before the web server starts and is mutated afterwards (Google
//    wiring, health check, webhook handler, `botStarted`). The running server reads it live.

import type { EnvConfig } from '../config/env.ts';
import type { DatabaseService } from '../database/index.ts';
import type { AiDebugLogger } from '../services/ai/debug-logger.ts';
import type { HistorySummarizer } from '../services/ai/history-summarizer.ts';
import type { NliClassifier } from '../services/nli/nli-classifier.ts';
import type { KokoroTtsService } from '../services/voice/kokoro-tts-service.ts';
import type { SileroTtsService } from '../services/voice/silero-tts-service.ts';
import type { StressDictionary } from '../services/voice/stress-dictionary.ts';
import type { TranscriptionService } from '../services/voice/transcription-service.ts';
import type { TtsService } from '../services/voice/tts-service.ts';
import type { WebServerDeps } from '../web/server.ts';
import type { BotRef } from './bot-ref.ts';
import type { WorkerFailedFactory } from './worker-failure.ts';

export interface ClosableResource {
  close(): Promise<void>;
}

/** Everything shutdown has to release that a phase created. Each field is set only if its phase ran. */
export interface ShutdownResources {
  aiMessagesQueue?: ClosableResource;
  eventCheckerQueue?: ClosableResource;
  notificationQueue?: ClosableResource;
  botTasksQueue?: ClosableResource;
  syncQueue?: ClosableResource;
  imageQueue?: ClosableResource;
  broadcastQueue?: ClosableResource;
  callQueue?: ClosableResource;
  /** The live-call agent, drained on shutdown like the chat agent. */
  voiceAgent?: { drain: (settleMs: number) => Promise<void> };
  googleRedisClient?: { close(): void };
}

/** Speech/NLU services, filled in by initSpeechServices() and read lazily by the voice-call TTS. */
export interface SpeechServices {
  transcriptionService?: TranscriptionService;
  stressDictionary?: StressDictionary;
  fallbackTts?: TtsService;
  kokoroTts?: KokoroTtsService;
  nliClassifier?: NliClassifier;
  sileroTts?: SileroTtsService;
}

export interface StartupContext {
  config: EnvConfig;
  db: DatabaseService;
  botRef: BotRef;
  webServerDeps: WebServerDeps;
  onWorkerFailed: WorkerFailedFactory;
  aiDebugLogger: AiDebugLogger;
  historySummarizer: HistorySummarizer;
  /** Closed by shutdown; owned here because the summarizer outlives every phase. */
  summarizerRedis: { close(): void };
  resources: ShutdownResources;
  speech: SpeechServices;
}
