import { afterEach, expect, test } from 'bun:test';
import OpenAI from 'openai';
import { createClaudeClient, withClaudeCredentials } from '../../../src/services/ai/claude-client-pool.ts';
import { resetModelRegistry, resolveModelOverride } from '../../../src/services/ai/model-registry.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetModelRegistry();
});
const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
  model: 'claude-synthetic',
  messages: [{ role: 'user', content: 'synthetic only' }],
  max_tokens: 32,
};

test('registered SDK request preserves complete payload while changing only the failed credential', async () => {
  const sent: { token: string | null; body: string; version: string | null }[] = [];
  const transport = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    sent.push({
      token: req.headers.get('authorization'),
      body: await req.text(),
      version: req.headers.get('anthropic-version'),
    });
    return sent.length === 1
      ? new Response(JSON.stringify({ error: { type: 'authentication_error', message: 'revoked synthetic key' } }), {
          status: 401,
        })
      : new Response(
          JSON.stringify({
            id: 'synthetic',
            object: 'chat.completion',
            created: 0,
            model: 'claude-synthetic',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
  };
  const client = createClaudeClient(['primary', 'backup'], {
    baseURL: 'https://api.anthropic.com/v1',
    defaultHeaders: { 'anthropic-version': '2023-06-01' },
    maxRetries: 0,
    fetch: transport,
  });
  let attempts = 0;
  const result = await withClaudeCredentials(
    client,
    (candidate, signal) => candidate.chat.completions.create(params, { signal }),
    { timeoutMs: 1000, onHttpAttempt: () => attempts++ },
  );
  expect(result.choices[0]?.message.content).toBe('ok');
  expect(attempts).toBe(2);
  expect(sent.map((entry) => entry.token)).toEqual(['Bearer primary', 'Bearer backup']);
  expect(sent[0]?.body).toBe(sent[1]?.body);
  expect(JSON.parse(sent[0]?.body ?? '{}')).toEqual(params);
  expect(sent.map((entry) => entry.version)).toEqual(['2023-06-01', '2023-06-01']);
});

test('a secondary-only SDK client works and unregistered clients remain one attempt', async () => {
  const client = createClaudeClient([undefined, ' backup '], { maxRetries: 0 });
  expect(client.apiKey).toBe('backup');
  const unregistered = new OpenAI({ apiKey: 'synthetic' });
  let calls = 0;
  let attempts = 0;
  expect(
    await withClaudeCredentials(
      unregistered,
      async (candidate) => {
        calls++;
        return candidate.apiKey;
      },
      { timeoutMs: 1000, onHttpAttempt: () => attempts++ },
    ),
  ).toBe('synthetic');
  expect(calls).toBe(1);
  expect(attempts).toBe(1);
});

test('model discovery rotates credentials without changing the configured replacement policy', async () => {
  const seen: (string | null)[] = [];
  const client = createClaudeClient(['primary', 'backup'], {
    baseURL: 'https://api.anthropic.com/v1',
    fetch: async (input, init) => {
      seen.push(
        (input instanceof Request ? new Request(input, init) : new Request(String(input), init)).headers.get(
          'authorization',
        ),
      );
      return seen.length === 1
        ? new Response(JSON.stringify({ error: { message: 'revoked synthetic key' } }), { status: 401 })
        : new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5-5' }] }), {
            headers: { 'content-type': 'application/json' },
          });
    },
  });
  expect(
    await resolveModelOverride({ provider: 'claude', client, configuredModel: 'claude-missing', forceRefresh: true }),
  ).toBe('claude-sonnet-5-5');
  expect(seen).toEqual(['Bearer primary', 'Bearer backup']);
});

test('model discovery never starts after the caller deadline expired', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const client = {
    models: {
      async list() {
        calls++;
        return { data: [{ id: 'claude-sonnet-5-5' }] };
      },
    },
  };
  expect(
    await resolveModelOverride({
      provider: 'claude',
      client,
      configuredModel: 'claude-missing',
      forceRefresh: true,
      signal: controller.signal,
    }),
  ).toBeNull();
  expect(calls).toBe(0);
});

test('a canceled catalog probe does not cache a provider failure for later callers', async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = {
    models: {
      async list() {
        calls++;
        if (calls === 1) {
          controller.abort();
          throw new DOMException('synthetic cancellation', 'AbortError');
        }
        return { data: [{ id: 'claude-sonnet-5-5' }] };
      },
    },
  };
  const base = { provider: 'claude' as const, client, configuredModel: 'claude-missing-after-cancellation' };
  expect(await resolveModelOverride({ ...base, signal: controller.signal })).toBeNull();
  await Bun.sleep(1);
  expect(await resolveModelOverride(base)).toBe('claude-sonnet-5-5');
  expect(calls).toBe(2);
});

