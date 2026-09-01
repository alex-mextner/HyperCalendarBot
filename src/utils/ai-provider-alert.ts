// src/utils/ai-provider-alert.ts
//
// Admin alerting for AI provider failures.
//
// WHY THIS EXISTS. On 2026-09-01 every provider in the fallback chain broke at
// the same time: z.ai hit its weekly/monthly plan cap (HTTP 429, vendor code
// 1310), Groq had deleted both configured models (HTTP 404), and the Hugging
// Face token had been revoked (HTTP 401). The bot answered nobody for hours and
// the admin got zero alerts, because the previous implementation only fired on a
// handful of "balance exhausted" substrings — none of which those three errors
// contain. The owner learned about the outage from a user complaint.
//
// TWO REQUIREMENTS IN TENSION, BOTH MANDATORY: never go silent during a real
// outage, and never flood the admin's phone. The policy below is the compromise.
//
// THROTTLING POLICY (constants in ALERT_POLICY, reasoning here):
//
//  * Transient failures (ordinary 429 back-off, 5xx, timeouts) NEVER alert on
//    their own. The chain is built to absorb them; alerting on them is the noise
//    that trains the admin to ignore alerts.
//  * Deduplication is per provider AND per failure class, not one global window.
//    "z.ai out of quota" and "Groq model id is stale" are different problems with
//    different fixes and must not silence each other. The previous code used one
//    7-day window per provider: one alert, then a week of silence no matter how
//    the outage changed shape.
//  * Bursts are coalesced, not dropped. The first failure alerts immediately;
//    repeats inside the 10-minute digest window are counted and reported as a
//    single follow-up ("+N more failures"). 10 minutes is long enough to swallow
//    the retry storm from a handful of user messages, short enough that the admin
//    still learns the scale while acting on the first alert.
//  * An unresolved outage escalates instead of repeating or disappearing:
//    re-notification after 15 min, then 1 h, then 4 h, then every 12 h. The first
//    step confirms "still broken, not a blip" while the operator is likely still
//    looking; the widening steps mean an outage nobody can fix quickly (a monthly
//    quota that resets in two days) stays visible without spamming.
//  * A total chain failure — every provider down, the user got no answer — is the
//    loudest event: its ladder starts at 5 min (5 min / 15 min / 1 h / every 3 h)
//    and it is exempt from the hourly ceiling, so the "bot is dead" message can
//    never be the one that gets dropped.
//  * Recovery is announced once per outage, otherwise the admin cannot tell
//    whether it is still broken. To stop a flapping provider from alternating
//    alert/recovery messages, a failure returning within 15 minutes of a recovery
//    resumes the previous outage (escalation ladder intact) instead of alerting
//    as brand new.
//  * Hard ceiling of 6 admin messages per rolling hour. The message that fills
//    the budget says so; anything held back afterwards is counted and reported in
//    the next message that gets through, so nothing is dropped silently. A first
//    alert the ceiling held back does not count as announced, so it is retried on
//    the next failure or when the digest window closes — an outage cannot end up
//    silent just because the ceiling happened to be full at that second.
//
// STATE IS IN MEMORY. The bot is a single process, so a plain Map is enough; the
// state is deliberately not persisted. A restart therefore clears every window,
// which is why the first minute of process life (startupGraceMs) sends nothing:
// a crash-looping process cannot turn each restart into a fresh burst of provider
// alerts. Process crashes have their own alert path in src/index.ts.
//
// The digest uses a single-shot setTimeout on purpose. The repo rule against
// setTimeout covers periodic scheduled work, which must survive restarts as a
// BullMQ repeating job; this timer only coalesces in-memory counters that a
// restart discards anyway.

import OpenAI from 'openai';
import { logger } from './logger.ts';

