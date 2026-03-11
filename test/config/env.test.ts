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

  test('returns config with defaults when BOT_TOKEN is set', () => {
    process.env.BOT_TOKEN = 'test-token';
    delete process.env.NODE_ENV;
    const config = loadConfig();
    expect(config.BOT_TOKEN).toBe('test-token');
    expect(config.DATABASE_PATH).toBe('./data/calendar.db');
    expect(config.NODE_ENV).toBe('development');
  });

  test('respects DATABASE_PATH override', () => {
    process.env.BOT_TOKEN = 'test-token';
    process.env.DATABASE_PATH = '/tmp/test.db';
    const config = loadConfig();
    expect(config.DATABASE_PATH).toBe('/tmp/test.db');
  });
});
