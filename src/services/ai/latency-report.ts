import { z } from 'zod';

const metricNumber = z.number().nonnegative();
const failedProviderSchema = z.object({ provider: z.string(), model: z.string() });
export const AiLogRowSchema = z
  .object({
    msg: z.string().optional(),
    requestId: z.string().optional(),
    userId: z.number().optional(),
    chatId: z.number().optional(),
    elapsedMs: metricNumber.optional(),
    firstVisibleMs: metricNumber.nullable().optional(),
    modelDurationMs: metricNumber.optional(),
    toolDurationMs: metricNumber.optional(),
    deliveryActionMs: metricNumber.optional(),
    modelCalls: metricNumber.optional(),
    modelAttempts: metricNumber.optional(),
    providerFallbacks: metricNumber.optional(),
    promptTokens: metricNumber.nullable().optional(),
    completionTokens: metricNumber.nullable().optional(),
    reportedTotalTokens: metricNumber.optional(),
    reasoningTokens: metricNumber.nullable().optional(),
    cachedTokens: metricNumber.nullable().optional(),
    freshInputTokens: metricNumber.nullable().optional(),
    cacheWriteTokens: metricNumber.nullable().optional(),
    cachedTokensMissingRounds: metricNumber.optional(),
    freshInputTokensMissingRounds: metricNumber.optional(),
    cacheWriteTokensMissingRounds: metricNumber.optional(),
    usageMissingRounds: metricNumber.optional(),
    usagePartialRounds: metricNumber.optional(),
    termination: z.string().optional(),
    deliveryOutcome: z.string().optional(),
    provider: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    purpose: z.string().optional(),
    providerDurationMs: metricNumber.nullable().optional(),
    totalDurationMs: metricNumber.nullable().optional(),
    attemptCount: metricNumber.nullable().optional(),
    fallbackCount: metricNumber.nullable().optional(),
    failedProviders: z.array(failedProviderSchema).optional(),
    skippedProviders: z.array(failedProviderSchema).optional(),
    success: z.boolean().optional(),
    tier: z.string().optional(),
    durationMs: metricNumber.optional(),
    fallback: z.boolean().optional(),
  })
  .passthrough();
export type AiLogRow = z.infer<typeof AiLogRowSchema>;

function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return Math.round(sorted[index]!);
}
function stats(values: number[]) {
  return { n: values.length, p50: quantile(values, 0.5), p90: quantile(values, 0.9), p95: quantile(values, 0.95) };
}
function inc(map: Map<string, number>, key: string | undefined): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}
function pushDuration(map: Map<string, number[]>, key: string, value: number): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

/** Everything one pass over the log rows collects, before any percentile is taken. */
interface LogTallies {
  requestRows: AiLogRow[];
  providerDurations: Map<string, number[]>;
  providerFailures: Map<string, number>;
  providerSkips: Map<string, number>;
  routeDurations: Map<string, number[]>;
  routeFallbacks: Map<string, number>;
  outcomes: Map<string, number>;
  terminations: Map<string, number>;
}

function noteRequestMetric(tallies: LogTallies, row: AiLogRow): void {
  tallies.requestRows.push(row);
  inc(tallies.outcomes, row.deliveryOutcome);
  inc(tallies.terminations, row.termination);
}

function noteModelCallMetric(tallies: LogTallies, row: AiLogRow): void {
  if (row.provider && row.model && typeof row.providerDurationMs === 'number') {
    pushDuration(tallies.providerDurations, `${row.provider}:${row.model}`, row.providerDurationMs);
  }
  for (const failure of row.failedProviders ?? [])
    inc(tallies.providerFailures, `${failure.provider}:${failure.model}`);
  for (const skip of row.skippedProviders ?? []) inc(tallies.providerSkips, `${skip.provider}:${skip.model}`);
}

function noteRoutingDecision(tallies: LogTallies, tier: string, row: AiLogRow): void {
  if (typeof row.durationMs === 'number') pushDuration(tallies.routeDurations, tier, row.durationMs);
  if (row.fallback) inc(tallies.routeFallbacks, tier);
}

function tallyLogRows(rows: readonly AiLogRow[]): LogTallies {
  const tallies: LogTallies = {
    requestRows: [],
    providerDurations: new Map(),
    providerFailures: new Map(),
    providerSkips: new Map(),
    routeDurations: new Map(),
    routeFallbacks: new Map(),
    outcomes: new Map(),
    terminations: new Map(),
  };
  for (const row of rows) {
    if (row.msg === 'AI request metric' && row.requestId) noteRequestMetric(tallies, row);
    else if (row.msg === 'AI model call metric' && row.requestId) noteModelCallMetric(tallies, row);
    else if ((row.msg === 'Routing decision' || row.msg === 'Routing decision fallback') && row.tier) {
      noteRoutingDecision(tallies, row.tier, row);
    }
  }
  return tallies;
}