const alertLogger = logger.child({ module: 'ai-provider-alert' });

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const ALERT_POLICY = {
  digestWindowMs: 10 * MINUTE_MS,
  providerEscalationMs: [15 * MINUTE_MS, HOUR_MS, 4 * HOUR_MS, 12 * HOUR_MS],
  chainEscalationMs: [5 * MINUTE_MS, 15 * MINUTE_MS, HOUR_MS, 3 * HOUR_MS],
  flapGuardMs: 15 * MINUTE_MS,
  maxMessagesPerHour: 6,
  startupGraceMs: MINUTE_MS,
} as const;

// ── Failure classification ─────────────────────────────────────────────────

export type ProviderFailureClass = 'quota_exhausted' | 'auth_failed' | 'model_gone' | 'transient';

export interface ProviderFailure {
  /** Chain slot name as used by streaming.ts, e.g. "Groq (llama-3.3-70b-versatile)". */
  provider: string;
  /** HTTP status when the provider returned one. */
  status?: number;
  message: string;
}

/** Hard caps: the account is out of budget until a human tops up or a period resets. */
const QUOTA_PATTERNS = [
  'limit exhausted',
  'weekly limit',
  'monthly limit',
  'insufficient balance',
  'no resource package',
  'quota exceeded',
  'exceeded your current quota',
  'credit balance is too low',
  'payment required',
  'account is not active',
  'out of credits',
  '"1310"',
];

/** The configured model id is gone or was never visible to this account. */
const MODEL_GONE_PATTERNS = [
  'model_not_found',
  'does not exist or you do not have access',
  'model does not exist',
  'no such model',
  'unknown model',
  'is not a valid model',
  'model not found',
];

/** The key or token is rejected — rotate it. */
const AUTH_PATTERNS = [
  'invalid username or password',
  'invalid api key',
  'incorrect api key',
  'invalid token',
  'api key expired',
  'has been revoked',
  'unauthorized',
  'authentication failed',
  'permission denied',
];

function matchesAny(lowerMessage: string, patterns: string[]): boolean {
  return patterns.some((pattern) => lowerMessage.includes(pattern));
}

/**
 * Classify a provider failure. The HTTP status is the primary signal — message
 * text is only consulted when the status is missing or ambiguous (a 429 can be
 * either an ordinary back-off or a hard monthly cap, and those are opposites).
 */
export function classifyProviderFailure(failure: ProviderFailure): ProviderFailureClass {
  const lower = failure.message.toLowerCase();
  const byStatus = classifyByStatus(failure.status, lower);
  if (byStatus) return byStatus;
  if (matchesAny(lower, QUOTA_PATTERNS)) return 'quota_exhausted';
  if (matchesAny(lower, MODEL_GONE_PATTERNS)) return 'model_gone';
  if (matchesAny(lower, AUTH_PATTERNS)) return 'auth_failed';
  return 'transient';
}

function classifyByStatus(status: number | undefined, lowerMessage: string): ProviderFailureClass | null {
  if (status === undefined) return null;
  if (status === 402) return 'quota_exhausted';
  if (status === 401 || status === 403) {
    return matchesAny(lowerMessage, QUOTA_PATTERNS) ? 'quota_exhausted' : 'auth_failed';
  }
  if (status === 404) return 'model_gone';
  if (status === 429) return matchesAny(lowerMessage, QUOTA_PATTERNS) ? 'quota_exhausted' : 'transient';
  // Groq returns 413 for per-minute token limits ("on tokens per minute (TPM):
  // Limit 12000, Requested 24355" plus a link to its billing page). That is a
  // back-off, not an exhausted budget — the link used to make it look like one.
  if (status === 413 || status >= 500) return 'transient';
  return null;
}

/** Classify a thrown error. Non-Error values carry no trustworthy signal — transient. */
export function classifyProviderError(error: unknown, provider = 'unknown'): ProviderFailureClass {
  if (!(error instanceof Error)) return 'transient';
  const status = error instanceof OpenAI.APIError && typeof error.status === 'number' ? error.status : undefined;
  return classifyProviderFailure({ provider, status, message: error.message });
}

