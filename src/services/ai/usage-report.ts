// src/services/ai/usage-report.ts
// Pure aggregation of AI usage rows into per provider:model statistics and one verdict per provider.
// Shared by scripts/report-ai-usage.ts and the admin command /ai_stats; formatting lives with each of them.

import {
  AI_USAGE_RETENTION_DAYS,
  type AiErrorClass,
  type AiSkipReason,
  type AiUsageEvent,
} from '../../database/repositories/ai-usage.repository.ts';
import { PROVIDER_IDS } from './provider-ids.ts';

/** Share of attempts that reached the provider and were answered, below which a provider counts as degraded. */
const DEGRADED_BELOW_SUCCESS_RATE = 0.9;

const DEFAULT_REPORT_DAYS = 7;

/** The report window in days: a whole number from 1 to the retention horizon, a week when absent, null when invalid. */
export function parseReportDays(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return DEFAULT_REPORT_DAYS;
  if (!/^\d+$/.test(raw)) return null;
  const days = Number.parseInt(raw, 10);
  return days >= 1 && days <= AI_USAGE_RETENTION_DAYS ? days : null;
}

export type ProviderVerdictKind = 'no_traffic' | 'skipped_only' | 'healthy' | 'degraded' | 'failing';

export interface UsageWindow {
  sinceMs: number;
  untilMs: number;
}

/**
 * One token field over a group's rows. `sum` covers every row that reported a value (a failed attempt
 * that was billed counts); it is null when none did. `unknownRows` counts answered rows that did not
 * report the field: those are unknown, not zero, and are never added to the sum.
 */
export interface TokenTotals {
  sum: number | null;
  reportedRows: number;
  unknownRows: number;
}

export interface ModelUsage {
  provider: string;
  model: string;
  attempts: number;
  ok: number;
  errors: number;
  skipped: number;
  errorsByClass: { [errorClass in AiErrorClass]?: number };
  skippedByReason: { [reason in AiSkipReason]?: number };
  /** Answered over answered + failed; skips never reached the provider. Null when nothing was sent. */
  successRate: number | null;
  tokens: { prompt: TokenTotals; completion: TokenTotals; reasoning: TokenTotals; cached: TokenTotals };
  /** Nearest-rank percentiles over the durations of answered attempts. */
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  firstOkAt: number | null;
  lastOkAt: number | null;
  lastError: LastError | null;
}

export interface LastError {
  errorClass: AiErrorClass;
  httpStatus: number | null;
  at: number;
}

export interface ProviderUsage {
  provider: string;
  verdict: ProviderVerdictKind;
  attempts: number;
  ok: number;
  errors: number;
  skipped: number;
  successRate: number | null;
  lastOkAt: number | null;
  lastError: LastError | null;
}

export interface UsageSummary {
  window: UsageWindow;
  totalAttempts: number;
  models: ModelUsage[];
  /** Every known provider, in chain-config order, then any other id found in the rows. */
  providers: ProviderUsage[];
}

type TokenField = 'promptTokens' | 'completionTokens' | 'reasoningTokens' | 'cachedTokens';

interface Accumulator {
  provider: string;
  model: string;
  ok: number;
  errors: number;
  skipped: number;
  errorsByClass: { [errorClass in AiErrorClass]?: number };
  skippedByReason: { [reason in AiSkipReason]?: number };
  okDurations: number[];
  tokenSums: { [field in TokenField]: { sum: number; reported: number; unknown: number } };
  firstOkAt: number | null;
  lastOkAt: number | null;
  lastError: LastError | null;
}

function newAccumulator(provider: string, model: string): Accumulator {
  const tokens = () => ({ sum: 0, reported: 0, unknown: 0 });
  return {
    provider,
    model,
    ok: 0,
    errors: 0,
    skipped: 0,
    errorsByClass: {},
    skippedByReason: {},
    okDurations: [],
    tokenSums: {
      promptTokens: tokens(),
      completionTokens: tokens(),
      reasoningTokens: tokens(),
      cachedTokens: tokens(),
    },
    firstOkAt: null,
    lastOkAt: null,
    lastError: null,
  };
}

const TOKEN_FIELDS: TokenField[] = ['promptTokens', 'completionTokens', 'reasoningTokens', 'cachedTokens'];

