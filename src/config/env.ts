// src/config/env.ts
export interface EnvConfig {
  BOT_TOKEN: string;
  DATABASE_PATH: string;
  NODE_ENV: 'development' | 'production';
  ANTHROPIC_API_KEY: string;
  AI_BASE_URL: string;
  AI_MODEL: string;
  AI_FAST_MODEL: string;
  REDIS_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  OAUTH_SERVER_PORT?: number;
  ENCRYPTION_KEY?: string;
  PUBLIC_DOMAIN?: string;
  BOT_USERNAME?: string;
  MTPROTO_API_ID?: number;
  MTPROTO_API_HASH?: string;
  HF_TOKEN?: string;
  GROQ_API_KEY?: string;
  BOT_ADMIN_ID?: number;
  INTENT_LEARNER_DAILY_LIMIT: number;
  INLINE_BOT_TOKEN?: string;
  INLINE_BOT_USERNAME?: string;
  AGENT_JWT_SECRET?: string;
  AGENT_DOWNLOAD_URL?: string;
  SILERO_PYTHON_PATH?: string;
  DEEPGRAM_API_KEY?: string;
  DISABLE_VOICE?: boolean;
  AI_DEBUG_LOGS?: boolean;
  ADMIN_ALERT_TOKEN?: string;
  AI_MODEL_FALLBACK?: string;
  AI_BASE_URL_FALLBACK?: string;
  AI_API_KEY_FALLBACK?: string;
  OPENWEATHER_API_KEY?: string;
  GOOGLE_API_KEY?: string;
}

export function loadConfig(): EnvConfig {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) {
    throw new Error('BOT_TOKEN environment variable is required');
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY environment variable is required');
  }

  const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || undefined;
  const REDIS_URL = process.env.REDIS_URL || undefined;
  const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || undefined;
  const PUBLIC_DOMAIN = process.env.PUBLIC_DOMAIN || undefined;

  if (GOOGLE_CLIENT_ID) {
    if (!REDIS_URL) {
      throw new Error('REDIS_URL is required when GOOGLE_CLIENT_ID is set');
    }
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

  return {
    BOT_TOKEN,
    DATABASE_PATH: process.env.DATABASE_PATH || './data/calendar.db',
    NODE_ENV: (process.env.NODE_ENV as EnvConfig['NODE_ENV']) || 'development',
    ANTHROPIC_API_KEY,
    AI_BASE_URL: process.env.AI_BASE_URL || 'https://api.anthropic.com',
    AI_MODEL: process.env.AI_MODEL || 'claude-sonnet-4-20250514',
    AI_FAST_MODEL: process.env.AI_FAST_MODEL || 'claude-haiku-4-5-20251001',
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
    HF_TOKEN: process.env.HF_TOKEN || undefined,
    GROQ_API_KEY: process.env.GROQ_API_KEY || undefined,
    BOT_ADMIN_ID,
    INTENT_LEARNER_DAILY_LIMIT,
    INLINE_BOT_TOKEN: process.env.INLINE_BOT_TOKEN || undefined,
    INLINE_BOT_USERNAME: process.env.INLINE_BOT_USERNAME || undefined,
    AGENT_JWT_SECRET: process.env.AGENT_JWT_SECRET || undefined,
    AGENT_DOWNLOAD_URL: process.env.AGENT_DOWNLOAD_URL || undefined,
    SILERO_PYTHON_PATH: process.env.SILERO_PYTHON_PATH || undefined,
    DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY || undefined,
    DISABLE_VOICE: process.env.DISABLE_VOICE === 'true' || undefined,
    AI_DEBUG_LOGS: process.env.AI_DEBUG_LOGS === 'true' || undefined,
    ADMIN_ALERT_TOKEN: process.env.ADMIN_ALERT_TOKEN || undefined,
    AI_MODEL_FALLBACK: process.env.AI_MODEL_FALLBACK || undefined,
    AI_BASE_URL_FALLBACK: process.env.AI_BASE_URL_FALLBACK || undefined,
    AI_API_KEY_FALLBACK: process.env.AI_API_KEY_FALLBACK || undefined,
    OPENWEATHER_API_KEY: process.env.OPENWEATHER_API_KEY || undefined,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY || undefined,
  };
}