/** True when the provider is out of budget (plan cap, balance, credits). */
export function isBalanceExhausted(error: unknown): boolean {
  return classifyProviderError(error) === 'quota_exhausted';
}

// ── Dependencies ───────────────────────────────────────────────────────────

export interface AlertDeps {
  botToken: string;
  adminId: number;
  /** Overridden in tests. Fire-and-forget: must not throw. */
  send?: (html: string) => void;
  /** Overridden in tests. */
  now?: () => number;
  /** Single-shot timer for digest flushes. Overridden in tests. */
  schedule?: (fn: () => void, delayMs: number) => void;
}

interface ResolvedDeps {
  send: (html: string) => void;
  now: () => number;
  schedule: (fn: () => void, delayMs: number) => void;
}

let deps: ResolvedDeps | null = null;
let initializedAt = 0;

function telegramSender(botToken: string, adminId: number): (html: string) => void {
  return (html) => {
    fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: adminId, text: html, parse_mode: 'HTML' }),
    }).catch((err) => {
      alertLogger.warn({ err }, 'Failed to send AI provider alert to admin');
    });
  };
}

/** Call once at startup. Without it every report is a no-op (dev/test without an admin). */
export function initProviderAlerts(config: AlertDeps): void {
  deps = {
    send: config.send ?? telegramSender(config.botToken, config.adminId),
    now: config.now ?? Date.now,
    schedule:
      config.schedule ??
      ((fn, delayMs) => {
        setTimeout(fn, delayMs).unref();
      }),
  };
  initializedAt = deps.now();
  outages.clear();
  sentAtMs.length = 0;
  heldBackCount = 0;
}

/** Test helper: drop all throttling state and the configured transport. */
export function resetProviderAlertState(): void {
  deps = null;
  initializedAt = 0;
  outages.clear();
  sentAtMs.length = 0;
  heldBackCount = 0;
}

// ── Outage state ───────────────────────────────────────────────────────────

type OutageKind = 'provider' | 'chain';

interface OutageState {
  kind: OutageKind;
  provider: string;
  failureClass: ProviderFailureClass;
  failures: ProviderFailure[];
  firstSeenAt: number;
  occurrences: number;
  lastAlertAt: number;
  alertsSent: number;
  suppressedSinceAlert: number;
  digestPending: boolean;
  resolvedAt: number | null;
}

const outages = new Map<string, OutageState>();
const sentAtMs: number[] = [];
let heldBackCount = 0;

const CHAIN_KEY = 'chain:all-providers';

/** "Groq (llama-3.3-70b-versatile)" → "groq" — the model id must not split the dedup key. */
function providerFamily(provider: string): string {
  return providerLabel(provider).toLowerCase();
}

function newOutage(kind: OutageKind, provider: string, failureClass: ProviderFailureClass, now: number): OutageState {
  return {
    kind,
    provider,
    failureClass,
    failures: [],
    firstSeenAt: now,
    occurrences: 0,
    lastAlertAt: 0,
    alertsSent: 0,
    suppressedSinceAlert: 0,
    digestPending: false,
    resolvedAt: null,
  };
}

function restartOutage(state: OutageState, now: number): void {
  state.firstSeenAt = now;
  state.occurrences = 0;
  state.lastAlertAt = 0;
  state.alertsSent = 0;
  state.suppressedSinceAlert = 0;
}

// ── Reporting API ──────────────────────────────────────────────────────────

/**
 * Report one provider slot failing. Transient failures are absorbed silently —
 * the chain handles them. Quota, auth and stale-model failures need a human, so
 * they alert under the throttling policy documented at the top of this file.
 */
export function reportProviderFailure(failure: ProviderFailure): void {
  const failureClass = classifyProviderFailure(failure);
  if (failureClass === 'transient') return;
  const key = `provider:${providerFamily(failure.provider)}:${failureClass}`;
  noteFailure(key, 'provider', failure.provider, failureClass, [failure]);
}

