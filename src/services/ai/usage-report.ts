// src/services/ai/usage-report.ts
// Pure aggregation of AI usage rows into per provider:model statistics, a per role and provider view with
// cost and latency, and one verdict per provider. Shared by scripts/report-ai-usage.ts and the admin command
// /ai_stats; formatting lives with each of them.

import {
  AI_USAGE_RETENTION_DAYS,
  type AiErrorClass,
  type AiSkipReason,
  type AiUsageEvent,
} from '../../database/repositories/ai-usage.repository.ts';
import { MODEL_ROLES } from './model-presets.ts';
import { PROVIDER_IDS } from './provider-ids.ts';

/** Share of attempts that reached the provider and were answered, below which a provider counts as degraded. */
const DEGRADED_BELOW_SUCCESS_RATE = 0.9;

const DEFAULT_REPORT_DAYS = 7;

/** What the role view calls the attempts that no role served: the legacy smart and fast chains. */
export const LEGACY_ROLE = 'legacy';

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

/**
 * Cost in micro-USD over a group's rows. `sumMicroUsd` is null when no row had a known cost; a known zero
 * is a zero. `unknownRows` counts answered rows whose cost is unknown (nothing reported, no price for the
 * route): they are not in the sum and are never shown as zero.
 */
export interface CostTotals {
  sumMicroUsd: number | null;
  reportedRows: number;
  unknownRows: number;
}

/** Counts, errors, tokens, cost and latency of one group of attempts. */
export interface UsageStats {
  attempts: number;
  ok: number;
  errors: number;
  skipped: number;
  errorsByClass: { [errorClass in AiErrorClass]?: number };
  skippedByReason: { [reason in AiSkipReason]?: number };
  /** Answered over answered + failed; skips never reached the provider. Null when nothing was sent. */
  successRate: number | null;
  tokens: { prompt: TokenTotals; completion: TokenTotals; reasoning: TokenTotals; cached: TokenTotals };
  cost: CostTotals;
  /** Nearest-rank percentiles over the durations of answered attempts. */
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  firstOkAt: number | null;
  lastOkAt: number | null;
  lastError: LastError | null;
}

export interface ModelUsage extends UsageStats {
  provider: string;
  model: string;
}

/** One routing role on one provider; `role` is `legacy` for attempts that no role served. */
export interface RoleUsage extends UsageStats {
  role: string;
  provider: string;
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
  /** Empty unless some attempt in the window was served by a role: without roles the report is the legacy one. */
  roles: RoleUsage[];
  /** Every known provider, in chain-config order, then any other id found in the rows. */
  providers: ProviderUsage[];
}

type TokenField = 'promptTokens' | 'completionTokens' | 'reasoningTokens' | 'cachedTokens';

interface Counter {
  sum: number;
  reported: number;
  unknown: number;
}

interface Accumulator {
  ok: number;
  errors: number;
  skipped: number;
  errorsByClass: { [errorClass in AiErrorClass]?: number };
  skippedByReason: { [reason in AiSkipReason]?: number };
  okDurations: number[];
  tokenSums: { [field in TokenField]: Counter };
  cost: Counter;
  firstOkAt: number | null;
  lastOkAt: number | null;
  lastError: LastError | null;
}

function newAccumulator(): Accumulator {
  const counter = (): Counter => ({ sum: 0, reported: 0, unknown: 0 });
  return {
    ok: 0,
    errors: 0,
    skipped: 0,
    errorsByClass: {},
    skippedByReason: {},
    okDurations: [],
    tokenSums: {
      promptTokens: counter(),
      completionTokens: counter(),
      reasoningTokens: counter(),
      cachedTokens: counter(),
    },
    cost: counter(),
    firstOkAt: null,
    lastOkAt: null,
    lastError: null,
  };
}

const TOKEN_FIELDS: TokenField[] = ['promptTokens', 'completionTokens', 'reasoningTokens', 'cachedTokens'];

function tally(counter: Counter, value: number | null, answered: boolean): void {
  if (value !== null) {
    counter.sum += value;
    counter.reported++;
  } else if (answered) {
    counter.unknown++;
  }
}

function addAnswered(acc: Accumulator, event: AiUsageEvent): void {
  acc.ok++;
  if (event.durationMs !== null) acc.okDurations.push(event.durationMs);
  acc.firstOkAt = acc.firstOkAt === null ? event.at : Math.min(acc.firstOkAt, event.at);
  acc.lastOkAt = acc.lastOkAt === null ? event.at : Math.max(acc.lastOkAt, event.at);
}

