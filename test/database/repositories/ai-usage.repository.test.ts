// test/database/repositories/ai-usage.repository.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import {
  AI_USAGE_RETENTION_DAYS,
  type AiUsageEvent,
  AiUsageRepository,
} from '../../../src/database/repositories/ai-usage.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function event(overrides: Partial<AiUsageEvent> = {}): AiUsageEvent {
  return {
    at: 1_000,
    provider: 'zai',
    model: 'glm-5.1',
    chain: 'smart',
    purpose: 'agent',
    outcome: 'ok',
    errorClass: null,
    httpStatus: null,
    skipReason: null,
    durationMs: 420,
    promptTokens: 100,
    completionTokens: 20,
    reasoningTokens: 5,
    cachedTokens: 0,
    requestId: 'req-1',
    role: null,
    preset: null,
    costMicroUsd: null,
    ...overrides,
  };
}

describe('AiUsageRepository', () => {
  let db: Database;
  let repo: AiUsageRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    repo = new AiUsageRepository(db);
  });

  test('stores unknown token usage as NULL and a reported zero as 0', () => {
    repo.insertMany([
      event({ at: 1, promptTokens: null, completionTokens: null, reasoningTokens: null, cachedTokens: null }),
      event({ at: 2, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0 }),
    ]);

    const rows = [...repo.iterateSince(0)];
    expect(rows.map((row) => [row.promptTokens, row.completionTokens, row.reasoningTokens, row.cachedTokens])).toEqual([
      [null, null, null, null],
      [0, 0, 0, 0],
    ]);
  });

  test('rows of retired providers and retired skip reasons are read back as stored', () => {
    repo.insertMany([
      event({ at: 1, provider: 'gemini', model: 'gemini-3-flash' }),
      event({
        at: 2,
        provider: 'groq',
        model: 'openai/gpt-oss-120b',
        outcome: 'skipped',
        skipReason: 'preflight_size',
      }),
      event({ at: 3, provider: 'gemini', outcome: 'skipped', skipReason: 'local_budget' }),
    ]);

    const rows = [...repo.iterateSince(0)];
    expect(rows.map((row) => [row.provider, row.skipReason])).toEqual([
      ['gemini', null],
      ['groq', 'preflight_size'],
      ['gemini', 'local_budget'],
    ]);
  });

  test('round-trips a failed attempt with its class, status and skip reason', () => {
    repo.insertMany([
      event({
        outcome: 'error',
        errorClass: 'rate_limit',
        httpStatus: 429,
        durationMs: null,
        promptTokens: null,
        completionTokens: null,
        reasoningTokens: null,
        cachedTokens: null,
        requestId: null,
      }),
      event({ outcome: 'skipped', skipReason: 'circuit_open', httpStatus: 402, durationMs: null }),
    ]);

    const [failed, skipped] = [...repo.iterateSince(0)];
    expect(failed).toMatchObject({ outcome: 'error', errorClass: 'rate_limit', httpStatus: 429, requestId: null });
    expect(skipped).toMatchObject({ outcome: 'skipped', skipReason: 'circuit_open', httpStatus: 402 });
  });

  test('round-trips role, preset and cost; a legacy row and an unknown cost read back NULL, a known zero stays 0', () => {
    repo.insertMany([
      event({ at: 1, role: 'executor', preset: 'glm53-flash-low', costMicroUsd: 1234 }),
      event({ at: 2 }),
      event({ at: 3, role: 'repair', preset: null, costMicroUsd: 0 }),
    ]);

    const rows = [...repo.iterateSince(0)];
    expect(rows.map((row) => [row.role, row.preset, row.costMicroUsd])).toEqual([
      ['executor', 'glm53-flash-low', 1234],
      [null, null, null],
      ['repair', null, 0],
    ]);
  });

  test('writes a whole batch in one transaction: a bad row leaves none of it behind', () => {
    // NaN binds as NULL, which the NOT NULL `at` column refuses.
    expect(() => repo.insertMany([event({ at: 2 }), event({ at: Number.NaN })])).toThrow();
    expect([...repo.iterateSince(0)]).toEqual([]);
  });

  test('iterates only rows at or after the cutoff, oldest first, across batches', () => {
    repo.insertMany(Array.from({ length: 7 }, (_, index) => event({ at: 100 + index })));

    const rows = [...repo.iterateSince(103, 2)];

    expect(rows.map((row) => row.at)).toEqual([103, 104, 105, 106]);
  });

  test('retention prunes rows older than the horizon and keeps the rest, boundary included', () => {
    const now = 400 * DAY_MS;
    const horizon = now - AI_USAGE_RETENTION_DAYS * DAY_MS;
    repo.insertMany([
      event({ at: horizon - DAY_MS }),
      event({ at: horizon - 1 }),
      event({ at: horizon }),
      event({ at: now - 1 }),
    ]);

    const deleted = repo.pruneExpired(now);

    expect(deleted).toBe(2);
    expect([...repo.iterateSince(0)].map((row) => row.at)).toEqual([horizon, now - 1]);
  });

  test('the retention horizon is 180 days', () => {
    expect(AI_USAGE_RETENTION_DAYS).toBe(180);
  });
});