/**
 * Report that the whole fallback chain failed and the user got no answer.
 * This is the alert that matters most, so it escalates fastest and is never
 * dropped by the hourly ceiling.
 */
export function reportAllProvidersFailed(failures: ProviderFailure[]): void {
  noteFailure(CHAIN_KEY, 'chain', 'all providers', 'transient', failures);
}

/** Report that a provider answered successfully — closes its outages and the chain outage. */
export function reportProviderRecovered(provider: string): void {
  if (!deps) return;
  const now = deps.now();
  const family = providerFamily(provider);
  for (const [key, state] of outages) {
    if (state.resolvedAt !== null) continue;
    const isThisProvider = state.kind === 'provider' && key.startsWith(`provider:${family}:`);
    if (!isThisProvider && state.kind !== 'chain') continue;
    resolveOutage(state, now);
  }
}

function noteFailure(
  key: string,
  kind: OutageKind,
  provider: string,
  failureClass: ProviderFailureClass,
  failures: ProviderFailure[],
): void {
  if (!deps) return;
  const now = deps.now();
  if (now - initializedAt < ALERT_POLICY.startupGraceMs) {
    alertLogger.warn({ provider, failureClass }, 'Provider failure inside startup grace window — not alerting');
    return;
  }

  const state = outages.get(key) ?? newOutage(kind, provider, failureClass, now);
  outages.set(key, state);
  applyFlapGuard(state, now);
  state.provider = provider;
  state.failures = failures;
  state.occurrences += 1;

  // An alert the ceiling held back must not count as announced, otherwise the
  // outage would silently move on to the escalation ladder having said nothing.
  if (shouldAlertNow(state, now) && sendOutageAlert(state, now)) return;
  state.suppressedSinceAlert += 1;
  scheduleDigest(key, state);
}

/**
 * A failure arriving long after a recovery is a brand-new outage (alerts at
 * once); one arriving right after a recovery is the same flapping outage
 * resuming, and keeps the escalation ladder so it cannot ping-pong.
 */
function applyFlapGuard(state: OutageState, now: number): void {
  if (state.resolvedAt === null) return;
  const sinceRecovery = now - state.resolvedAt;
  state.resolvedAt = null;
  if (sinceRecovery >= ALERT_POLICY.flapGuardMs) restartOutage(state, now);
}

function shouldAlertNow(state: OutageState, now: number): boolean {
  if (state.alertsSent === 0) return true;
  const ladder = state.kind === 'chain' ? ALERT_POLICY.chainEscalationMs : ALERT_POLICY.providerEscalationMs;
  const step = Math.min(state.alertsSent - 1, ladder.length - 1);
  const waitMs = ladder[step] ?? ALERT_POLICY.providerEscalationMs[0];
  return now - state.lastAlertAt >= waitMs;
}

/** Returns false when the hourly ceiling held the message back. */
function sendOutageAlert(state: OutageState, now: number): boolean {
  const text = state.kind === 'chain' ? renderChainAlert(state, now) : renderProviderAlert(state, now);
  if (!sendAdminMessage(text, state.kind === 'chain' ? 'critical' : 'normal')) return false;
  state.lastAlertAt = now;
  state.alertsSent += 1;
  state.suppressedSinceAlert = 0;
  return true;
}

function scheduleDigest(key: string, state: OutageState): void {
  if (state.digestPending || !deps) return;
  state.digestPending = true;
  deps.schedule(() => flushDigest(key), ALERT_POLICY.digestWindowMs);
}

function flushDigest(key: string): void {
  const state = outages.get(key);
  if (!deps || !state) return;
  state.digestPending = false;
  if (state.suppressedSinceAlert === 0) return;
  // An outage that never got its first alert out (the ceiling held it back) is
  // announced in full here — a "+N more" digest of something the admin was
  // never told about would be meaningless.
  const sent =
    state.alertsSent === 0 ? sendOutageAlert(state, deps.now()) : sendAdminMessage(renderDigest(state), 'normal');
  // Keep counting when the send was held back, so nothing is lost silently.
  if (sent) state.suppressedSinceAlert = 0;
}

