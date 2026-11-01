import OpenAI, { type ClientOptions } from 'openai';
import { type ClaudeCredentialRequestOptions, createClaudeCredentialPool } from './claude-credential-pool.ts';
import { MODERATION_REJECTION } from './usage-classification.ts';

const MODEL_PERMISSION_REJECTION =
  /\bdo(?:es)? not have permission to (?:use|access) (?:this |the )?model\b|\b(?:do(?:es)? not have|no) access to (?:the )?model\b|\bnot (?:authorized|permitted|allowed) to (?:use|access) (?:the )?model\b|\b(?:access|permission) denied (?:to|for) (?:the )?model\b|\bmodel\b[^.\n]{0,160}\b(?:access denied|not (?:available|accessible|enabled|permitted|allowed))\b/i;

function isRequestRejection(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return (
    error instanceof OpenAI.APIError &&
    ((error.status === 403 && MODERATION_REJECTION.test(error.message)) ||
      (error.status === 429 &&
        /request (?:is )?too (?:large|big)|context (?:length|window)|maximum (?:context|input)/i.test(error.message)))
  );
}

const registered = new WeakMap<
  OpenAI,
  {
    pool: ReturnType<typeof createClaudeCredentialPool>;
    clientFor: (token: string) => OpenAI;
  }
>();

/** Both credentials scope durable circuits; adding/rotating a backup must invalidate an old exhausted circuit. */
export function claudeCredentialScope(primary?: string, secondary?: string): string | undefined {
  const tokens = [
    ...new Set([primary, secondary].map((token) => token?.trim()).filter((token): token is string => !!token)),
  ];
  return tokens.length ? tokens.join('\0') : undefined;
}

/** The SDK builds `Authorization: Bearer <key>` through Headers, which rejects CR/LF/NUL and non-Latin-1 text. */
function isHeaderSafe(token: string): boolean {
  try {
    new Headers().append('authorization', `Bearer ${token}`);
    return true;
  } catch {
    return false;
  }
}

/** Create ordinary SDK clients per credential; retain the exact endpoint, headers and zero SDK retries. */
export function createClaudeClient(
  tokens: readonly (string | undefined)[],
  options: Omit<ClientOptions, 'apiKey'>,
): OpenAI {
  const distinct = [...new Set(tokens.map((token) => token?.trim()).filter((token): token is string => !!token))];
  const firstDistinct = distinct[0];
  if (!firstDistinct) throw new Error('Claude API token is not configured');
  const clients = new Map<string, OpenAI>();
  const clientFor = (token: string): OpenAI => {
    let client = clients.get(token);
    if (!client) {
      client = new OpenAI({ ...options, apiKey: token, maxRetries: 0 });
      clients.set(token, client);
    }
    return client;
  };
  // A header-invalid token fails inside the SDK with a raw TypeError that is indistinguishable from a
  // request-body serialization error, so it must never reach the pool; the value is deliberately not logged.
  const usable = distinct.length > 1 ? distinct.filter(isHeaderSafe) : [];
  // One usable credential (one configured, or one left after filtering) keeps the single-key SDK/caller
  // timeout and error behavior: no pool, no local cooldown. With none usable the first malformed client
  // fails fast without a fetch.
  const first = clientFor(usable.length === 1 ? (usable[0] ?? firstDistinct) : firstDistinct);
  if (usable.length > 1)
    registered.set(first, {
      pool: createClaudeCredentialPool(
        usable,
        Date.now,
        isRequestRejection,
        (error) => error instanceof OpenAI.APIConnectionError,
        (error) =>
          !(error instanceof OpenAI.APIError && error.status === 403 && MODEL_PERMISSION_REJECTION.test(error.message)),
      ),
      clientFor,
    });
  return first;
}

/** Only registered Claude clients rotate; other providers and existing test doubles stay ordinary requests. */
export async function withClaudeCredentials<T>(
  client: OpenAI,
  operation: (client: OpenAI, signal: AbortSignal | undefined) => Promise<T>,
  options: ClaudeCredentialRequestOptions,
): Promise<T> {
  const entry = registered.get(client);
  if (!entry) {
    options.signal?.throwIfAborted();
    options.onHttpAttempt?.();
    return operation(client, options.signal);
  }
  return entry.pool.run((token, signal) => operation(entry.clientFor(token), signal), options);
}
