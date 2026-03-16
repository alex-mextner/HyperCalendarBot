// src/config/env.ts
export interface EnvConfig {
  BOT_TOKEN: string;
  DATABASE_PATH: string;
  NODE_ENV: 'development' | 'production';
  ANTHROPIC_API_KEY: string;
  AI_BASE_URL: string;
  AI_MODEL: string;
  REDIS_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  OAUTH_SERVER_PORT?: number;
  ENCRYPTION_KEY?: string;
  PUBLIC_DOMAIN?: string;
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

  return {
    BOT_TOKEN,
    DATABASE_PATH: process.env.DATABASE_PATH || './data/calendar.db',
    NODE_ENV: (process.env.NODE_ENV as EnvConfig['NODE_ENV']) || 'development',
    ANTHROPIC_API_KEY,
    AI_BASE_URL: process.env.AI_BASE_URL || 'https://api.anthropic.com',
    AI_MODEL: process.env.AI_MODEL || 'claude-sonnet-4-20250514',
    REDIS_URL,
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || undefined,
    GOOGLE_REDIRECT_URI,
    OAUTH_SERVER_PORT: process.env.OAUTH_SERVER_PORT ? Number(process.env.OAUTH_SERVER_PORT) : undefined,
    ENCRYPTION_KEY,
    PUBLIC_DOMAIN,
    BOT_USERNAME: process.env.BOT_USERNAME || undefined,
  };
}
