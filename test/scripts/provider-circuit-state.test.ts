// scripts/provider-circuit-state.ts shows every circuit with its scope and model: the account row of a
// credential and, for OpenRouter, one row per model, so an operator can tell a revoked key from one model's outage.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { openProviderCircuitStore, providerCircuitKey } from '../../src/services/ai/provider-circuit.ts';
import { jsonCodec } from '../../src/utils/json-codec.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const OPENROUTER_URL = 'https://openrouter.ai/api/v1';
const ENV = {
  BOT_TOKEN: 'test-token',
  REDIS_URL: 'redis://localhost:6379',
  ZAI_API_KEY: 'zai-key',
  ZAI_BASE_URL: 'https://zai.example/v1',
  ZAI_MODEL: 'zai-main',
  ZAI_FAST_MODEL: 'zai-fast',
  HF_TOKEN: 'hf-token',
  HF_BASE_URL: 'https://hf.example/v1',
  HF_MODEL: 'hf-main',
  HF_FAST_MODEL: 'hf-fast',
  OPENROUTER_API_KEY: 'or-key',
  OPENROUTER_MODEL: 'vendor/main',
  OPENROUTER_FAST_MODEL: 'vendor/fast',
  AI_EXECUTOR_CHAIN: 'openrouter:deepseek41-flash',
};

const report = jsonCodec(
  z.object({
    initialized: z.boolean(),
    providers: z.array(
      z.object({
        provider: z.string(),
        scope: z.string(),
        model: z.string().nullable(),
        state: z.string(),
        failureClass: z.string().nullable(),
        status: z.number().nullable(),
      }),
    ),
  }),
);

function run(databasePath: string) {
  const result = Bun.spawnSync(
    [process.execPath, '--no-env-file', join(import.meta.dir, '../../scripts/provider-circuit-state.ts')],
    {
      env: { PATH: process.env.PATH ?? '', DATABASE_PATH: databasePath, ...ENV },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

describe('scripts/provider-circuit-state.ts', () => {
  test('without a sidecar it says nothing is initialized', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcb-circuit-state-'));
    dirs.push(dir);

    const result = run(join(dir, 'calendar.db'));

    expect(result.exitCode).toBe(0);
    expect(report.parse(result.stdout)).toEqual({ initialized: false, providers: [] });
  });

  test('shows an account row per credential and a row per OpenRouter model, with the model named', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcb-circuit-state-'));
    dirs.push(dir);
    const database = join(dir, 'calendar.db');
    const store = openProviderCircuitStore(`${database}.provider-state.sqlite`);
    try {
      store.recordFailure(
        {
          key: providerCircuitKey('openrouter', OPENROUTER_URL, 'or-key'),
          provider: 'openrouter',
          label: 'OpenRouter (vendor/main)',
          chain: 'smart',
        },
        { failureClass: 'auth_failed', status: 401, retryAtMs: null, resetHint: null },
        null,
        Date.now(),
      );
    } finally {
      store.close();
    }

    const result = run(database);

    expect(result.exitCode).toBe(0);
    const { providers } = report.parse(result.stdout);
    const openrouter = providers.filter((row) => row.provider === 'openrouter');
    expect(openrouter.map((row) => [row.scope, row.model, row.state])).toEqual([
      ['account', null, 'open'],
      ['model', 'vendor/main', 'closed'],
      ['model', 'vendor/fast', 'closed'],
      ['model', 'deepseek/deepseek-v4.1-flash', 'closed'],
    ]);
    expect(openrouter[0]).toMatchObject({ failureClass: 'auth_failed', status: 401 });
    expect(providers.filter((row) => row.provider !== 'openrouter').every((row) => row.scope === 'account')).toBe(true);
  });
});
