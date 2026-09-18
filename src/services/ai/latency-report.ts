import { z } from 'zod';

const failedProviderSchema = z.object({ provider: z.string(), model: z.string() });
export const AiLogRowSchema = z
  .object({
    msg: z.string().optional(),
    requestId: z.string().optional(),
    userId: z.number().optional(),
    chatId: z.number().optional(),
    elapsedMs: z.number().optional(),
    firstVisibleMs: z.number().nullable().optional(),
    modelDurationMs: z.number().optional(),
    toolDurationMs: z.number().optional(),
    deliveryActionMs: z.number().optional(),
    modelCalls: z.number().optional(),
    modelAttempts: z.number().optional(),
    providerFallbacks: z.number().optional(),
    promptTokens: z.number().optional(),
    completionTokens: z.number().optional(),
    reportedTotalTokens: z.number().optional(),
    reasoningTokens: z.number().optional(),
    cachedTokens: z.number().optional(),
    usageMissingRounds: z.number().optional(),
    usagePartialRounds: z.number().optional(),
    termination: z.string().optional(),
    deliveryOutcome: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    purpose: z.string().optional(),
    providerDurationMs: z.number().nullable().optional(),
    totalDurationMs: z.number().nullable().optional(),
    attemptCount: z.number().optional(),
    fallbackCount: z.number().optional(),
    failedProviders: z.array(failedProviderSchema).optional(),
    success: z.boolean().optional(),
    tier: z.string().optional(),
    durationMs: z.number().optional(),
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
export function summarizeAiLogs(rows: readonly AiLogRow[]) {
  const requestRows: AiLogRow[] = [];
  const providerDurations = new Map<string, number[]>();
  const providerFailures = new Map<string, number>();
  const routeDurations = new Map<string, number[]>();
  const routeFallbacks = new Map<string, number>();
  const outcomes = new Map<string, number>();
  const terminations = new Map<string, number>();

  for (const row of rows) {
    if (row.msg === 'AI request metric' && row.requestId) {
      requestRows.push(row);
      inc(outcomes, row.deliveryOutcome);
      inc(terminations, row.termination);
      continue;
    }
    if (row.msg === 'AI model call metric' && row.requestId) {
      if (row.provider && row.model && typeof row.providerDurationMs === 'number') {
        const key = `${row.provider}:${row.model}`;
        const values = providerDurations.get(key) ?? [];
        values.push(row.providerDurationMs);
        providerDurations.set(key, values);
      }
      for (const failure of row.failedProviders ?? []) inc(providerFailures, `${failure.provider}:${failure.model}`);
      continue;
    }
    if ((row.msg === 'Routing decision' || row.msg === 'Routing decision fallback') && row.tier) {
      if (typeof row.durationMs === 'number') {
        const values = routeDurations.get(row.tier) ?? [];
        values.push(row.durationMs);
        routeDurations.set(row.tier, values);
      }
      if (row.fallback) inc(routeFallbacks, row.tier);
    }
  }

  const values = (key: keyof AiLogRow) =>
    requestRows.flatMap((row) => (typeof row[key] === 'number' ? [row[key] as number] : []));
  type TokenSummary = {
    prompt: number;
    completion: number;
    reportedTotal: number;
    reasoning: number;
    cached: number;
    missingRounds: number;
    partialRounds: number;
    fallbacks: number;
    attempts: number;
    calls: number;
  };
  const tokens = requestRows.reduce<TokenSummary>(
    (acc, row) => ({
      prompt: acc.prompt + (row.promptTokens ?? 0),
      completion: acc.completion + (row.completionTokens ?? 0),
      reportedTotal: acc.reportedTotal + (row.reportedTotalTokens ?? 0),
      reasoning: acc.reasoning + (row.reasoningTokens ?? 0),
      cached: acc.cached + (row.cachedTokens ?? 0),
      missingRounds: acc.missingRounds + (row.usageMissingRounds ?? 0),
      partialRounds: acc.partialRounds + (row.usagePartialRounds ?? 0),
      fallbacks: acc.fallbacks + (row.providerFallbacks ?? 0),
      attempts: acc.attempts + (row.modelAttempts ?? 0),
      calls: acc.calls + (row.modelCalls ?? 0),
    }),
    {
      prompt: 0,
      completion: 0,
      reportedTotal: 0,
      reasoning: 0,
      cached: 0,
      missingRounds: 0,
      partialRounds: 0,
      fallbacks: 0,
      attempts: 0,
      calls: 0,
    },
  );

  const providerKeys = new Set([...providerDurations.keys(), ...providerFailures.keys()]);
  const byProvider = Object.fromEntries(
    [...providerKeys]
      .sort()
      .map((key) => [key, { ...stats(providerDurations.get(key) ?? []), failures: providerFailures.get(key) ?? 0 }]),
  );
  const tierKeys = new Set([...routeDurations.keys(), ...routeFallbacks.keys()]);
  const byTier = Object.fromEntries(
    [...tierKeys]
      .sort()
      .map((tier) => [tier, { ...stats(routeDurations.get(tier) ?? []), fallbacks: routeFallbacks.get(tier) ?? 0 }]),
  );
  return {
    requests: requestRows.length,
    endToEndMs: stats(values('elapsedMs')),
    firstVisibleMs: stats(values('firstVisibleMs')),
    modelMs: stats(values('modelDurationMs')),
    toolMs: stats(values('toolDurationMs')),
    deliveryActionMs: stats(values('deliveryActionMs')),
    outcomes: Object.fromEntries([...outcomes.entries()].sort()),
    terminations: Object.fromEntries([...terminations.entries()].sort()),
    tokens,
    byProvider,
    byTier,
  };
}
