// src/services/ai/usage-report-text.ts
// Plain-text rendering of a UsageSummary, in the reader's language. The wording comes from t(lang).aiStats,
// so the CLI (English) and the admin command (Russian or English) print the same report.

import type { Messages } from '../../config/constants.ts';
import type { LastError, ModelUsage, ProviderUsage, TokenTotals, UsageSummary } from './usage-report.ts';

type Labels = Messages['aiStats'];

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

function modelBlock(model: ModelUsage, labels: Labels): string[] {
  const { tokens } = model;
  const lines = [
    `${model.provider}:${model.model}`,
    `  ${labels.counts(model.ok, model.errors, model.skipped, formatRate(model.successRate, labels))}`,
  ];
  const skipped = formatCounts(model.skippedByReason);
  if (skipped) lines.push(`  ${labels.skippedBy(skipped)}`);
  const errors = formatCounts(model.errorsByClass);
  if (errors) lines.push(`  ${labels.errorsBy(errors)}`);
  if (model.ok + model.errors > 0) {
    lines.push(`  ${labels.tokens(formatTokens(tokens.prompt, labels), formatTokens(tokens.completion, labels))}`);
    if (tokens.reasoning.reportedRows > 0 || tokens.cached.reportedRows > 0) {
      lines.push(
        `  ${labels.tokensExtra(formatTokens(tokens.reasoning, labels), formatTokens(tokens.cached, labels))}`,
      );
    }
    const unanswered = Math.max(tokens.prompt.unknownRows, tokens.completion.unknownRows);
    if (unanswered > 0) lines.push(`  ${labels.tokensUnknown(unanswered)}`);
  }
  if (model.p50DurationMs !== null && model.p95DurationMs !== null) {
    lines.push(`  ${labels.latency(model.p50DurationMs, model.p95DurationMs)}`);
  }
  if (model.firstOkAt !== null && model.lastOkAt !== null) {
    lines.push(`  ${labels.okRange(formatInstant(model.firstOkAt), formatInstant(model.lastOkAt))}`);
  }
  if (model.lastError) lines.push(`  ${formatLastError(model.lastError, labels)}`);
  return lines;
}

export function formatUsageReport(summary: UsageSummary, days: number, labels: Labels): string {
  const sections = [
    labels.title(days, summary.totalAttempts),
    '',
    labels.sectionProviders,
    ...summary.providers.map((provider) => providerLine(provider, labels)),
  ];
  if (summary.models.length > 0) {
    sections.push('', labels.sectionModels);
    summary.models.forEach((model, index) => {
      if (index > 0) sections.push('');
      sections.push(...modelBlock(model, labels));
    });
  }
  return sections.join('\n');
}