test('canceling one catalog waiter leaves another caller able to discover the replacement', async () => {
  const canceled = new AbortController();
  let release: (() => void) | undefined;
  const client = {
    models: {
      async list(options?: { signal?: AbortSignal }) {
        return new Promise<{ data: { id: string }[] }>((resolve, reject) => {
          release = () => resolve({ data: [{ id: 'claude-sonnet-5-5' }] });
          options?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('synthetic cancellation', 'AbortError')),
            { once: true },
          );
        });
      },
    },
  };
  const base = { provider: 'claude' as const, client, configuredModel: 'claude-missing-concurrent' };
  const first = resolveModelOverride({ ...base, signal: canceled.signal });
  await Bun.sleep(1);
  const second = resolveModelOverride(base);
  canceled.abort();
  expect(await first).toBeNull();
  release?.();
  expect(await second).toBe('claude-sonnet-5-5');
});

test('a moderation rejection never rotates or cools a credential for the next benign request', async () => {
  const seen: (string | null)[] = [];
  const client = createClaudeClient(['primary', 'backup'], {
    baseURL: 'https://api.anthropic.com/v1',
    fetch: async (input, init) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      seen.push(request.headers.get('authorization'));
      return seen.length === 1
        ? new Response(JSON.stringify({ error: { message: 'input was flagged by content policy' } }), { status: 403 })
        : new Response(
            JSON.stringify({
              id: 'synthetic',
              object: 'chat.completion',
              created: 0,
              model: 'claude-synthetic',
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            }),
            { headers: { 'content-type': 'application/json' } },
          );
    },
  });
  await expect(
    withClaudeCredentials(client, (candidate, signal) => candidate.chat.completions.create(params, { signal }), {
      timeoutMs: 1000,
    }),
  ).rejects.toBeInstanceOf(OpenAI.APIError);
  expect(
    (
      await withClaudeCredentials(
        client,
        (candidate, signal) => candidate.chat.completions.create(params, { signal }),
        { timeoutMs: 1000 },
      )
    ).choices[0]?.message.content,
  ).toBe('ok');
  expect(seen).toEqual(['Bearer primary', 'Bearer primary']);
});

test('real SDK connection failures rotate once and preserve the same completion request', async () => {
  const seen: { token: string | null; body: string }[] = [];
  const client = createClaudeClient(['primary', 'backup'], {
    baseURL: 'https://api.anthropic.com/v1',
    fetch: async (input, init) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      seen.push({ token: request.headers.get('authorization'), body: await request.text() });
      if (seen.length === 1) throw new TypeError('synthetic connection reset');
      return new Response(
        JSON.stringify({
          id: 'synthetic',
          object: 'chat.completion',
          created: 0,
          model: 'claude-synthetic',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  let attempts = 0;
  const result = await withClaudeCredentials(
    client,
    (candidate, signal) => candidate.chat.completions.create(params, { signal }),
    { timeoutMs: 1000, onHttpAttempt: () => attempts++ },
  );
  expect(result.choices[0]?.message.content).toBe('ok');
  expect(attempts).toBe(2);
  expect(seen.map((entry) => entry.token)).toEqual(['Bearer primary', 'Bearer backup']);
  expect(seen[0]?.body).toBe(seen[1]?.body);
});

test('request-specific 429 does not rotate or cool credentials for the next benign request', async () => {
  const seen: (string | null)[] = [];
  const client = createClaudeClient(['primary', 'backup'], {
    baseURL: 'https://api.anthropic.com/v1',
    fetch: async (input, init) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      seen.push(request.headers.get('authorization'));
      return seen.length === 1
        ? new Response(JSON.stringify({ error: { message: 'request too large' } }), { status: 429 })
        : new Response(
            JSON.stringify({
              id: 'synthetic',
              object: 'chat.completion',
              created: 0,
              model: 'claude-synthetic',
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            }),
            { headers: { 'content-type': 'application/json' } },
          );
    },
  });
  await expect(
    withClaudeCredentials(client, (candidate, signal) => candidate.chat.completions.create(params, { signal }), {
      timeoutMs: 1000,
    }),
  ).rejects.toBeInstanceOf(OpenAI.APIError);
  expect(seen).toEqual(['Bearer primary']);
  expect(
    (
      await withClaudeCredentials(
        client,
        (candidate, signal) => candidate.chat.completions.create(params, { signal }),
        { timeoutMs: 1000 },
      )
    ).choices[0]?.message.content,
  ).toBe('ok');
  expect(seen).toEqual(['Bearer primary', 'Bearer primary']);
});
