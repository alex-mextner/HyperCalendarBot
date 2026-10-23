import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { migrations } from '../../src/database/migrations.ts';
import { type AiUsageEvent, AiUsageRepository } from '../../src/database/repositories/ai-usage.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import { jsonCodec } from '../../src/utils/json-codec.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function event(overrides: Partial<AiUsageEvent> = {}): AiUsageEvent {
  return {
    at: Date.now() - DAY_MS,
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
    chain: 'smart',
    purpose: 'agent',
    outcome: 'ok',
    errorClass: null,
    httpStatus: null,
    skipReason: null,
    durationMs: 400,
    promptTokens: 100,
    completionTokens: 10,
    reasoningTokens: null,
    cachedTokens: null,
    requestId: null,
    ...overrides,
  };
}

function databaseWith(events: AiUsageEvent[], migrated = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'hcb-ai-usage-'));
  dirs.push(dir);
  const path = join(dir, 'calendar.db');
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL');
  if (migrated) {
    runMigrations(db, migrations);
    new AiUsageRepository(db).insertMany(events);
  }
  db.close();
  return path;
}

function run(...args: string[]) {
  const run = Bun.spawnSync(
    [process.execPath, '--no-env-file', join(import.meta.dir, '../../scripts/report-ai-usage.ts'), ...args],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  return {
    exitCode: run.exitCode,
    stdout: new TextDecoder().decode(run.stdout),
    stderr: new TextDecoder().decode(run.stderr),
  };
}

const jsonReport = jsonCodec(
  z.object({
    days: z.number(),
    totalAttempts: z.number(),
    providers: z.array(z.object({ provider: z.string(), verdict: z.string() })),
    models: z.array(z.object({ provider: z.string(), model: z.string(), ok: z.number() })),
  }),
);

describe('scripts/report-ai-usage.ts', () => {
  test('prints the per provider:model report and says a provider with no rows had no traffic', () => {
    const database = databaseWith([event(), event()]);

    const result = run('--database', database);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('AI usage, last 7 d · attempts: 2');
    expect(result.stdout).toContain('groq:openai/gpt-oss-120b');
    expect(result.stdout).toContain('claude: no traffic in window');
  });

  test('--json prints the same data as machine-readable JSON', () => {
    const database = databaseWith([event(), event({ provider: 'gemini', model: 'g' })]);

    const result = run('--database', database, '--json', '--days', '30');

    expect(result.exitCode).toBe(0);
    const report = jsonReport.parse(result.stdout);
    expect(report.days).toBe(30);
    expect(report.totalAttempts).toBe(2);
    expect(report.models.map((m) => `${m.provider}:${m.model}`)).toEqual(['groq:openai/gpt-oss-120b', 'gemini:g']);
    expect(report.providers.find((p) => p.provider === 'claude')?.verdict).toBe('no_traffic');
  });

  test('--days limits the window: older rows do not count', () => {
    const database = databaseWith([event({ at: Date.now() - 10 * DAY_MS }), event()]);

    expect(jsonReport.parse(run('--database', database, '--json', '--days', '3').stdout).totalAttempts).toBe(1);
    expect(jsonReport.parse(run('--database', database, '--json', '--days', '30').stdout).totalAttempts).toBe(2);
  });

  test('reads the database read-only: a database it could not write still reports', () => {
    const database = databaseWith([event()]);
    chmodSync(database, 0o444);

    const result = run('--database', database);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('attempts: 1');
  });

  test.each(['0', '181', '2.5', 'abc', '-1'])('refuses --days %s with a usage error', (days) => {
    const result = run('--database', databaseWith([]), '--days', days);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--days');
  });

  test('a database that has not run the migration yet is reported as such, not as an empty report', () => {
    const result = run('--database', databaseWith([], false));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ai_usage_events');
  });

  test('a missing database file is an error and is not created', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcb-ai-usage-'));
    dirs.push(dir);

    const result = run('--database', join(dir, 'absent.db'));

    expect(result.exitCode).toBe(1);
    expect(existsSync(join(dir, 'absent.db'))).toBe(false);
  });
});
