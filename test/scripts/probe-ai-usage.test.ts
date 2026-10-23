// A Claude-only chain, driven through the bot's own aiStreamRound, leaves a usage row that the probe reads back.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import { probeWithUsageLedger } from '../../scripts/probe-ai-chain.ts';
import { resetModelRegistry } from '../../src/services/ai/model-registry.ts';
import { resetProviderCircuit } from '../../src/services/ai/provider-circuit.ts';
import { resetEligibility } from '../../src/services/ai/provider-eligibility.ts';
import { providerClients } from '../../src/services/ai/streaming.ts';

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface Chunk {
  choices: { delta: { content?: string }; finish_reason: string | null }[];
  usage?: Usage;
}

interface FakeRequest {
  model: string;
  max_tokens?: number;
  temperature?: number;
}

const realProviderClients = { ...providerClients };
const savedEnv = { ...process.env };
const dirs: string[] = [];
let requests: FakeRequest[] = [];

/** The chain only touches `chat.completions.create`; the partial client is presented as a full one here only. */
function asClient(create: (params: FakeRequest) => Promise<AsyncIterable<Chunk>>): OpenAI {
  return { chat: { completions: { create } } } as unknown as OpenAI;
}

function claudeAnswering(text: string, usage?: Usage): OpenAI {
  requests = [];
  return asClient(async (params) => {
    requests.push(params);
    async function* chunks(): AsyncGenerator<Chunk> {
      yield { choices: [{ delta: { content: text }, finish_reason: null }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      if (usage) yield { choices: [], usage };
    }
    return chunks();
  });
}

beforeEach(() => {
  Object.assign(process.env, {
    BOT_TOKEN: 'test-token',
    REDIS_URL: 'redis://localhost:6379',
    ZAI_API_KEY: 'zai-key',
    ZAI_BASE_URL: 'https://zai.example/v1',
    ZAI_MODEL: 'glm-5.1',
    ZAI_FAST_MODEL: 'glm-5.1-air',
    GROQ_API_KEY: 'test-groq-key',
    HF_TOKEN: 'hf-token',
    HF_BASE_URL: 'https://hf.example/v1',
    HF_MODEL: 'hf-main',
    HF_FAST_MODEL: 'hf-fast',
    CLAUDE_API_TOKEN: 'claude-key',
    CLAUDE_MODEL: 'claude-sonnet-5-5',
    CLAUDE_FAST_MODEL: 'claude-haiku-5-5',
    AI_SMART_CHAIN: 'claude',
    AI_FAST_CHAIN: 'claude',
  });
  resetEligibility();
  resetProviderCircuit();
  resetModelRegistry();
});

afterEach(() => {
  process.env = { ...savedEnv };
  Object.assign(providerClients, realProviderClients);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temporaryDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hcb-probe-usage-'));
  dirs.push(dir);
  return join(dir, 'probe.db');
}

test('a Claude-only chain records an ok claude row with its tokens, and the probe verifies it', async () => {
  providerClients.claude = () =>
    claudeAnswering('HCB_RUNTIME_OK', { prompt_tokens: 31, completion_tokens: 9, total_tokens: 40 });

  const report = await probeWithUsageLedger({
    fast: false,
    databasePath: temporaryDatabase(),
    expectProvider: 'claude',
  });

  expect(report.probe.ok).toBe(true);
  expect(report.usageVerified).toBe(true);
  expect(report.usageRows).toMatchObject([
    {
      provider: 'claude',
      model: 'claude-sonnet-5-5',
      chain: 'smart',
      purpose: 'probe',
      outcome: 'ok',
      promptTokens: 31,
      completionTokens: 9,
    },
  ]);
  // The request shape stays exactly what the bot sends Claude: the 128k ceiling and no temperature.
  expect(requests[0]?.max_tokens).toBe(128_000);
  expect(requests[0]?.temperature).toBeUndefined();
});

test('the fast chain of a Claude-only configuration is probed too', async () => {
  providerClients.claude = () =>
    claudeAnswering('HCB_RUNTIME_OK', { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });

  const report = await probeWithUsageLedger({
    fast: true,
    databasePath: temporaryDatabase(),
    expectProvider: 'claude',
  });

  expect(report.usageRows).toMatchObject([
    { provider: 'claude', model: 'claude-haiku-5-5', chain: 'fast', outcome: 'ok' },
  ]);
  expect(report.usageVerified).toBe(true);
});

test('an answer without reported usage is not a verified usage row: tokens stay unknown', async () => {
  providerClients.claude = () => claudeAnswering('HCB_RUNTIME_OK');

  const report = await probeWithUsageLedger({
    fast: false,
    databasePath: temporaryDatabase(),
    expectProvider: 'claude',
  });

  expect(report.probe.ok).toBe(true);
  expect(report.usageRows).toMatchObject([
    { provider: 'claude', outcome: 'ok', promptTokens: null, completionTokens: null },
  ]);
  expect(report.usageVerified).toBe(false);
});

test('a chain that answers from another provider does not verify claude', async () => {
  process.env.AI_SMART_CHAIN = 'zai';
  providerClients.zai = () =>
    claudeAnswering('HCB_RUNTIME_OK', { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });

  const report = await probeWithUsageLedger({
    fast: false,
    databasePath: temporaryDatabase(),
    expectProvider: 'claude',
  });

  expect(report.usageRows).toMatchObject([{ provider: 'zai', outcome: 'ok' }]);
  expect(report.usageVerified).toBe(false);
});

test('a failed Claude request still leaves its error row, with the class and status only', async () => {
  providerClients.claude = () => {
    const rejected = new OpenAI.APIError(
      401,
      { error: { message: 'invalid x-api-key sk-ant-SECRET' } },
      'unauthorized',
      new Headers(),
    );
    return asClient(async () => {
      throw rejected;
    });
  };

  const report = await probeWithUsageLedger({
    fast: false,
    databasePath: temporaryDatabase(),
    expectProvider: 'claude',
  });

  expect(report.probe.ok).toBe(false);
  expect(report.usageVerified).toBe(false);
  expect(report.usageRows).toMatchObject([
    { provider: 'claude', outcome: 'error', errorClass: 'auth', httpStatus: 401 },
  ]);
  expect(JSON.stringify(report)).not.toContain('SECRET');
});

test('--expect-provider without --usage-database is refused, so a pass can never look like proof of that provider', () => {
  const run = Bun.spawnSync(
    [
      process.execPath,
      '--no-env-file',
      join(import.meta.dir, '../../scripts/probe-ai-chain.ts'),
      '--expect-provider',
      'claude',
    ],
    { stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '' } },
  );

  expect(run.exitCode).toBe(2);
  expect(new TextDecoder().decode(run.stderr)).toContain('--usage-database');
});
