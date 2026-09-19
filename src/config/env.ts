// src/config/env.ts

import { PROVIDER_IDS, type ProviderId } from '../services/ai/provider-ids.ts';
import { logger, logOnce } from '../utils/logger.ts';
import { type GroqTokenLimits, parseGroqTokenLimits } from './groq-token-limits.ts';

/** Main requests try responsive routes with their configured main model IDs.
 * Explicit operator order wins; token-fit guards, circuits and fallback stay intact.
 */
export const DEFAULT_SMART_CHAIN: ProviderId[] = ['groq', 'gemini', 'hf', 'zai'];
/** Short requests try responsive providers first. Explicit operator order still wins.
 * September 18 runtime probes: old order spent 15s on z.ai before a healthy provider;
 * Groq OSS20B and Gemini each completed independently in under 1s. Empty responses,
 * exhausted quotas and oversized Groq payloads retain the normal guarded fallback.
 */
export const DEFAULT_FAST_CHAIN: ProviderId[] = ['groq', 'gemini', 'hf', 'zai'];

/**
 * A chain order together with where it came from. The source is carried rather
 * than inferred, because the two cases warrant different noise: a provider the
 * operator named and did not configure deserves a warning, while one that is
 * merely absent from the default order is the documented minimal deployment.
 */
export interface ChainOrder {
  readonly order: ProviderId[];
  readonly fromEnv: boolean;
  /**
   * Where to fall back when nothing in `order` turns out to be configured. It
   * travels with the order so the pairing cannot be got wrong: passing the fast
   * chain with the smart chain's default would type-check otherwise.
   */
  readonly fallback: ProviderId[];
}

function parseChain(name: string, fallback: ProviderId[]): ChainOrder {
  const raw = process.env[name];
  if (!raw) return { order: fallback, fromEnv: false, fallback };
  const parsed: ProviderId[] = [];
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (!id) continue;
    const known = PROVIDER_IDS.find((candidate): candidate is ProviderId => candidate === id);
    if (!known) {
      logOnce(`${name}:unknown:${id}`, () =>
        logger.warn({ name, id, known: PROVIDER_IDS }, 'Unknown provider in chain order — ignoring it'),
      );
      continue;
    }
    if (!parsed.includes(known)) parsed.push(known);
  }
  if (parsed.length === 0) {
    logOnce(`${name}:empty:${raw}`, () =>
      logger.warn({ name, raw, fallback }, 'Chain order named no known provider — using the default order'),
    );
    return { order: fallback, fromEnv: false, fallback };
  }
  return { order: parsed, fromEnv: true, fallback };
}

export interface EnvConfig {
  BOT_TOKEN: string;
  DATABASE_PATH: string;
  NODE_ENV: 'development' | 'production';

  // AI primary provider (z.ai coding endpoint)
  ZAI_API_KEY: string;
  ZAI_BASE_URL: string;
  ZAI_MODEL: string;
  ZAI_FAST_MODEL: string;

  // HuggingFace Router (fallback, tool calling capable)
  HF_TOKEN: string;
  HF_BASE_URL: string;
  HF_MODEL: string;
  HF_FAST_MODEL: string;

  // Google Gemini (fallback, tool calling capable)
  GEMINI_API_KEY: string;
  GEMINI_BASE_URL: string;
  GEMINI_MODEL: string;
  GEMINI_FAST_MODEL: string;

  REDIS_URL: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  OAUTH_SERVER_PORT?: number;
  ENCRYPTION_KEY?: string;
  PUBLIC_DOMAIN?: string;
  BOT_USERNAME?: string;
  MTPROTO_API_ID?: number;
  MTPROTO_API_HASH?: string;
  MTPROTO_SERVICE_USER_ID?: number;
  GROQ_API_KEY?: string;
  GROQ_TPM_LIMITS?: GroqTokenLimits;
  GROQ_MODEL?: string;
  GROQ_FAST_MODEL?: string;