function addFailed(acc: Accumulator, event: AiUsageEvent): void {
  acc.errors++;
  const errorClass = event.errorClass ?? 'other';
  acc.errorsByClass[errorClass] = (acc.errorsByClass[errorClass] ?? 0) + 1;
  if (acc.lastError === null || event.at >= acc.lastError.at) {
    acc.lastError = { errorClass, httpStatus: event.httpStatus, at: event.at };
  }
}

function add(acc: Accumulator, event: AiUsageEvent): void {
  if (event.outcome === 'skipped') {
    acc.skipped++;
    if (event.skipReason) acc.skippedByReason[event.skipReason] = (acc.skippedByReason[event.skipReason] ?? 0) + 1;
    return;
  }
  const answered = event.outcome === 'ok';
  for (const field of TOKEN_FIELDS) tally(acc.tokenSums[field], event[field], answered);
  tally(acc.cost, event.costMicroUsd, answered);
  if (answered) addAnswered(acc, event);
  else addFailed(acc, event);
}

function successRateOf(ok: number, errors: number): number | null {
  return ok + errors === 0 ? null : ok / (ok + errors);
}

function nearestRank(sorted: number[], quantile: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)] ?? null;
}

function totalsOf(entry: Counter): TokenTotals {
  return { sum: entry.reported === 0 ? null : entry.sum, reportedRows: entry.reported, unknownRows: entry.unknown };
}

function costOf(entry: Counter): CostTotals {
  return {
    sumMicroUsd: entry.reported === 0 ? null : entry.sum,
    reportedRows: entry.reported,
    unknownRows: entry.unknown,
  };
}

function statsOf(acc: Accumulator): UsageStats {
  const sortedDurations = [...acc.okDurations].sort((a, b) => a - b);
  return {
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
    cost: costOf(acc.cost),
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

const ROLE_ORDER: readonly string[] = [...MODEL_ROLES, LEGACY_ROLE];

export function summarizeAiUsage(events: Iterable<AiUsageEvent>, window: UsageWindow): UsageSummary {
  const modelGroups = new Map<string, { provider: string; model: string; acc: Accumulator }>();
  const roleGroups = new Map<string, { role: string; provider: string; acc: Accumulator }>();
  let totalAttempts = 0;
  for (const event of events) {
    totalAttempts++;
    const modelKey = `${event.provider}\u0000${event.model}`;
    let modelGroup = modelGroups.get(modelKey);
    if (!modelGroup) {
      modelGroup = { provider: event.provider, model: event.model, acc: newAccumulator() };
      modelGroups.set(modelKey, modelGroup);
    }
    add(modelGroup.acc, event);

    const role = event.role ?? LEGACY_ROLE;
    const roleKey = `${role}\u0000${event.provider}`;
    let roleGroup = roleGroups.get(roleKey);
    if (!roleGroup) {
      roleGroup = { role, provider: event.provider, acc: newAccumulator() };
      roleGroups.set(roleKey, roleGroup);
    }
    add(roleGroup.acc, event);
  }

  const providerOrder: string[] = [...PROVIDER_IDS];
  const rankIn = (order: readonly string[], value: string) => {
    const index = order.indexOf(value);
    return index === -1 ? order.length : index;
  };
  const byProvider = (a: { provider: string }, b: { provider: string }) =>
    rankIn(providerOrder, a.provider) - rankIn(providerOrder, b.provider) || a.provider.localeCompare(b.provider);
  const models: ModelUsage[] = [...modelGroups.values()]
    .map(({ provider, model, acc }) => ({ provider, model, ...statsOf(acc) }))
    .sort((a, b) => byProvider(a, b) || a.model.localeCompare(b.model));
  // Roles exist only on rows written by role routing; without any, the legacy report is unchanged.
  const roles: RoleUsage[] = [...roleGroups.values()].some((group) => group.role !== LEGACY_ROLE)
    ? [...roleGroups.values()]
        .map(({ role, provider, acc }) => ({ role, provider, ...statsOf(acc) }))
        .sort((a, b) => rankIn(ROLE_ORDER, a.role) - rankIn(ROLE_ORDER, b.role) || byProvider(a, b))
    : [];
  const providerIds = [
    ...providerOrder,
    ...new Set(models.map((m) => m.provider).filter((p) => !providerOrder.includes(p))),
  ];

  return {
    window,
    totalAttempts,
    models,
    roles,
    providers: providerIds.map((provider) => providerUsageOf(provider, models)),
  };
}
