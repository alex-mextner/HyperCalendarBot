// src/utils/redact-secrets.ts
//
// One place that removes credentials from text on its way to a log line, a console line or the admin
// alert queue. A leaf module: it imports nothing from the bot, so the logger can use it before config.
//
// Why it exists (#972): Bun's fetch puts the full request URL in `err.path`, and a Telegram request URL
// is `https://api.telegram.org/bot<id>:<secret>/<method>`, so a failed getMe printed the bot token in a
// level-60 record that agents read. Redaction works on the finished line, not per call site, so a new
// log statement cannot forget it.
//
// Known shapes: a Telegram bot token, an Anthropic API key or OAuth access token (`sk-ant-…`), an
// `Authorization: Bearer …` value, and any value registered from the loaded config (a secret with no
// recognisable shape, like ADMIN_ALERT_TOKEN).

import { inspect } from 'node:util';

const TELEGRAM_BOT_TOKEN = /(?<!\d)\d{5,}(?::|%3A)[A-Za-z0-9_-]{30,}/gi;
const ANTHROPIC_KEY = /\bsk-ant-[A-Za-z0-9_-]{8,}/g;
const BEARER_VALUE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

/** Shorter values are not credentials worth hunting for, and would redact ordinary words. */
const MIN_REGISTERED_LENGTH = 16;

const registered = new Set<string>();
/** The registry, longest first; rebuilt after a registration. */
let longestFirst: string[] = [];

/**
 * Remembers config secrets, so a value with no recognisable shape is still removed. Empty and short values
 * are ignored. The JSON-escaped form is remembered too: pino writes a value with a quote or a backslash
 * in it escaped, and the exact value would not match the line.
 */
export function registerSecretValues(values: ReadonlyArray<string | undefined>): void {
  for (const value of values) {
    if (value === undefined || value.length < MIN_REGISTERED_LENGTH) continue;
    registered.add(value);
    registered.add(JSON.stringify(value).slice(1, -1));
  }
  longestFirst = [...registered].sort((a, b) => b.length - a.length);
}

/** For tests: the registry is process-global. */
export function resetRegisteredSecrets(): void {
  registered.clear();
  longestFirst = [];
}

/**
 * Registered values go first and longest first: an exact value is the most precise thing known, and a
 * shape pattern that ran before it could cut it at the first character outside its alphabet and leave the
 * tail readable.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const value of longestFirst) out = out.replaceAll(value, '[redacted-secret]');
  return out
    .replace(TELEGRAM_BOT_TOKEN, '[redacted-telegram-token]')
    .replace(ANTHROPIC_KEY, '[redacted-anthropic-key]')
    .replace(BEARER_VALUE, '$1[redacted]');
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
const installed = new WeakSet<object>();

/**
 * Libraries print with `console` behind pino's back (gramio's long-polling loop does
 * `console.error('Error received when fetching updates', error)`, and an error object prints its `path`).
 * Each argument is rendered the way console would, redacted, and replaced by the text only when that
 * changed something, so a line without a secret prints exactly as before.
 */
export function installConsoleRedaction(target: Console = console): void {
  if (installed.has(target)) return;
  installed.add(target);
  for (const method of CONSOLE_METHODS) {
    const original = target[method];
    if (typeof original !== 'function') continue;
    target[method] = (...args: unknown[]) => {
      original.apply(
        target,
        args.map((arg) => {
          if (typeof arg === 'string') return redactSecrets(arg);
          if (arg === null || typeof arg !== 'object') return arg;
          const rendered = inspect(arg, { depth: 6 });
          const clean = redactSecrets(rendered);
          return clean === rendered ? arg : clean;
        }),
      );
    };
  }
}
