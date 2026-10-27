// src/services/ai/usage-report-text.ts
// Plain-text rendering of a UsageSummary, in the reader's language. The wording comes from t(lang).aiStats,
// so the CLI (English) and the admin command (Russian or English) print the same report.

import type { Messages } from '../../config/constants.ts';
import { MICRO_USD_PER_USD } from './model-presets.ts';
import type { CostTotals, LastError, ProviderUsage, TokenTotals, UsageStats, UsageSummary } from './usage-report.ts';

type Labels = Messages['aiStats'];

/** Below this many micro-USD a four-decimal dollar amount rounds to zero. */
const SMALLEST_SHOWN_MICRO_USD = 50;

function formatInstant(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

function formatRate(rate: number | null, labels: Labels): string {
  return rate === null ? labels.unknown : `${(rate * 100).toFixed(1)}%`;
}

function formatCounts(counts: { [key: string]: number | undefined }): string {
  return Object.entries(counts)
    .flatMap(([key, count]) => (count ? [`${key} ${count}`] : []))
    .join(', ');
}

function formatLastError(error: LastError, labels: Labels): string {
  const status = error.httpStatus === null ? '' : ` ${error.httpStatus}`;
  return labels.lastError(error.errorClass, status, formatInstant(error.at));
}

/** A sum of nothing is unknown, shown as a dash: it is never printed as 0. */
function formatTokens(totals: TokenTotals, labels: Labels): string {
  return totals.sum === null ? labels.unknown : String(totals.sum);
}

/** An unknown cost is a dash, a known zero is $0.0000, and a real but tiny cost is never rounded down to zero. */
function formatCost(cost: CostTotals, labels: Labels): string {
  const micro = cost.sumMicroUsd;
  if (micro === null) return labels.unknown;
  if (micro > 0 && micro < SMALLEST_SHOWN_MICRO_USD) return '<$0.0001';
  return `$${(micro / MICRO_USD_PER_USD).toFixed(4)}`;
}

function providerLine(provider: ProviderUsage, labels: Labels): string {
  const sent = provider.ok + provider.errors;
  const rate = formatRate(provider.successRate, labels);
  const verdicts = {
    no_traffic: labels.noTraffic,
    skipped_only: labels.skippedOnly(provider.skipped),
    healthy: labels.healthy(provider.ok, sent, rate),
    degraded: labels.degraded(provider.ok, sent, rate),
    failing: labels.failing(provider.errors),
  };
  const parts = [verdicts[provider.verdict]];
  if (provider.lastOkAt !== null) parts.push(labels.lastOk(formatInstant(provider.lastOkAt)));
  if (provider.lastError) parts.push(formatLastError(provider.lastError, labels));
  return `${provider.provider}: ${parts.join(' · ')}`;
}

/** Token and cost lines of a group that sent at least one request. */
function tokenAndCostLines({ tokens, cost }: UsageStats, labels: Labels): string[] {
  const lines = [`  ${labels.tokens(formatTokens(tokens.prompt, labels), formatTokens(tokens.completion, labels))}`];
  if (tokens.reasoning.reportedRows > 0 || tokens.cached.reportedRows > 0) {
    lines.push(`  ${labels.tokensExtra(formatTokens(tokens.reasoning, labels), formatTokens(tokens.cached, labels))}`);
  }
  const unanswered = Math.max(tokens.prompt.unknownRows, tokens.completion.unknownRows);
  if (unanswered > 0) lines.push(`  ${labels.tokensUnknown(unanswered)}`);
  lines.push(`  ${labels.cost(formatCost(cost, labels))}`);
  // Only a partial sum needs the caveat: a group with no known cost already shows a dash.
  if (cost.sumMicroUsd !== null && cost.unknownRows > 0) lines.push(`  ${labels.costUnknown(cost.unknownRows)}`);
  return lines;
}

/** The lines under a group's heading: counts, errors, tokens, cost, latency, answer range. */
function statsBlock(heading: string, stats: UsageStats, labels: Labels): string[] {
  const lines = [
    heading,
    `  ${labels.counts(stats.ok, stats.errors, stats.skipped, formatRate(stats.successRate, labels))}`,
  ];
  const skipped = formatCounts(stats.skippedByReason);
  if (skipped) lines.push(`  ${labels.skippedBy(skipped)}`);
  const errors = formatCounts(stats.errorsByClass);
  if (errors) lines.push(`  ${labels.errorsBy(errors)}`);
  if (stats.ok + stats.errors > 0) lines.push(...tokenAndCostLines(stats, labels));
  if (stats.p50DurationMs !== null && stats.p95DurationMs !== null) {
    lines.push(`  ${labels.latency(stats.p50DurationMs, stats.p95DurationMs)}`);
  }
  if (stats.firstOkAt !== null && stats.lastOkAt !== null) {
    lines.push(`  ${labels.okRange(formatInstant(stats.firstOkAt), formatInstant(stats.lastOkAt))}`);
  }
  if (stats.lastError) lines.push(`  ${formatLastError(stats.lastError, labels)}`);
  return lines;
}

/** Blocks of statistics separated by a blank line. */
function blocksOf(entries: { heading: string; stats: UsageStats }[], labels: Labels): string[] {
  return entries.flatMap(({ heading, stats }, index) => [
    ...(index > 0 ? [''] : []),
    ...statsBlock(heading, stats, labels),
  ]);
}

export function formatUsageReport(summary: UsageSummary, days: number, labels: Labels): string {
  const sections = [
    labels.title(days, summary.totalAttempts),
    '',
    labels.sectionProviders,
    ...summary.providers.map((provider) => providerLine(provider, labels)),
  ];
  if (summary.roles.length > 0) {
    const roles = summary.roles.map((role) => ({ heading: `${role.role} · ${role.provider}`, stats: role }));
    sections.push('', labels.sectionRoles, ...blocksOf(roles, labels));
  }
  if (summary.models.length > 0) {
    const models = summary.models.map((model) => ({ heading: `${model.provider}:${model.model}`, stats: model }));
    sections.push('', labels.sectionModels, ...blocksOf(models, labels));
  }
  return sections.join('\n');
}
