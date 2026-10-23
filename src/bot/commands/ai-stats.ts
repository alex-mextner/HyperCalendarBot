// src/bot/commands/ai-stats.ts

import { t, toLang } from '../../config/constants.ts';
import type { AiUsageRepository } from '../../database/repositories/ai-usage.repository.ts';
import { parseReportDays, summarizeAiUsage } from '../../services/ai/usage-report.ts';
import { formatUsageReport } from '../../services/ai/usage-report-text.ts';
import { escapeHtml, splitMessage } from '../../utils/telegram.ts';
import type { BotCommandContext } from '../types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * /ai_stats [days] — admin-only: per provider:model attempts, errors, tokens and latency from the
 * durable AI usage ledger, with one verdict per provider. Without a configured admin nobody passes.
 */
export async function handleAiStats(
  ctx: BotCommandContext,
  usage: Pick<AiUsageRepository, 'iterateSince'>,
  adminId?: number,
): Promise<void> {
  const user = ctx.dbUser;
  if (!user) return;
  const messages = t(toLang(user.language)).aiStats;

  if (!adminId || user.telegram_id !== adminId) {
    await ctx.send(messages.adminOnly);
    return;
  }

  const raw = (ctx.args ?? '').trim();
  const days = parseReportDays(raw === '' ? undefined : raw);
  if (days === null) {
    await ctx.send(messages.usage);
    return;
  }

  const untilMs = Date.now();
  const window = { sinceMs: untilMs - days * DAY_MS, untilMs };
  const summary = summarizeAiUsage(usage.iterateSince(window.sinceMs), window);
  const html = `<pre>${escapeHtml(formatUsageReport(summary, days, messages))}</pre>`;
  for (const part of splitMessage(html, 4000, 'HTML')) {
    await ctx.send(part, { parse_mode: 'HTML' });
  }
}
