// src/utils/ai-provider-alert.ts
// Alerts the admin via Telegram when an AI provider runs out of balance.
// Deduplicates by provider name with a configurable TTL (default 7 days).

import { logger } from './logger.ts';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Tracks last alert time per provider to avoid spamming. */
const lastAlertAt = new Map<string, number>();

interface AlertDeps {
  botToken: string;
  adminId: number;
}

let alertDeps: AlertDeps | null = null;

/** Call once at startup with bot token and admin ID. */
export function initProviderAlerts(deps: AlertDeps): void {
  alertDeps = deps;
}

/** Returns true if the error indicates an exhausted balance / billing issue. */
export function isBalanceExhausted(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes('insufficient balance') ||
    msg.includes('no resource package') ||
    msg.includes('billing') ||
    msg.includes('quota exceeded') ||
    msg.includes('exceeded your current quota') ||
    msg.includes('payment required')
  );
}

/**
 * Send a Telegram alert to the admin if the provider's balance is exhausted.
 * Deduplicates: same provider won't trigger another alert for `ttlMs` (default 7 days).
 */
export function alertProviderBalanceExhausted(
  providerName: string,
  errorMessage: string,
  ttlMs: number = SEVEN_DAYS_MS,
): void {
  if (!alertDeps) return;

  const now = Date.now();
  const lastSent = lastAlertAt.get(providerName);
  if (lastSent && now - lastSent < ttlMs) return;

  lastAlertAt.set(providerName, now);

  const text = `💸 <b>AI provider balance exhausted</b>\n\nProvider: <code>${escapeHtml(providerName)}</code>\nError: <code>${escapeHtml(errorMessage.slice(0, 300))}</code>\n\nNext alert in 7 days.`;

  fetch(`https://api.telegram.org/bot${alertDeps.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: alertDeps.adminId, text, parse_mode: 'HTML' }),
  }).catch((err) => {
    logger.warn({ err }, 'Failed to send provider balance alert to admin');
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
