// test/config/env.test.ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { loadConfig } from '../../src/config/env.ts';
import type { ProviderId } from '../../src/services/ai/provider-ids.ts';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const setAgentVars = () => {
    process.env.AGENT_JWT_SECRET = 'test-agent-secret-at-least-32-chars!!';
    process.env.AGENT_DOWNLOAD_URL = 'https://example.com/agent';
  };

  /** Set every required AI provider env var to a dummy value. */
  const setAiVars = () => {
    process.env.ZAI_API_KEY = 'test-zai-key';
    process.env.ZAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';
    process.env.ZAI_MODEL = 'glm-5.1';
    process.env.ZAI_FAST_MODEL = 'glm-4.7-flash';
    process.env.HF_TOKEN = 'test-hf-token';
    process.env.HF_BASE_URL = 'https://router.huggingface.co/v1';
    process.env.HF_MODEL = 'Qwen/Qwen3-235B-A22B';
    process.env.HF_FAST_MODEL = 'meta-llama/Llama-3.3-70B-Instruct';
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
    process.env.GEMINI_MODEL = 'gemini-2.5-pro';
    process.env.GEMINI_FAST_MODEL = 'gemini-2.5-flash';
  };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.BOT_TOKEN = 'test-token';
    process.env.REDIS_URL = 'redis://localhost:6379';
    setAiVars();
  });

  test('tool schemas remain full unless lazy rollout is explicitly selected', () => {
    delete process.env.AI_TOOL_SCHEMA_MODE;
    expect(loadConfig().AI_TOOL_SCHEMA_MODE).toBe('full');
    process.env.AI_TOOL_SCHEMA_MODE = 'lazy';
    expect(loadConfig().AI_TOOL_SCHEMA_MODE).toBe('lazy');
    process.env.AI_TOOL_SCHEMA_MODE = 'lzy';
    expect(() => loadConfig()).toThrow('AI_TOOL_SCHEMA_MODE');
  });

  test('lazy tool canary IDs are explicit bounded safe user IDs', () => {
    process.env.AI_TOOL_SCHEMA_USER_IDS = '456,789,456';
    expect(loadConfig().AI_TOOL_SCHEMA_USER_IDS).toEqual([456, 789]);
    for (const invalid of ['', '1e3', '-1', '0', '1,,2', '9007199254740992', Array(101).fill('1').join(',')]) {
      process.env.AI_TOOL_SCHEMA_USER_IDS = invalid;
      expect(() => loadConfig()).toThrow('AI_TOOL_SCHEMA_USER_IDS');
    }
    delete process.env.AI_TOOL_SCHEMA_USER_IDS;
    expect(loadConfig().AI_TOOL_SCHEMA_USER_IDS).toBeUndefined();
  });

  test('Groq account token limits are optional, strict and model-specific', () => {
    delete process.env.GROQ_TPM_LIMITS;
    expect(loadConfig().GROQ_TPM_LIMITS).toBeUndefined();
    process.env.GROQ_TPM_LIMITS = '{"openai/gpt-oss-120b":250000}';
    expect(loadConfig().GROQ_TPM_LIMITS).toEqual({ 'openai/gpt-oss-120b': 250000 });
    for (const invalid of [
      '',
      'null',
      '[]',
      '{broken',
      '{"x":0}',
      '{"x":-1}',
      '{"x":1.5}',
      '{"x":"8000"}',
      '{"__proto__":8000}',
      '{"x":1e20}',
      ' '.repeat(4097),
      JSON.stringify(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`model${i}`, 8000]))),
    ]) {
      process.env.GROQ_TPM_LIMITS = invalid;
      expect(() => loadConfig()).toThrow('GROQ_TPM_LIMITS');
    }
  });

  describe('provider chain order', () => {
    const SMART_DEFAULT: ProviderId[] = ['hf', 'zai', 'gemini', 'groq'];
    const FAST_DEFAULT: ProviderId[] = ['groq', 'gemini', 'hf', 'zai'];

    test('puts the paid provider first by default, and keeps the small tiers behind it', () => {
      const config = loadConfig();
      expect(config.AI_SMART_CHAIN).toEqual({ order: SMART_DEFAULT, fromEnv: false, fallback: SMART_DEFAULT });
      expect(config.AI_FAST_CHAIN).toEqual({ order: FAST_DEFAULT, fromEnv: false, fallback: FAST_DEFAULT });
    });

    // Each chain carries its own fallback, so one cannot be built with the
    // other's default — the fast chain prioritizes short-call latency independently.
    test('the fast chain reads its own variable and keeps its own fallback', () => {
      process.env.AI_FAST_CHAIN = 'gemini,zai';
      const config = loadConfig();
      expect(config.AI_FAST_CHAIN).toEqual({ order: ['gemini', 'zai'], fromEnv: true, fallback: FAST_DEFAULT });
      expect(config.AI_SMART_CHAIN.order).toEqual(SMART_DEFAULT);
    });

    // The reason to reorder arrives as an incident, so it has to be doable
    // without a deploy.
    test('takes the order from the environment', () => {
      process.env.AI_SMART_CHAIN = 'gemini, hf ,zai';
      expect(loadConfig().AI_SMART_CHAIN).toEqual({
        order: ['gemini', 'hf', 'zai'],
        fromEnv: true,
        fallback: SMART_DEFAULT,
      });
    });

    test('drops a name it does not know rather than failing to start', () => {
      process.env.AI_SMART_CHAIN = 'hf,openai,zai';
      expect(loadConfig().AI_SMART_CHAIN).toEqual({ order: ['hf', 'zai'], fromEnv: true, fallback: SMART_DEFAULT });
    });

    test('ignores a repeated provider instead of trying it twice', () => {
      process.env.AI_SMART_CHAIN = 'hf,zai,hf';
      expect(loadConfig().AI_SMART_CHAIN).toEqual({ order: ['hf', 'zai'], fromEnv: true, fallback: SMART_DEFAULT });
    });

    // An order naming nothing usable would leave the bot with no providers at
    // all, which is worse than ignoring the typo.
    test('falls back to the default when the order names nothing known', () => {
      process.env.AI_SMART_CHAIN = 'openai, anthropic';
      expect(loadConfig().AI_SMART_CHAIN).toEqual({ order: SMART_DEFAULT, fromEnv: false, fallback: SMART_DEFAULT });
    });
  });

  test('throws if BOT_TOKEN is missing', () => {
    delete process.env.BOT_TOKEN;
    expect(() => loadConfig()).toThrow('BOT_TOKEN');
  });

  test('throws if ZAI_API_KEY is missing', () => {
    delete process.env.ZAI_API_KEY;
    expect(() => loadConfig()).toThrow('ZAI_API_KEY');
  });

  test('throws if ZAI_BASE_URL is missing', () => {
    delete process.env.ZAI_BASE_URL;
    expect(() => loadConfig()).toThrow('ZAI_BASE_URL');
  });

  test('throws if ZAI_MODEL is missing', () => {
    delete process.env.ZAI_MODEL;
    expect(() => loadConfig()).toThrow('ZAI_MODEL');
  });

  test('throws if ZAI_FAST_MODEL is missing', () => {
    delete process.env.ZAI_FAST_MODEL;
    expect(() => loadConfig()).toThrow('ZAI_FAST_MODEL');
  });

  test('throws if HF_TOKEN is missing', () => {
    delete process.env.HF_TOKEN;
    expect(() => loadConfig()).toThrow('HF_TOKEN');
  });

  test('throws if HF_BASE_URL is missing', () => {
    delete process.env.HF_BASE_URL;
    expect(() => loadConfig()).toThrow('HF_BASE_URL');
  });

  test('throws if HF_MODEL is missing', () => {
    delete process.env.HF_MODEL;
    expect(() => loadConfig()).toThrow('HF_MODEL');
  });

  test('throws if HF_FAST_MODEL is missing', () => {
    delete process.env.HF_FAST_MODEL;
    expect(() => loadConfig()).toThrow('HF_FAST_MODEL');
  });

  test('throws if GEMINI_API_KEY is missing', () => {
    delete process.env.GEMINI_API_KEY;
    expect(() => loadConfig()).toThrow('GEMINI_API_KEY');
  });

  test('throws if GEMINI_BASE_URL is missing', () => {
    delete process.env.GEMINI_BASE_URL;
    expect(() => loadConfig()).toThrow('GEMINI_BASE_URL');
  });

  test('throws if GEMINI_MODEL is missing', () => {
    delete process.env.GEMINI_MODEL;
    expect(() => loadConfig()).toThrow('GEMINI_MODEL');
  });

  test('throws if GEMINI_FAST_MODEL is missing', () => {
    delete process.env.GEMINI_FAST_MODEL;
    expect(() => loadConfig()).toThrow('GEMINI_FAST_MODEL');
  });

  test('retired AGENT_JWT_SECRET is absent from config when unset', () => {
    delete process.env.AGENT_JWT_SECRET;
    delete process.env.AGENT_DOWNLOAD_URL;
    const config = loadConfig();
    expect('AGENT_JWT_SECRET' in config).toBe(false);
  });

  test('retired AGENT_DOWNLOAD_URL is absent from config when unset', () => {
    delete process.env.AGENT_JWT_SECRET;
    delete process.env.AGENT_DOWNLOAD_URL;
    const config = loadConfig();
    expect('AGENT_DOWNLOAD_URL' in config).toBe(false);
  });

  test('retired AGENT_JWT_SECRET is ignored when present', () => {
    process.env.AGENT_JWT_SECRET = 'test-agent-secret-at-least-32-chars!!';
    const config = loadConfig();
    expect('AGENT_JWT_SECRET' in config).toBe(false);
  });

  test('returns config with defaults when required vars are set', () => {
    setAgentVars();
    delete process.env.NODE_ENV;
    const config = loadConfig();
    expect(config.BOT_TOKEN).toBe('test-token');
    expect(config.DATABASE_PATH).toBe('./data/calendar.db');
    expect(config.NODE_ENV).toBe('development');
    expect(config.ZAI_API_KEY).toBe('test-zai-key');
    expect(config.ZAI_BASE_URL).toBe('https://api.z.ai/api/coding/paas/v4');
    expect(config.ZAI_MODEL).toBe('glm-5.1');
    expect(config.ZAI_FAST_MODEL).toBe('glm-4.7-flash');
    expect(config.HF_TOKEN).toBe('test-hf-token');
    expect(config.HF_BASE_URL).toBe('https://router.huggingface.co/v1');
    expect(config.HF_MODEL).toBe('Qwen/Qwen3-235B-A22B');
    expect(config.HF_FAST_MODEL).toBe('meta-llama/Llama-3.3-70B-Instruct');
    expect(config.GEMINI_API_KEY).toBe('test-gemini-key');
    expect(config.GEMINI_BASE_URL).toBe('https://generativelanguage.googleapis.com/v1beta/openai/');
    expect(config.GEMINI_MODEL).toBe('gemini-2.5-pro');
    expect(config.GEMINI_FAST_MODEL).toBe('gemini-2.5-flash');
  });

  test('respects DATABASE_PATH override', () => {
    setAgentVars();
    process.env.DATABASE_PATH = '/tmp/test.db';
    const config = loadConfig();
    expect(config.DATABASE_PATH).toBe('/tmp/test.db');
  });

  test('throws if REDIS_URL is missing', () => {
    delete process.env.REDIS_URL;
    expect(() => loadConfig()).toThrow('REDIS_URL');
  });

  test('throws when GOOGLE_CLIENT_ID set but ENCRYPTION_KEY missing', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'csec';
    delete process.env.ENCRYPTION_KEY;
    expect(() => loadConfig()).toThrow('ENCRYPTION_KEY is required when GOOGLE_CLIENT_ID is set');
  });

  test('throws when ENCRYPTION_KEY is not 64 hex chars', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'csec';
    process.env.ENCRYPTION_KEY = 'tooshort';
    expect(() => loadConfig()).toThrow('ENCRYPTION_KEY must be 64 hex characters');
  });

  test('loads all Google vars when present', () => {
    setAgentVars();
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
    setAgentVars();
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'csec';
    process.env.ENCRYPTION_KEY = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    process.env.PUBLIC_DOMAIN = 'example.com';
    delete process.env.GOOGLE_REDIRECT_URI;
    const config = loadConfig();
    expect(config.GOOGLE_REDIRECT_URI).toBe('https://example.com/oauth/google/callback');
  });

  test('BOT_ADMIN_ID is undefined when not set', () => {
    setAgentVars();
    delete process.env.BOT_ADMIN_ID;
    const config = loadConfig();
    expect(config.BOT_ADMIN_ID).toBeUndefined();
  });

  test('BOT_ADMIN_ID parses as number when set', () => {
    setAgentVars();
    process.env.BOT_ADMIN_ID = '12345';
    const config = loadConfig();
    expect(config.BOT_ADMIN_ID).toBe(12345);
  });

  test('throws when BOT_ADMIN_ID is not a valid number', () => {
    process.env.BOT_ADMIN_ID = 'not-a-number';
    expect(() => loadConfig()).toThrow('BOT_ADMIN_ID must be a valid number');
  });

  test('INTENT_LEARNER_DAILY_LIMIT defaults to 100', () => {
    setAgentVars();
    delete process.env.INTENT_LEARNER_DAILY_LIMIT;
    const config = loadConfig();
    expect(config.INTENT_LEARNER_DAILY_LIMIT).toBe(100);
  });

  test('INTENT_LEARNER_DAILY_LIMIT uses custom value when set', () => {
    setAgentVars();
    process.env.INTENT_LEARNER_DAILY_LIMIT = '50';
    const config = loadConfig();
    expect(config.INTENT_LEARNER_DAILY_LIMIT).toBe(50);
  });

  test('throws when INTENT_LEARNER_DAILY_LIMIT is not a valid number', () => {
    process.env.INTENT_LEARNER_DAILY_LIMIT = 'invalid';
    expect(() => loadConfig()).toThrow('INTENT_LEARNER_DAILY_LIMIT must be a valid number');
  });
});