type TokenCountKey =
  | 'promptTokens'
  | 'completionTokens'
  | 'reportedTotalTokens'
  | 'reasoningTokens'
  | 'cachedTokens'
  | 'freshInputTokens'
  | 'cacheWriteTokens';
type MissingRoundKey = 'cachedTokensMissingRounds' | 'freshInputTokensMissingRounds' | 'cacheWriteTokensMissingRounds';

/** Sum only values actually reported; coverage makes partial aggregates explicit. */
function tokenTotal(requestRows: readonly AiLogRow[], key: TokenCountKey | MissingRoundKey) {
  const values = requestRows.flatMap((row) => {
    const value = row[key];
    return typeof value === 'number' ? [value] : [];
  });
  return {
    sum: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
    reportedRows: values.length,
    unknownRows: requestRows.length - values.length,
  };
}

function coveredTokenTotal(requestRows: readonly AiLogRow[], key: TokenCountKey, missingKey: MissingRoundKey) {
  const missing = tokenTotal(requestRows, missingKey);
  return {
    ...tokenTotal(requestRows, key),
    missingRounds: missing.sum,
    missingRoundsUnknownRows: missing.unknownRows,
  };
}

function sumTokens(requestRows: readonly AiLogRow[]) {
  const totals = {
    prompt: tokenTotal(requestRows, 'promptTokens'),
    completion: tokenTotal(requestRows, 'completionTokens'),
    reportedTotal: tokenTotal(requestRows, 'reportedTotalTokens'),
    reasoning: tokenTotal(requestRows, 'reasoningTokens'),
    cached: coveredTokenTotal(requestRows, 'cachedTokens', 'cachedTokensMissingRounds'),
    freshInput: coveredTokenTotal(requestRows, 'freshInputTokens', 'freshInputTokensMissingRounds'),
    cacheWrite: coveredTokenTotal(requestRows, 'cacheWriteTokens', 'cacheWriteTokensMissingRounds'),
  };
  const emptyCounters = { missingRounds: 0, partialRounds: 0, fallbacks: 0, attempts: 0, calls: 0 };
  // Avoid the passthrough log-row overload: these counters are always numbers.
  const counters = requestRows.reduce<typeof emptyCounters>(
    (acc, row) => ({
      missingRounds: acc.missingRounds + (row.usageMissingRounds ?? 0),
      partialRounds: acc.partialRounds + (row.usagePartialRounds ?? 0),
      fallbacks: acc.fallbacks + (row.providerFallbacks ?? 0),
      attempts: acc.attempts + (row.modelAttempts ?? 0),
      calls: acc.calls + (row.modelCalls ?? 0),
    }),
    emptyCounters,
  );
  return {
    ...counters,
    prompt: totals.prompt.sum,
    completion: totals.completion.sum,
    reportedTotal: totals.reportedTotal.sum,
    reasoning: totals.reasoning.sum,
    cached: totals.cached.sum,
    freshInput: totals.freshInput.sum,
    cacheWrite: totals.cacheWrite.sum,
    cachedMissingRounds: totals.cached.missingRounds,
    tokenCoverage: totals,
  };
}

function providerBreakdown(tallies: LogTallies) {
  const { providerDurations, providerFailures, providerSkips } = tallies;
  const providerKeys = new Set([...providerDurations.keys(), ...providerFailures.keys(), ...providerSkips.keys()]);
  return Object.fromEntries(
    [...providerKeys].sort().map((key) => [
      key,
      {
        ...stats(providerDurations.get(key) ?? []),
        failures: providerFailures.get(key) ?? 0,
        skippedBeforeRequest: providerSkips.get(key) ?? 0,
      },
    ]),
  );
}

function tierBreakdown({ routeDurations, routeFallbacks }: LogTallies) {
  const tierKeys = new Set([...routeDurations.keys(), ...routeFallbacks.keys()]);
  return Object.fromEntries(
    [...tierKeys]
      .sort()
      .map((tier) => [tier, { ...stats(routeDurations.get(tier) ?? []), fallbacks: routeFallbacks.get(tier) ?? 0 }]),
  );
}

export function summarizeAiLogs(rows: readonly AiLogRow[]) {
  const tallies = tallyLogRows(rows);
  const { requestRows } = tallies;
  const values = (key: keyof AiLogRow) =>
    requestRows.flatMap((row) => (typeof row[key] === 'number' ? [row[key] as number] : []));
  return {
    requests: requestRows.length,
    endToEndMs: stats(values('elapsedMs')),
    firstVisibleMs: stats(values('firstVisibleMs')),
    modelMs: stats(values('modelDurationMs')),
    toolMs: stats(values('toolDurationMs')),
    deliveryActionMs: stats(values('deliveryActionMs')),
    outcomes: Object.fromEntries([...tallies.outcomes.entries()].sort()),
    terminations: Object.fromEntries([...tallies.terminations.entries()].sort()),
    tokens: sumTokens(requestRows),
    byProvider: providerBreakdown(tallies),
    byTier: tierBreakdown(tallies),
  };
}
