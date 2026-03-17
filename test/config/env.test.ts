// test/config/env.test.ts
import { afterEach, describe, expect, test } from 'bun:test';
import { loadConfig } from '../../src/config/env.ts';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('throws if BOT_TOKEN is missing', () => {
    delete process.env.BOT_TOKEN;
    expect(() => loadConfig()).toThrow('BOT_TOKEN');
  });

  test('throws if ANTHROPIC_API_KEY is missing', () => {
    process.env.BOT_TOKEN = 'test-token';
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => loadConfig()).toThrow('ANTHROPIC_API_KEY');
  });

  test('returns config with defaults when required vars are set', () => {
    process.env.BOT_TOKEN = 'test-token';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    delete process.env.NODE_ENV;
    delete process.env.AI_BASE_URL;
    delete process.env.AI_MODEL;
    const config = loadConfig();
    expect(config.BOT_TOKEN).toBe('test-token');
    expect(config.DATABASE_PATH).toBe('./data/calendar.db');
    expect(config.NODE_ENV).toBe('development');
    expect(config.ANTHROPIC_API_KEY).toBe('test-key');
    expect(config.AI_BASE_URL).toBe('https://api.anthropic.com');
    expect(config.AI_MODEL).toBe('claude-sonnet-4-20250514');
  });

  test('respects DATABASE_PATH override', () => {
    process.env.BOT_TOKEN = 'test-token';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.DATABASE_PATH = '/tmp/test.db';
    const config = loadConfig();
    expect(config.DATABASE_PATH).toBe('/tmp/test.db');
  });

  test('loads custom AI_BASE_URL and AI_MODEL', () => {
    process.env.BOT_TOKEN = 'test-token';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.AI_BASE_URL = 'https://custom.api';
    process.env.AI_MODEL = 'custom-model';
    const config = loadConfig();
    expect(config.AI_BASE_URL).toBe('https://custom.api');
    expect(config.AI_MODEL).toBe('custom-model');
  });

  test('REDIS_URL is optional (bot works without it)', () => {
    process.env.BOT_TOKEN = 'test-token';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    delete process.env.REDIS_URL;
    delete process.env.GOOGLE_CLIENT_ID;
    const config = loadConfig();
    expect(config.REDIS_URL).toBeUndefined();
  });

  test('throws when GOOGLE_CLIENT_ID set but REDIS_URL missing', () => {
    process.env.BOT_TOKEN = 'test-token';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    delete process.env.REDIS_URL;
    process.env.GOOGLE_CLIENT_ID = 'cid';
    expect(() => loadConfig()).toThrow('REDIS_URL is required when GOOGLE_CLIENT_ID is set');
  });

  test('throws when GOOGLE_CLIENT_ID set but ENCRYPTION_KEY missing', () => {
    process.env.BOT_TOKEN = 'test-token';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'csec';
    delete process.env.ENCRYPTION_KEY;
    expect(() => loadConfig()).toThrow('ENCRYPTION_KEY is required when GOOGLE_CLIENT_ID is set');
  });

  test('throws when ENCRYPTION_KEY is not 64 hex chars', () => {
    process.env.BOT_TOKEN = 'test-token';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'csec';
    process.env.ENCRYPTION_KEY = 'tooshort';
    expect(() => loadConfig()).toThrow('ENCRYPTION_KEY must be 64 hex characters');
  });

  test('loads all Google vars when present', () => {
    process.env.BOT_TOKEN = 'test-token';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'csec';
    process.env.ENCRYPTION_KEY = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    process.env.OAUTH_SERVER_PORT = '3311';
    const config = loadConfig();
    expect(config.GOOGLE_CLIENT_ID).toBe('cid');
    expect(config.GOOGLE_CLIENT_SECRET).toBe('csec');
    expect(config.OAUTH_SERVER_PORT).toBe(3311);
  });

  test('PUBLIC_DOMAIN derives GOOGLE_REDIRECT_URI when not explicit', () => {
    process.env.BOT_TOKEN = 'test-token';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'csec';
    process.env.ENCRYPTION_KEY = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    process.env.PUBLIC_DOMAIN = 'example.com';
    delete process.env.GOOGLE_REDIRECT_URI;
    const config = loadConfig();
    expect(config.GOOGLE_REDIRECT_URI).toBe('https://example.com/oauth/google/callback');
  });
});
