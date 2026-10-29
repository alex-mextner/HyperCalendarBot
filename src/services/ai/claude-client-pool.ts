import OpenAI, { type ClientOptions } from 'openai';
import { type ClaudeCredentialRequestOptions, createClaudeCredentialPool } from './claude-credential-pool.ts';
import { MODERATION_REJECTION } from './usage-classification.ts';

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

/** Create ordinary SDK clients per credential; retain the exact endpoint, headers and zero SDK retries. */
export function createClaudeClient(
  tokens: readonly (string | undefined)[],
  options: Omit<ClientOptions, 'apiKey'>,
): OpenAI {
  const firstToken = tokens.find((token) => !!token?.trim())?.trim();
  if (!firstToken) throw new Error('Claude API token is not configured');
  const clients = new Map<string, OpenAI>();
  const clientFor = (token: string): OpenAI => {
    let client = clients.get(token);
    if (!client) {
      client = new OpenAI({ ...options, apiKey: token, maxRetries: 0 });
      clients.set(token, client);
    }
    return client;
  };
  const first = clientFor(firstToken);
  registered.set(first, {
    pool: createClaudeCredentialPool(
      tokens,
      Date.now,
      (error) =>
        error instanceof OpenAI.APIError &&
        ((error.status === 403 && MODERATION_REJECTION.test(error.message)) ||
          (error.status === 429 &&
            /request (?:is )?too (?:large|big)|context (?:length|window)|maximum (?:context|input)/i.test(
              error.message,
            ))),
      (error) => error instanceof OpenAI.APIConnectionError,
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