  /**
   * The order providers are tried in, first to last, for the chain that answers
   * users (SMART) and the one behind summarizing and validation (FAST). A
   * provider whose model or key is missing is skipped, so a name here is a
   * preference, not a requirement.
   */
  AI_TOOL_SCHEMA_MODE?: 'full' | 'lazy';
  AI_TOOL_SCHEMA_USER_IDS?: number[];
  AI_SMART_CHAIN: ChainOrder;
  AI_FAST_CHAIN: ChainOrder;
  BOT_ADMIN_ID?: number;
  INTENT_LEARNER_DAILY_LIMIT: number;
  INLINE_BOT_TOKEN?: string;
  INLINE_BOT_USERNAME?: string;
  SILERO_PYTHON_PATH?: string;
  DEEPGRAM_API_KEY?: string;
  DISABLE_VOICE?: boolean;
  AI_DEBUG_LOGS?: boolean;
  ADMIN_ALERT_TOKEN?: string;
  OPENWEATHER_API_KEY?: string;
  GOOGLE_API_KEY?: string;
  TELEGRAM_SESSION_MASTER_KEY?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}

export function loadConfig(): EnvConfig {
  const BOT_TOKEN = requireEnv('BOT_TOKEN');
  const toolSchemaMode = process.env.AI_TOOL_SCHEMA_MODE ?? 'full';
  if (toolSchemaMode !== 'full' && toolSchemaMode !== 'lazy')
    throw new Error('AI_TOOL_SCHEMA_MODE must be full or lazy');

  const rawToolUserIds = process.env.AI_TOOL_SCHEMA_USER_IDS;
  let toolSchemaUserIds: number[] | undefined;
  if (rawToolUserIds !== undefined) {
    const parts = rawToolUserIds.split(',');
    if (
      rawToolUserIds.length > 1800 ||
      parts.length > 100 ||
      parts.some((p) => !/^[1-9][0-9]*$/.test(p.trim()) || !Number.isSafeInteger(Number(p)))
    )
      throw new Error('AI_TOOL_SCHEMA_USER_IDS must be at most 100 positive safe integer IDs');
    toolSchemaUserIds = [...new Set(parts.map(Number))];
  }

  const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || undefined;
  const REDIS_URL = requireEnv('REDIS_URL');
  const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || undefined;
  const PUBLIC_DOMAIN = process.env.PUBLIC_DOMAIN || undefined;

  if (GOOGLE_CLIENT_ID) {
    if (!ENCRYPTION_KEY) {
      throw new Error('ENCRYPTION_KEY is required when GOOGLE_CLIENT_ID is set');
    }
    if (!/^[0-9a-f]{64}$/i.test(ENCRYPTION_KEY)) {
      throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes for AES-256-GCM)');
    }
  }

  const GOOGLE_REDIRECT_URI =
    process.env.GOOGLE_REDIRECT_URI || (PUBLIC_DOMAIN ? `https://${PUBLIC_DOMAIN}/oauth/google/callback` : undefined);

  const BOT_ADMIN_ID = process.env.BOT_ADMIN_ID
    ? (() => {
        const parsed = Number.parseInt(process.env.BOT_ADMIN_ID!, 10);
        if (Number.isNaN(parsed)) {
          throw new Error('BOT_ADMIN_ID must be a valid number');
        }
        return parsed;
      })()
    : undefined;

  const INTENT_LEARNER_DAILY_LIMIT = process.env.INTENT_LEARNER_DAILY_LIMIT
    ? (() => {
        const parsed = Number.parseInt(process.env.INTENT_LEARNER_DAILY_LIMIT!, 10);
        if (Number.isNaN(parsed)) {
          throw new Error('INTENT_LEARNER_DAILY_LIMIT must be a valid number');
        }
        return parsed;
      })()
    : 100;

  const rawMasterKey = process.env.TELEGRAM_SESSION_MASTER_KEY?.trim();
  let telegramSessionMasterKey: string | undefined;
  if (rawMasterKey) {
    if (/^[0-9a-f]{64}$/i.test(rawMasterKey)) {
      telegramSessionMasterKey = rawMasterKey;
    } else {
      logger.warn('TELEGRAM_SESSION_MASTER_KEY must be 64 hex chars (32 bytes) — connect-telegram feature disabled');
    }
  }

  return {
    BOT_TOKEN,
    DATABASE_PATH: process.env.DATABASE_PATH || './data/calendar.db',
    NODE_ENV: (process.env.NODE_ENV as EnvConfig['NODE_ENV']) || 'development',

    // AI primary (z.ai)
    ZAI_API_KEY: requireEnv('ZAI_API_KEY'),
    ZAI_BASE_URL: requireEnv('ZAI_BASE_URL'),
    ZAI_MODEL: requireEnv('ZAI_MODEL'),
    ZAI_FAST_MODEL: requireEnv('ZAI_FAST_MODEL'),

    // HuggingFace
    HF_TOKEN: requireEnv('HF_TOKEN'),
    HF_BASE_URL: requireEnv('HF_BASE_URL'),
    HF_MODEL: requireEnv('HF_MODEL'),
    HF_FAST_MODEL: requireEnv('HF_FAST_MODEL'),

    // Gemini
    GEMINI_API_KEY: requireEnv('GEMINI_API_KEY'),
    GEMINI_BASE_URL: requireEnv('GEMINI_BASE_URL'),
    GEMINI_MODEL: requireEnv('GEMINI_MODEL'),
    GEMINI_FAST_MODEL: requireEnv('GEMINI_FAST_MODEL'),

    REDIS_URL,
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || undefined,
    GOOGLE_REDIRECT_URI,
    OAUTH_SERVER_PORT: process.env.OAUTH_SERVER_PORT ? Number(process.env.OAUTH_SERVER_PORT) : undefined,
    ENCRYPTION_KEY,
    PUBLIC_DOMAIN,
    BOT_USERNAME: process.env.BOT_USERNAME || undefined,
    MTPROTO_API_ID: process.env.MTPROTO_API_ID ? Number(process.env.MTPROTO_API_ID) : undefined,
    MTPROTO_API_HASH: process.env.MTPROTO_API_HASH || undefined,
    MTPROTO_SERVICE_USER_ID: process.env.MTPROTO_SERVICE_USER_ID
      ? Number(process.env.MTPROTO_SERVICE_USER_ID)
      : undefined,
    GROQ_API_KEY: process.env.GROQ_API_KEY || undefined,
    GROQ_TPM_LIMITS: parseGroqTokenLimits(process.env.GROQ_TPM_LIMITS),
    GROQ_MODEL: process.env.GROQ_MODEL || undefined,
    GROQ_FAST_MODEL: process.env.GROQ_FAST_MODEL || undefined,
    AI_TOOL_SCHEMA_MODE: toolSchemaMode,
    AI_TOOL_SCHEMA_USER_IDS: toolSchemaUserIds,
    AI_SMART_CHAIN: parseChain('AI_SMART_CHAIN', DEFAULT_SMART_CHAIN),
    AI_FAST_CHAIN: parseChain('AI_FAST_CHAIN', DEFAULT_FAST_CHAIN),
    BOT_ADMIN_ID,
    INTENT_LEARNER_DAILY_LIMIT,
    INLINE_BOT_TOKEN: process.env.INLINE_BOT_TOKEN || undefined,
    INLINE_BOT_USERNAME: process.env.INLINE_BOT_USERNAME || undefined,
    SILERO_PYTHON_PATH: process.env.SILERO_PYTHON_PATH || undefined,
    DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY || undefined,
    DISABLE_VOICE: process.env.DISABLE_VOICE === 'true' || undefined,
    AI_DEBUG_LOGS: process.env.AI_DEBUG_LOGS === 'true' || undefined,
    ADMIN_ALERT_TOKEN: process.env.ADMIN_ALERT_TOKEN || undefined,
    OPENWEATHER_API_KEY: process.env.OPENWEATHER_API_KEY || undefined,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY || undefined,
    TELEGRAM_SESSION_MASTER_KEY: telegramSessionMasterKey,
  };
}
