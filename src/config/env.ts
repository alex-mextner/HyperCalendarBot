// src/config/env.ts
export interface EnvConfig {
  BOT_TOKEN: string;
  DATABASE_PATH: string;
  NODE_ENV: 'development' | 'production';
}

export function loadConfig(): EnvConfig {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) {
    throw new Error('BOT_TOKEN environment variable is required');
  }

  return {
    BOT_TOKEN,
    DATABASE_PATH: process.env.DATABASE_PATH || './data/calendar.db',
    NODE_ENV: (process.env.NODE_ENV as EnvConfig['NODE_ENV']) || 'development',
  };
}