function add(acc: Accumulator, event: AiUsageEvent): void {
  if (event.outcome === 'skipped') {
    acc.skipped++;
    if (event.skipReason) acc.skippedByReason[event.skipReason] = (acc.skippedByReason[event.skipReason] ?? 0) + 1;
    return;
  }
  for (const field of TOKEN_FIELDS) {
    const value = event[field];
    const totals = acc.tokenSums[field];
    if (value !== null) {
      totals.sum += value;
      totals.reported++;
    } else if (event.outcome === 'ok') {
      totals.unknown++;
    }
  }
  if (event.outcome === 'ok') {
    acc.ok++;
    if (event.durationMs !== null) acc.okDurations.push(event.durationMs);
    acc.firstOkAt = acc.firstOkAt === null ? event.at : Math.min(acc.firstOkAt, event.at);
    acc.lastOkAt = acc.lastOkAt === null ? event.at : Math.max(acc.lastOkAt, event.at);
    return;
  }
  acc.errors++;
  const errorClass = event.errorClass ?? 'other';
  acc.errorsByClass[errorClass] = (acc.errorsByClass[errorClass] ?? 0) + 1;
  if (acc.lastError === null || event.at >= acc.lastError.at) {
    acc.lastError = { errorClass, httpStatus: event.httpStatus, at: event.at };
  }
}

function successRateOf(ok: number, errors: number): number | null {
  return ok + errors === 0 ? null : ok / (ok + errors);
}

function nearestRank(sorted: number[], quantile: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)] ?? null;
}

function totalsOf(entry: Accumulator['tokenSums'][TokenField]): TokenTotals {
  return { sum: entry.reported === 0 ? null : entry.sum, reportedRows: entry.reported, unknownRows: entry.unknown };
}

function modelUsageOf(acc: Accumulator): ModelUsage {
  const sortedDurations = [...acc.okDurations].sort((a, b) => a - b);
  return {
    provider: acc.provider,
    model: acc.model,
    attempts: acc.ok + acc.errors + acc.skipped,
    ok: acc.ok,
    errors: acc.errors,
    skipped: acc.skipped,
    errorsByClass: acc.errorsByClass,
    skippedByReason: acc.skippedByReason,
    successRate: successRateOf(acc.ok, acc.errors),
    tokens: {
      prompt: totalsOf(acc.tokenSums.promptTokens),
      completion: totalsOf(acc.tokenSums.completionTokens),
      reasoning: totalsOf(acc.tokenSums.reasoningTokens),
      cached: totalsOf(acc.tokenSums.cachedTokens),
    },
    p50DurationMs: nearestRank(sortedDurations, 0.5),
    p95DurationMs: nearestRank(sortedDurations, 0.95),
    firstOkAt: acc.firstOkAt,
    lastOkAt: acc.lastOkAt,
    lastError: acc.lastError,
  };
}

function verdictOf(usage: Pick<ProviderUsage, 'attempts' | 'ok' | 'errors' | 'successRate'>): ProviderVerdictKind {
  if (usage.attempts === 0) return 'no_traffic';
  if (usage.ok + usage.errors === 0) return 'skipped_only';
  if (usage.ok === 0) return 'failing';
  return (usage.successRate ?? 1) < DEGRADED_BELOW_SUCCESS_RATE ? 'degraded' : 'healthy';
}

function providerUsageOf(provider: string, models: ModelUsage[]): ProviderUsage {
  const own = models.filter((model) => model.provider === provider);
  const ok = own.reduce((sum, model) => sum + model.ok, 0);
  const errors = own.reduce((sum, model) => sum + model.errors, 0);
  const skipped = own.reduce((sum, model) => sum + model.skipped, 0);
  const successRate = successRateOf(ok, errors);
  const okTimes = own.flatMap((model) => (model.lastOkAt === null ? [] : [model.lastOkAt]));
  const lastError = own.reduce<LastError | null>(
    (latest, model) =>
      model.lastError && (latest === null || model.lastError.at >= latest.at) ? model.lastError : latest,
    null,
  );
  const usage = { attempts: ok + errors + skipped, ok, errors, successRate };
  return {
    provider,
    verdict: verdictOf(usage),
    ...usage,
    skipped,
    lastOkAt: okTimes.length === 0 ? null : Math.max(...okTimes),
    lastError,
  };
}

export function summarizeAiUsage(events: Iterable<AiUsageEvent>, window: UsageWindow): UsageSummary {
  const groups = new Map<string, Accumulator>();
  let totalAttempts = 0;
  for (const event of events) {
    totalAttempts++;
    const key = `${event.provider}\u0000${event.model}`;
    let acc = groups.get(key);
    if (!acc) {
      acc = newAccumulator(event.provider, event.model);
      groups.set(key, acc);
    }
    add(acc, event);
  }

  const providerOrder: string[] = [...PROVIDER_IDS];
  const rank = (provider: string) => {
    const index = providerOrder.indexOf(provider);
    return index === -1 ? providerOrder.length : index;
  };
  const models = [...groups.values()]
    .map(modelUsageOf)
    .sort(
      (a, b) =>
        rank(a.provider) - rank(b.provider) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
    );
  const providerIds = [
    ...providerOrder,
    ...new Set(models.map((m) => m.provider).filter((p) => !providerOrder.includes(p))),
  ];

  return { window, totalAttempts, models, providers: providerIds.map((provider) => providerUsageOf(provider, models)) };
}