function resolveOutage(state: OutageState, now: number): void {
  const announced = state.alertsSent > 0;
  state.resolvedAt = now;
  state.suppressedSinceAlert = 0;
  if (announced) sendAdminMessage(renderRecovery(state, now), 'normal');
}

// ── Sending, with the hourly ceiling ───────────────────────────────────────

/** Returns true when the message actually went out. */
function sendAdminMessage(html: string, priority: 'normal' | 'critical'): boolean {
  if (!deps) return false;
  const now = deps.now();
  pruneSendLog(now);

  if (sentAtMs.length >= ALERT_POLICY.maxMessagesPerHour && priority === 'normal') {
    heldBackCount += 1;
    alertLogger.warn({ heldBackCount }, 'Admin alert held back by the hourly ceiling');
    return false;
  }

  let body = html;
  if (heldBackCount > 0) {
    body += `\n\n<i>${countOf(heldBackCount, 'earlier alert')} held back while the hourly ceiling was full.</i>`;
    heldBackCount = 0;
  }
  sentAtMs.push(now);
  if (sentAtMs.length === ALERT_POLICY.maxMessagesPerHour) {
    body +=
      `\n\n<i>Alert ceiling reached — ${ALERT_POLICY.maxMessagesPerHour} messages this hour. ` +
      'Further provider alerts are held back and counted; a total outage still gets through.</i>';
  }
  deps.send(body);
  return true;
}

function pruneSendLog(now: number): void {
  while (sentAtMs.length > 0 && now - (sentAtMs[0] ?? 0) >= HOUR_MS) sentAtMs.shift();
}

// ── Rendering ──────────────────────────────────────────────────────────────
// Front-loaded headlines: phone notification previews cut off after a few
// words, so the provider name and the problem come first, never a generic
// "Alert:" label.

const CLASS_HEADLINE: Record<ProviderFailureClass, string> = {
  quota_exhausted: 'quota exhausted',
  auth_failed: 'key rejected',
  model_gone: 'model missing',
  transient: 'temporary failure',
};

const CLASS_EMOJI: Record<ProviderFailureClass, string> = {
  quota_exhausted: '💸',
  auth_failed: '🔑',
  model_gone: '🗑',
  transient: '⚠️',
};

interface ProviderEnvNames {
  apiKey: string;
  model: string;
}

function envNames(provider: string): ProviderEnvNames {
  const family = providerFamily(provider);
  if (family.startsWith('z.ai')) return { apiKey: 'ZAI_API_KEY', model: 'ZAI_MODEL / ZAI_FAST_MODEL' };
  if (family.startsWith('groq')) return { apiKey: 'GROQ_API_KEY', model: 'GROQ_MODEL / GROQ_FAST_MODEL' };
  if (family.startsWith('gemini')) return { apiKey: 'GEMINI_API_KEY', model: 'GEMINI_MODEL / GEMINI_FAST_MODEL' };
  if (family.startsWith('hf')) return { apiKey: 'HF_TOKEN', model: 'HF_MODEL / HF_FAST_MODEL' };
  return { apiKey: 'the provider API key', model: 'the configured model id' };
}

function actionHint(provider: string, failureClass: ProviderFailureClass): string {
  const env = envNames(provider);
  switch (failureClass) {
    case 'quota_exhausted':
      return `The plan budget is spent — top it up or wait for the quota window to reset. Until then this provider stays down.`;
    case 'auth_failed':
      return `Issue a new key and update ${env.apiKey} in the .env file on the server, then redeploy.`;
    case 'model_gone':
      return `The configured model id no longer exists — pick a current one and update ${env.model} in the .env file.`;
    case 'transient':
      return 'Temporary provider failure, no action needed unless it keeps repeating.';
  }
}

