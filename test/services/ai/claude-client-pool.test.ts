import { afterEach, expect, test } from 'bun:test';
import OpenAI from 'openai';
import { createClaudeClient, withClaudeCredentials } from '../../../src/services/ai/claude-client-pool.ts';
import { getClaudeCredentialAvailability } from '../../../src/services/ai/claude-credential-pool.ts';
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

for (const message of [
  'Your API key does not have access to model claude-denied',
  'API key does not have permission to use this model',
]) {
  test(`model-specific 403 "${message}" tries both credentials without disabling permitted models`, async () => {
    const sent: [string | null, string][] = [];
    const client = createClaudeClient(['primary', 'backup'], {
      baseURL: 'https://api.anthropic.com/v1',
      fetch: async (input, init) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        const body: unknown = await request.json();
        if (!body || typeof body !== 'object' || !('model' in body) || typeof body.model !== 'string')
          throw new Error('synthetic request omitted model');
        sent.push([request.headers.get('authorization'), body.model]);
        if (body.model === 'claude-denied')
          return new Response(JSON.stringify({ error: { message } }), { status: 403 });
        return new Response(
          JSON.stringify({
            id: 'synthetic',
            object: 'chat.completion',
            created: 0,
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    });
    await expect(
      withClaudeCredentials(
        client,
        (candidate, signal) => candidate.chat.completions.create({ ...params, model: 'claude-denied' }, { signal }),
        { timeoutMs: 1000 },
      ),
    ).rejects.toBeInstanceOf(OpenAI.APIError);
    expect(
      (
        await withClaudeCredentials(
          client,
          (candidate, signal) => candidate.chat.completions.create({ ...params, model: 'claude-allowed' }, { signal }),
          { timeoutMs: 1000 },
        )
      ).choices[0]?.message.content,
    ).toBe('ok');
    expect(sent).toEqual([
      ['Bearer primary', 'claude-denied'],
      ['Bearer backup', 'claude-denied'],
      ['Bearer primary', 'claude-allowed'],
    ]);
  });
}

test('a single configured credential keeps the legacy next-request retry after a transient SDK error', async () => {
  const sent: (string | null)[] = [];
  const client = createClaudeClient([' primary ', 'primary'], {
    baseURL: 'https://api.anthropic.com/v1',
    fetch: async (input, init) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      sent.push(request.headers.get('authorization'));
      return sent.length === 1
        ? new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), { status: 503 })
        : new Response(
            JSON.stringify({
              id: 'synthetic',
              object: 'chat.completion',
              created: 0,
              model: params.model,
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
  expect(sent).toEqual(['Bearer primary', 'Bearer primary']);
});

test('local credential cooldown never poisons the model catalog cache after quota recovers', async () => {
  let catalogs = 0;
  const client = createClaudeClient(['primary', 'backup'], {
    baseURL: 'https://api.anthropic.com/v1',
    fetch: async (input, init) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      if (request.url.endsWith('/models')) {
        catalogs++;
        return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5-5' }] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: { message: 'quota unavailable' } }), {
        status: 429,
        headers: { 'retry-after': '1' },
      });
    },
  });
  await withClaudeCredentials(client, (candidate, signal) => candidate.chat.completions.create(params, { signal }), {
    timeoutMs: 1000,
  }).catch(() => undefined);
  const query = { provider: 'claude' as const, client, configuredModel: 'claude-missing-cooldown' };
  expect(await resolveModelOverride(query)).toBeNull();
  expect(catalogs).toBe(0);
  await Bun.sleep(1100);
  expect(await resolveModelOverride(query)).toBe('claude-sonnet-5-5');
  expect(catalogs).toBe(1);
});

test('local SDK serialization TypeError never retries another key or cools a credential', async () => {
  const seen: (string | null)[] = [];
  const client = createClaudeClient(['primary', 'backup'], {
    baseURL: 'https://api.anthropic.com/v1',
    fetch: async (input, init) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      seen.push(request.headers.get('authorization'));
      return new Response(
        JSON.stringify({
          id: 'synthetic',
          object: 'chat.completion',
          created: 0,
          model: params.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const circular = { ...params };
  Object.assign(circular, { syntheticCycle: circular });
  let attempts = 0;
  await expect(
    withClaudeCredentials(client, (candidate, signal) => candidate.chat.completions.create(circular, { signal }), {
      timeoutMs: 1000,
      onHttpAttempt: () => attempts++,
    }),
  ).rejects.toBeInstanceOf(TypeError);
  expect(seen).toEqual([]);
  expect(attempts).toBe(1);
  expect(
    (
      await withClaudeCredentials(
        client,
        (candidate, signal) => candidate.chat.completions.create(params, { signal }),
        { timeoutMs: 1000 },
      )
    ).choices[0]?.message.content,
  ).toBe('ok');
  expect(seen).toEqual(['Bearer primary']);
});

const okTransport = (seen: (string | null)[]) => async (input: string | URL | Request, init?: RequestInit) => {
  const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
  seen.push(request.headers.get('authorization'));
  return new Response(
    JSON.stringify({
      id: 'synthetic',
      object: 'chat.completion',
      created: 0,
      model: params.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }),
    { headers: { 'content-type': 'application/json' } },
  );
};

// Dummy values only, none reaching a fetch: zero-width space, U+2026 and CR/LF are rejected by Headers; internal
// SOH, US, TAB and DEL are accepted by Headers but are control characters the transport then rejects with a 400.
const MALFORMED_TOKENS = [
  'bad\u200btoken',
  'tok\u2026en',
  'tok\r\nen',
  'bad\u0001token',
  'bad\u001ftoken',
  'bad\ttoken',
  'bad\u007ftoken',
];

for (const malformed of MALFORMED_TOKENS) {
  test(`a malformed primary token (${JSON.stringify(malformed).length} chars) is ignored so the valid backup serves`, async () => {
    const seen: (string | null)[] = [];
    const client = createClaudeClient([malformed, 'backup'], {
      baseURL: 'https://api.anthropic.com/v1',
      fetch: okTransport(seen),
    });
    const result = await withClaudeCredentials(
      client,
      (candidate, signal) => candidate.chat.completions.create(params, { signal }),
      { timeoutMs: 1000 },
    );
    expect(result.choices[0]?.message.content).toBe('ok');
    expect(seen).toEqual(['Bearer backup']);
  });

  test(`a malformed backup token (${JSON.stringify(malformed).length} chars) never blocks the valid primary`, async () => {
    const seen: (string | null)[] = [];
    const client = createClaudeClient(['primary', malformed], {
      baseURL: 'https://api.anthropic.com/v1',
      fetch: okTransport(seen),
    });
    await withClaudeCredentials(client, (candidate, signal) => candidate.chat.completions.create(params, { signal }), {
      timeoutMs: 1000,
    });
    expect(seen).toEqual(['Bearer primary']);
  });

  test(`only malformed tokens fail before any SDK call or HTTP attempt without leaking the token (${JSON.stringify(malformed).length} chars)`, async () => {
    const seen: (string | null)[] = [];
    for (const tokens of [[malformed], [malformed, `${malformed}2`]]) {
      const client = createClaudeClient(tokens, { baseURL: 'https://api.anthropic.com/v1', fetch: okTransport(seen) });
      let operations = 0;
      let httpAttempts = 0;
      const error = await withClaudeCredentials(
        client,
        (candidate, signal) => {
          operations++;
          return candidate.chat.completions.create(params, { signal });
        },
        { timeoutMs: 1000, onHttpAttempt: () => httpAttempts++ },
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TypeError);
      // Bun 1.4.2 (the pinned production runtime) echoes the rejected header value in the SDK's own TypeError.
      const text = `${(error as Error).message}\n${(error as Error).stack}\n${JSON.stringify(getClaudeCredentialAvailability(error))}`;
      for (const token of tokens) expect(text.includes(token.trim())).toBe(false);
      expect(operations).toBe(0);
      expect(httpAttempts).toBe(0);
    }
    expect(seen).toEqual([]);
  });
}

for (const message of [
  'does not have permission to use the specified resource',
  'This organization has been disabled',
  'Your API key does not have permission to perform this action',
]) {
  test(`account-level 403 "${message}" cools the key and rotates (not mistaken for a model permission)`, async () => {
    const seen: (string | null)[] = [];
    const okResponse = okTransport(seen);
    const client = createClaudeClient(['primary', 'backup'], {
      baseURL: 'https://api.anthropic.com/v1',
      fetch: async (input, init) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        if (request.headers.get('authorization') !== 'Bearer primary') return okResponse(input, init);
        seen.push('Bearer primary');
        return new Response(JSON.stringify({ error: { message } }), { status: 403 });
      },
    });
    const run = () =>
      withClaudeCredentials(client, (candidate, signal) => candidate.chat.completions.create(params, { signal }), {
        timeoutMs: 1000,
      });
    expect((await run()).choices[0]?.message.content).toBe('ok');
    expect((await run()).choices[0]?.message.content).toBe('ok');
    // The second request never touches the cooled primary.
    expect(seen).toEqual(['Bearer primary', 'Bearer backup', 'Bearer backup']);
  });
}

// First request: a retry-after 503 (a transient, key-level failure); every later request succeeds.
const transientThenOkTransport = (seen: (string | null)[]) => {
  const okResponse = okTransport(seen);
  return async (input: string | URL | Request, init?: RequestInit) => {
    const response = await okResponse(input, init);
    return seen.length > 1
      ? response
      : new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), {
          status: 503,
          headers: { 'retry-after': '60' },
        });
  };
};

for (const tokens of [
  ['primary', 'bad\u200btoken'],
  ['bad\u200btoken', 'primary'],
  ['primary', 'bad\u200btoken', ' primary '],
]) {
  test(`a malformed key beside one usable key keeps the single-key next-request retry (${tokens.length} configured)`, async () => {
    const sent: (string | null)[] = [];
    const client = createClaudeClient(tokens, {
      baseURL: 'https://api.anthropic.com/v1',
      fetch: transientThenOkTransport(sent),
    });
    const run = () =>
      withClaudeCredentials(client, (candidate, signal) => candidate.chat.completions.create(params, { signal }), {
        timeoutMs: 1000,
      });
    await expect(run()).rejects.toBeInstanceOf(OpenAI.APIError);
    expect((await run()).choices[0]?.message.content).toBe('ok');
    expect(sent).toEqual(['Bearer primary', 'Bearer primary']);
  });
}

for (const status of [401, 503]) {
  test(`a leading malformed key is ignored while the remaining valid keys still rotate after HTTP ${status}`, async () => {
    const sent: (string | null)[] = [];
    const okResponse = okTransport(sent);
    const client = createClaudeClient(['bad\u200btoken', 'a', 'b'], {
      baseURL: 'https://api.anthropic.com/v1',
      fetch: async (input, init) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        if (request.headers.get('authorization') !== 'Bearer a') return okResponse(input, init);
        sent.push('Bearer a');
        return new Response(JSON.stringify({ error: { message: 'unavailable' } }), {
          status,
          headers: { 'retry-after': '60' },
        });
      },
    });
    const result = await withClaudeCredentials(
      client,
      (candidate, signal) => candidate.chat.completions.create(params, { signal }),
      { timeoutMs: 1000 },
    );
    expect(result.choices[0]?.message.content).toBe('ok');
    expect(sent).toEqual(['Bearer a', 'Bearer b']);
  });
}

test('duplicate-only credentials stay a single unpooled key', async () => {
  const sent: (string | null)[] = [];
  const client = createClaudeClient(['a', ' a '], {
    baseURL: 'https://api.anthropic.com/v1',
    fetch: transientThenOkTransport(sent),
  });
  const run = () =>
    withClaudeCredentials(client, (candidate, signal) => candidate.chat.completions.create(params, { signal }), {
      timeoutMs: 1000,
    });
  await expect(run()).rejects.toBeInstanceOf(OpenAI.APIError);
  expect((await run()).choices[0]?.message.content).toBe('ok');
  expect(sent).toEqual(['Bearer a', 'Bearer a']);
});
