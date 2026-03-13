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
});