function renderProviderAlert(state: OutageState, now: number): string {
  const failure = state.failures[0];
  const headline = `${CLASS_EMOJI[state.failureClass]} <b>${escapeHtml(providerLabel(state.provider))} ${CLASS_HEADLINE[state.failureClass]}</b>`;
  const repeat =
    state.alertsSent > 0
      ? `\nStill broken after ${formatDuration(now - state.firstSeenAt)} — ${countOf(state.occurrences, 'failure')} so far.`
      : '';
  return [
    headline,
    '',
    `Provider: <code>${escapeHtml(state.provider)}</code>`,
    failure?.status ? `HTTP status: ${failure.status}` : 'HTTP status: none (network or client-side failure)',
    `Error: <code>${escapeHtml(truncate(failure?.message ?? '', 300))}</code>`,
    `Do this: ${escapeHtml(actionHint(state.provider, state.failureClass))}`,
    `The chain fell back to the next provider, so users may still be answered.${repeat}`,
  ].join('\n');
}

function renderChainAlert(state: OutageState, now: number): string {
  const lines = state.failures.map((failure) => {
    const failureClass = classifyProviderFailure(failure);
    const status = failure.status ? `HTTP ${failure.status}` : 'no HTTP status';
    return `• <code>${escapeHtml(failure.provider)}</code> — ${CLASS_HEADLINE[failureClass]} (${status}): <code>${escapeHtml(truncate(failure.message, 200))}</code>`;
  });
  const actions = chainActions(state.failures);
  const repeat =
    state.alertsSent > 0
      ? `\n\nStill down after ${formatDuration(now - state.firstSeenAt)} — ${countOf(state.occurrences, 'user request')} failed.`
      : '';
  return [
    '🚨 <b>All AI providers failed — users get no answer</b>',
    '',
    ...lines,
    '',
    'Do this:',
    ...actions.map((action) => `• ${escapeHtml(action)}`),
    repeat,
  ]
    .join('\n')
    .trimEnd();
}

function chainActions(failures: ProviderFailure[]): string[] {
  const actions: string[] = [];
  const seen = new Set<string>();
  for (const failure of failures) {
    const failureClass = classifyProviderFailure(failure);
    if (failureClass === 'transient') continue;
    const family = providerFamily(failure.provider);
    if (seen.has(family)) continue;
    seen.add(family);
    actions.push(`${providerLabel(failure.provider)}: ${actionHint(failure.provider, failureClass)}`);
  }
  if (actions.length === 0) actions.push('Every provider failed temporarily — check the provider status pages.');
  return actions;
}

function renderDigest(state: OutageState): string {
  const what = state.kind === 'chain' ? 'Every provider' : providerLabel(state.provider);
  const reason = state.kind === 'chain' ? 'complete chain failure' : CLASS_HEADLINE[state.failureClass];
  return (
    `📉 <b>${escapeHtml(what)} still failing — ${countOf(state.suppressedSinceAlert, 'more failure')}</b>\n\n` +
    `The same problem (${reason}) repeated ${countOf(state.suppressedSinceAlert, 'time')} in the last ` +
    `${formatDuration(ALERT_POLICY.digestWindowMs)}. The next full alert comes only if it is still broken later.`
  );
}

function renderRecovery(state: OutageState, now: number): string {
  const what = state.kind === 'chain' ? 'AI chain' : providerLabel(state.provider);
  const reason = state.kind === 'chain' ? 'complete chain failure' : CLASS_HEADLINE[state.failureClass];
  return (
    `✅ <b>${escapeHtml(what)} working again</b>\n\n` +
    `Was failing for ${formatDuration(now - state.firstSeenAt)} (${reason}), ` +
    `${countOf(state.occurrences, 'failure')}. No action needed unless it comes back.`
  );
}

/** Display name without the model suffix, original casing: "HF (Qwen/...)" → "HF". */
function providerLabel(provider: string): string {
  return (provider.split('(')[0] ?? provider).trim();
}

function countOf(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / MINUTE_MS);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))} sec`;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
