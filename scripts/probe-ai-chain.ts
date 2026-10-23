import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config/env.ts';
import { migrations } from '../src/database/migrations.ts';
import { AiUsageRepository, type AiUsageRow } from '../src/database/repositories/ai-usage.repository.ts';
import { runMigrations } from '../src/database/schema.ts';
import { configureProviderCircuit, resetProviderCircuit } from '../src/services/ai/provider-circuit.ts';
import { PROVIDER_IDS, type ProviderId } from '../src/services/ai/provider-ids.ts';
import {
  aiStreamRound,
  type StreamRoundMetrics,
  type StreamRoundOptions,
  type StreamRoundResult,
} from '../src/services/ai/streaming.ts';
import { configureAiUsageRecording, flushAiUsageEvents } from '../src/services/ai/usage-recorder.ts';

const EXPECTED = 'HCB_RUNTIME_OK';

export interface ChainProbeResult {
  checkedAt: string;
  ok: boolean;
  chain: 'fast' | 'smart';
  /** The slot that answered, or null when the round failed. */
  provider: string | null;
  durationMs: number;
  /** Present on a failed round: the error class name, never its message. */
  errorType?: string;
  metrics: StreamRoundMetrics | null;
  scope: string;
}

/** One synthetic request; no calendar tools, user messages or Telegram delivery. */
export async function probeAiChain(
  fast = true,
  stream: (options: StreamRoundOptions) => Promise<StreamRoundResult> = aiStreamRound,
): Promise<ChainProbeResult> {
  const started = performance.now();
  try {
    const result = await stream({
      messages: [{ role: 'user', content: `Return exactly ${EXPECTED}. No tools or other text.` }],
      fast,
      maxTokens: 128,
      temperature: 0,
      signal: AbortSignal.timeout(30_000),
      requestId: `synthetic-runtime-${randomUUID()}`,
      purpose: 'probe',
    });
    return {
      checkedAt: new Date().toISOString(),
      ok: result.text.trim() === EXPECTED && result.toolCalls.length === 0 && result.finishReason === 'stop',
      chain: fast ? 'fast' : 'smart',
      provider: result.providerUsed,
      durationMs: Math.round(performance.now() - started),
      metrics: result.metrics ?? null,
      scope: 'isolated process/provider probe, not Telegram end-to-end acceptance',
    };
  } catch (error) {
    return {
      checkedAt: new Date().toISOString(),
      ok: false,
      chain: fast ? 'fast' : 'smart',
      durationMs: Math.round(performance.now() - started),
      errorType: error instanceof Error ? error.name : 'UnknownError',
      provider: null,
      metrics: null,
      scope: 'isolated process/provider probe, not Telegram end-to-end acceptance',
    };
  }
}

export interface UsageProbeOptions {
  fast: boolean;
  /** SQLite file the usage row is written to; created and migrated when absent. Never the live database. */
  databasePath: string;
  /** The provider whose recorded row proves the probe went through it. */
  expectProvider?: ProviderId;
}

export interface UsageProbeReport {
  probe: ChainProbeResult;
  usageRows: AiUsageRow[];
  /** An ok row for the expected provider (any, when none is named) with prompt and completion tokens reported. */
  usageVerified: boolean;
}

/**
 * Runs the probe through the bot's own `aiStreamRound` with usage recording pointed at `databasePath`,
 * then reads back the rows that attempt wrote. Force the chain with AI_SMART_CHAIN / AI_FAST_CHAIN.
 */
export async function probeWithUsageLedger(
  options: UsageProbeOptions,
  stream: (options: StreamRoundOptions) => Promise<StreamRoundResult> = aiStreamRound,
): Promise<UsageProbeReport> {
  mkdirSync(dirname(options.databasePath), { recursive: true });
  const db = new Database(options.databasePath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    runMigrations(db, migrations);
    const repo = new AiUsageRepository(db);
    configureAiUsageRecording(repo);
    const startedAt = Date.now();
    const probe = await probeAiChain(options.fast, stream);
    flushAiUsageEvents();
    configureAiUsageRecording(null);
    const usageRows = [...repo.iterateSince(startedAt)];
    const usageVerified = usageRows.some(
      (row) =>
        row.outcome === 'ok' &&
        (options.expectProvider === undefined || row.provider === options.expectProvider) &&
        row.promptTokens !== null &&
        row.completionTokens !== null,
    );
    return { probe, usageRows, usageVerified };
  } finally {
    configureAiUsageRecording(null);
    db.close();
  }
}

if (import.meta.main) {
  const config = loadConfig();
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      smart: { type: 'boolean', default: false },
      'usage-database': { type: 'string' },
      'expect-provider': { type: 'string' },
    },
    strict: true,
  });
  const expected = values['expect-provider'];
  const expectProvider = PROVIDER_IDS.find((id) => id === expected);
  if (expected !== undefined && expectProvider === undefined) {
    console.error(`--expect-provider must be one of ${PROVIDER_IDS.join(', ')}`);
    process.exit(2);
  }
  const usageDatabase = values['usage-database'];
  if (usageDatabase === undefined) {
    configureProviderCircuit(`${config.DATABASE_PATH}.provider-state.sqlite`);
    const result = await probeAiChain(!values.smart);
    console.log(`PROBE_JSON ${JSON.stringify(result)}`);
    resetProviderCircuit();
    if (!result.ok) process.exitCode = 1;
  } else {
    // The circuit stays in memory: a probe must never read or change the live account state.
    const report = await probeWithUsageLedger({ fast: !values.smart, databasePath: usageDatabase, expectProvider });
    console.log(`PROBE_JSON ${JSON.stringify(report.probe)}`);
    console.log(`USAGE_ROWS_JSON ${JSON.stringify(report.usageRows)}`);
    console.log(`USAGE_VERIFIED ${report.usageVerified}`);
    resetProviderCircuit();
    if (!report.probe.ok || !report.usageVerified) process.exitCode = 1;
  }
}
