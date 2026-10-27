// src/bootstrap/speech.ts
//
// Startup phase: speech and NLU services (Groq Whisper transcription, the stress dictionary, the
// Google fallback TTS, Kokoro, the NLI classifier and Silero TTS).
//
// Ordering invariants:
//  - It runs AFTER the voice-call phase and BEFORE createBot(). The voice-call TTS adapter reads
//    `ctx.speech` at call time, so it sees these services even though they are created later.
//  - The stress dictionary loads before Silero: Silero is only created when a dictionary exists,
//    because Russian text is stress-marked with it before synthesis.
//  - Every service is optional and keyed on its own env variable; a missing dictionary is logged
//    and never stops startup.
//  - Modules are imported lazily (runtime-selected by configuration, same as before the split) so a
//    deployment without the feature never loads its model code.

import type { EnvConfig } from '../config/env.ts';
import type { StressDictionary } from '../services/voice/stress-dictionary.ts';
import { botLogger } from '../utils/logger.ts';
import type { StartupContext } from './runtime.ts';

const STRESS_DICTIONARY_PATH = 'data/dictionaries/stress-dict.json';

async function loadStressDictionary(): Promise<StressDictionary | undefined> {
  try {
    const { StressDictionary: StressDictionaryClass } = await import('../services/voice/stress-dictionary.ts');
    return await StressDictionaryClass.loadFromFile(STRESS_DICTIONARY_PATH);
  } catch (error) {
    botLogger.warn({ err: error }, 'Stress dictionary not loaded');
    return undefined;
  }
}

async function createTranscriptionService(config: Pick<EnvConfig, 'GROQ_API_KEY'>) {
  if (!config.GROQ_API_KEY) return undefined;
  const { TranscriptionService } = await import('../services/voice/transcription-service.ts');
  const service = new TranscriptionService(config.GROQ_API_KEY);
  botLogger.info('Voice transcription initialized (Whisper via Groq)');
  return service;
}

async function createFallbackTts() {
  const { TtsService } = await import('../services/voice/tts-service.ts');
  return new TtsService();
}

async function createKokoroTts(config: Pick<EnvConfig, 'HF_TOKEN'>) {
  if (!config.HF_TOKEN) return undefined;
  const { KokoroTtsService } = await import('../services/voice/kokoro-tts-service.ts');
  const service = new KokoroTtsService(config.HF_TOKEN);
  botLogger.info('Kokoro TTS initialized');
  return service;
}

async function createNliClassifier(config: Pick<EnvConfig, 'HF_TOKEN'>) {
  if (!config.HF_TOKEN) return undefined;
  const { NliClassifier } = await import('../services/nli/nli-classifier.ts');
  const classifier = new NliClassifier(config.HF_TOKEN);
  botLogger.info('NLI classifier initialized (group message semantic filter)');
  return classifier;
}

async function createSileroTts(config: Pick<EnvConfig, 'SILERO_PYTHON_PATH'>, stressDictionary?: StressDictionary) {
  if (!(config.SILERO_PYTHON_PATH && stressDictionary)) return undefined;
  const { SileroTtsService } = await import('../services/voice/silero-tts-service.ts');
  const service = new SileroTtsService(config.SILERO_PYTHON_PATH);
  botLogger.info('Silero TTS initialized');
  return service;
}

/** Fills `ctx.speech` in place: the voice-call TTS already holds that object. */
export async function initSpeechServices(ctx: StartupContext): Promise<void> {
  const { config, speech } = ctx;

  speech.transcriptionService = await createTranscriptionService(config);
  speech.stressDictionary = await loadStressDictionary();
  speech.fallbackTts = await createFallbackTts();
  speech.kokoroTts = await createKokoroTts(config);
  speech.nliClassifier = await createNliClassifier(config);
  speech.sileroTts = await createSileroTts(config, speech.stressDictionary);
}
