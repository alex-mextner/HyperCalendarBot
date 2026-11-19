import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { migrations } from '../../../src/database/migrations.ts';
import { AiUsageRepository } from '../../../src/database/repositories/ai-usage.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import { cacheableSystemMessage } from '../../../src/services/ai/claude-cache-prefix.ts';
import { createClaudeClient } from '../../../src/services/ai/claude-client-pool.ts';
import { nativeRequest } from '../../../src/services/ai/claude-native-request.ts';
import { AgentRequestMetrics } from '../../../src/services/ai/request-metrics.ts';
import { failureAttempt } from '../../../src/services/ai/streaming/failure.ts';
import { streamingSlot } from '../../../src/services/ai/streaming/slot.ts';
import { classifyProviderError } from '../../../src/services/ai/usage-classification.ts';
import type { AiTokenUsage } from '../../../src/services/ai/usage-recorder.ts';
import { answeredAttempt } from '../../../src/services/ai/usage-recorder.ts';
import { summarizeAiUsage } from '../../../src/services/ai/usage-report.ts';
import { createAgentRunFixture, fakeMetrics, makeStreamImpl } from './agent-run-helpers.ts';

function sse(events: readonly { type: string; [key: string]: unknown }[]): Response {
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function nativeAnswer(): Response {
  return sse([
    {
      type: 'message_start',
      message: {
        id: 'synthetic',
        model: 'claude-synthetic',
        usage: { input_tokens: 7, cache_creation_input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 3, output_tokens_details: { thinking_tokens: 2 } },
    },
    { type: 'message_stop' },
  ]);
}

test('Claude native mode uses cacheable Messages API and preserves native usage components', async () => {
  const requests: Request[] = [];
  const client = createClaudeClient(
    ['synthetic-primary'],
    {
      baseURL: 'https://api.anthropic.com/v1',
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        if (new URL(request.url).pathname.endsWith('/messages')) return nativeAnswer();
        return new Response(
          `data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', created: 0, model: 'claude-synthetic', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 307, completion_tokens: 3, total_tokens: 310 } })}\n\ndata: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    },
    'native',
  );
  const slot = streamingSlot('Claude', 'claude', () => client, 'claude-synthetic', 'synthetic-circuit');
  const result = await slot.stream(
    'claude-synthetic',
    {
      messages: [
        { role: 'system', content: 'Fixed synthetic instructions.' },
        { role: 'user', content: 'Say ok.' },
      ],
      maxTokens: 50,
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_synthetic',
            description: 'Read synthetic data.',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
    },
    {},
    () => undefined,
  );
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]!.url).pathname).toBe('/v1/messages');
  expect(requests[0]!.headers.get('x-api-key')).toBe('synthetic-primary');
  expect(requests[0]!.headers.get('anthropic-version')).toBe('2023-06-01');
  const body = await requests[0]!.json();
  expect(body.cache_control).toBeUndefined();
  expect(body.tools[0].cache_control).toEqual({ type: 'ephemeral' });
  expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
  expect(result.text).toBe('ok');
  expect(result.finishReason).toBe('stop');
  expect(result.metrics?.usage).toMatchObject({
    promptTokens: 307,
    completionTokens: 3,
    totalTokens: 310,
    cachedTokens: 200,
    freshInputTokens: 7,
    cacheWriteTokens: 100,
    reasoningTokens: 2,
    credentialId: createHash('sha256').update('synthetic-primary').digest('hex').slice(0, 12),
  });
});

const scope = {
  chain: 'smart' as const,
  purpose: 'agent' as const,
  requestId: 'synthetic-run',
  role: null,
  preset: null,
};

test('native fresh/write/read and selected credential survive the durable usage ledger', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db, migrations);
    const repo = new AiUsageRepository(db);
    repo.insertMany([
      answeredAttempt(scope, 'claude', 'claude-synthetic', 1, 10, {
        promptTokens: 307,
        completionTokens: 3,
        reasoningTokens: null,
        cachedTokens: 200,
        freshInputTokens: 7,
        cacheWriteTokens: 100,
        credentialId: '123456789abc',
      }),
      answeredAttempt(scope, 'claude', 'claude-synthetic', 2, 10, {
        promptTokens: 8,
        completionTokens: 2,
        reasoningTokens: null,
        cachedTokens: null,
      }),
    ]);
    const rows = [...repo.iterateSince(0)];
    expect(rows[0]).toMatchObject({
      promptTokens: 307,
      cachedTokens: 200,
      freshInputTokens: 7,
      cacheWriteTokens: 100,
      credentialId: '123456789abc',
    });
    expect(rows[1]?.cachedTokens).toBeNull();
    expect(rows[1]?.freshInputTokens ?? null).toBeNull();
    expect(rows[1]?.cacheWriteTokens ?? null).toBeNull();
    expect(rows[1]?.credentialId ?? null).toBeNull();
  } finally {
    db.close();
  }
});

test('failed HTTP 200 stream retains known native input usage without replay', async () => {
  let observed: AiTokenUsage | null = null;
  let requests = 0;
  const client = createClaudeClient(
    ['synthetic-primary', 'synthetic-backup'],
    {
      baseURL: 'https://api.anthropic.com/v1',
      fetch: async () => {
        requests++;
        return sse([
          {
            type: 'message_start',
            message: {
              id: 'synthetic',
              model: 'claude-synthetic',
              usage: {
                input_tokens: 7,
                cache_creation_input_tokens: 100,
                cache_read_input_tokens: 200,
                output_tokens: 1,
              },
            },
          },
          { type: 'error', error: { type: 'overloaded_error', message: 'Synthetic transport error' } },
        ]);
      },
    },
    'native',
  );
  const slot = streamingSlot('Claude', 'claude', () => client, 'claude-synthetic', 'synthetic-circuit');
  let failure: unknown;
  try {
    await slot.stream(
      'claude-synthetic',
      { messages: [{ role: 'user', content: 'Synthetic only.' }], maxTokens: 50 },
      {
        onNativeUsage: (usage) => {
          observed = usage;
        },
      },
      () => undefined,
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(requests).toBe(1);
  const event = failureAttempt(scope, slot, 'claude-synthetic', failure, false, 1, performance.now(), observed);
  expect(event).toMatchObject({
    outcome: 'error',
    promptTokens: 307,
    cachedTokens: 200,
    freshInputTokens: 7,
    cacheWriteTokens: 100,
    completionTokens: 1,
    credentialId: createHash('sha256').update('synthetic-primary').digest('hex').slice(0, 12),
  });
});

test('the real agent preserves the static cache boundary before user and clock context', async () => {
  const prefixes: string[] = [];
  const tails: string[] = [];
  for (const timezone of ['UTC', 'Europe/Berlin']) {
    const fixture = createAgentRunFixture();
    try {
      fixture.ctx.user.timezone = timezone;
      const { impl, calls } = makeStreamImpl([{ kind: 'text', text: 'Which date should I check?' }]);
      await new CalendarBotAgent(fixture.config, fixture.sender, { streamImpl: impl }).run(fixture.ctx);
      const messages = calls[0]?.messages;
      expect(messages).toBeDefined();
      const body = nativeRequest({
        model: 'claude-synthetic',
        messages: messages ?? [],
        max_tokens: 128000,
        stream: true,
      });
      expect(body.system).toHaveLength(2);
      expect(body.system?.[0]?.cache_control).toEqual({ type: 'ephemeral' });
      expect(body.system?.[1]?.cache_control).toBeUndefined();
      prefixes.push(body.system?.[0]?.text ?? '');
      tails.push(body.system?.[1]?.text ?? '');
      // Symbol metadata never changes another provider's serialized request.
      expect(JSON.stringify(messages)).not.toContain('cache_control');
    } finally {
      fixture.db.close();
    }
  }
  expect(prefixes[0]).toBe(prefixes[1]);
  expect(prefixes[0]?.length).toBeGreaterThan(1000);
  expect(tails[0]).not.toBe(tails[1]);
});

test('a caller abort after native usage preserves known input without replay', async () => {
  let observed: AiTokenUsage | null = null;
  const controller = new AbortController();
  const reason = new DOMException('Synthetic caller cancellation', 'AbortError');
  let requests = 0;
  const client = createClaudeClient(
    ['synthetic-primary', 'synthetic-backup'],
    {
      baseURL: 'https://api.anthropic.com/v1',
      fetch: async () => {
        requests++;
        return nativeAnswer();
      },
    },
    'native',
  );
  const slot = streamingSlot('Claude', 'claude', () => client, 'claude-synthetic', 'synthetic-circuit');
  let failure: unknown;
  try {
    await slot.stream(
      'claude-synthetic',
      { messages: [{ role: 'user', content: 'Synthetic only.' }], maxTokens: 50, signal: controller.signal },
      {
        onTextDelta: () => controller.abort(reason),
        onNativeUsage: (usage) => {
          observed = usage;
        },
      },
      () => undefined,
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toBe(reason);
  expect(requests).toBe(1);
  expect(failureAttempt(scope, slot, 'claude-synthetic', failure, true, 1, performance.now(), observed)).toMatchObject({
    outcome: 'error',
    errorClass: 'aborted',
    freshInputTokens: 7,
    cacheWriteTokens: 100,
    cachedTokens: 200,
  });
});

test('request-level cache totals stay unknown when no round reported cache usage', () => {
  const metrics = new AgentRequestMetrics();
  metrics.recordRound(fakeMetrics('zai', 100, 20));
  const snapshot = metrics.snapshot('normal', { outcome: 'discarded', messageIds: [] }, 0);
  expect(snapshot.cachedTokens).toBeNull();
});

test('a credential timeout records the failed key before the backup succeeds', async () => {
  let observed: AiTokenUsage | null = null;
  const failedUsage: (AiTokenUsage | null)[] = [];
  const failures: unknown[] = [];
  const seen: (string | null)[] = [];
  const client = createClaudeClient(
    ['synthetic-primary', 'synthetic-backup'],
    {
      baseURL: 'https://api.anthropic.com/v1',
      fetch: async (input, init) => {
        const request = new Request(input, init);
        seen.push(request.headers.get('x-api-key'));
        if (seen.length === 1)
          return new Promise<Response>((_resolve, reject) =>
            request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }),
          );
        return nativeAnswer();
      },
    },
    'native',
  );
  const slot = streamingSlot('Claude', 'claude', () => client, 'claude-synthetic', 'synthetic-circuit');
  const result = await slot.stream(
    'claude-synthetic',
    {
      messages: [{ role: 'user', content: 'Synthetic only.' }],
      maxTokens: 50,
      providerDeadlineAt: performance.now() + 100,
    },
    {
      onNativeUsage: (usage) => {
        observed = usage;
      },
      onCredentialRetry: (attempt) => {
        failures.push(attempt.error);
        failedUsage.push(observed);
      },
    },
    () => undefined,
  );
  expect(seen).toEqual(['synthetic-primary', 'synthetic-backup']);
  expect(failures).toHaveLength(1);
  expect(
    failureAttempt(scope, slot, 'claude-synthetic', failures[0], false, 1, performance.now(), failedUsage[0] ?? null),
  ).toMatchObject({
    outcome: 'error',
    cachedTokens: null,
    freshInputTokens: null,
    cacheWriteTokens: null,
    credentialId: createHash('sha256').update('synthetic-primary').digest('hex').slice(0, 12),
  });
  expect(result.metrics?.usage?.credentialId).toBe(
    createHash('sha256').update('synthetic-backup').digest('hex').slice(0, 12),
  );
});

test('usage reports separate native credential totals from historical unknown attribution', () => {
  const native = answeredAttempt(scope, 'claude', 'claude-synthetic', 1, 10, {
    promptTokens: 307,
    completionTokens: 3,
    reasoningTokens: null,
    cachedTokens: 200,
    freshInputTokens: 7,
    cacheWriteTokens: 100,
    credentialId: '123456789abc',
  });
  const historical = answeredAttempt(scope, 'claude', 'claude-synthetic', 2, 10, {
    promptTokens: 8,
    completionTokens: 2,
    reasoningTokens: null,
    cachedTokens: null,
  });
  const report = summarizeAiUsage([native, historical], { sinceMs: 0, untilMs: 3 });
  expect(report.claudeAccounts).toHaveLength(2);
  expect(report.claudeAccounts?.find((row) => row.credentialId === '123456789abc')).toMatchObject({
    attempts: 1,
    tokens: { prompt: { sum: 307 }, cached: { sum: 200 } },
    freshInput: { sum: 7, reportedRows: 1, unknownRows: 0 },
    cacheWrite: { sum: 100, reportedRows: 1, unknownRows: 0 },
  });
  expect(report.claudeAccounts?.find((row) => row.credentialId === null)).toMatchObject({
    attempts: 1,
    freshInput: { sum: null, reportedRows: 0, unknownRows: 1 },
    cacheWrite: { sum: null, reportedRows: 0, unknownRows: 1 },
  });
});

test('native tool rounds echo opaque blocks exactly and append newly discovered schemas', async () => {
  const requests: Request[] = [];
  const client = createClaudeClient(
    ['synthetic-primary'],
    {
      baseURL: 'https://api.anthropic.com/v1',
      fetch: async (input, init) => {
        requests.push(new Request(input, init).clone());
        if (requests.length > 1) return nativeAnswer();
        return sse([
          {
            type: 'message_start',
            message: {
              id: 'synthetic-tools',
              model: 'claude-synthetic',
              usage: { input_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 6, output_tokens: 1 },
            },
          },
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque-' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque-signature' } },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'call-one', name: 'read_one', input: {} },
          },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"day":' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"synthetic"}' } },
          { type: 'content_block_stop', index: 1 },
          {
            type: 'content_block_start',
            index: 2,
            content_block: { type: 'redacted_thinking', data: 'opaque-redacted' },
          },
          { type: 'content_block_stop', index: 2 },
          { type: 'content_block_start', index: 3, content_block: { type: 'text', text: 'Checking. ' } },
          { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'Continuing.' } },
          { type: 'content_block_stop', index: 3 },
          {
            type: 'content_block_start',
            index: 4,
            content_block: { type: 'tool_use', id: 'call-two', name: 'read_two', input: {} },
          },
          { type: 'content_block_stop', index: 4 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 15 } },
          { type: 'message_stop' },
        ]);
      },
    },
    'native',
  );
  const slot = streamingSlot('Claude', 'claude', () => client, 'claude-synthetic', 'synthetic-circuit');
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: 'Stable instructions.' },
    { role: 'user', content: 'Synthetic request.' },
  ];
  const makeTool = (name: string): OpenAI.ChatCompletionTool => ({
    type: 'function',
    function: { name, parameters: { type: 'object', properties: {} } },
  });
  const tools = [makeTool('read_one'), makeTool('read_two')];
  const first = await slot.stream('claude-synthetic', { messages, tools, maxTokens: 100 }, {}, () => undefined);
  expect(first.toolCalls).toEqual([
    { id: 'call-one', name: 'read_one', arguments: '{"day":"synthetic"}' },
    { id: 'call-two', name: 'read_two', arguments: '{}' },
  ]);
  expect(first.text).toBe('Checking. Continuing.');
  expect(JSON.stringify(first)).not.toContain('opaque-');
  await slot.stream(
    'claude-synthetic',
    {
      messages: [
        ...messages,
        first.assistantMessage,
        { role: 'tool', tool_call_id: 'call-one', content: 'One.' },
        { role: 'tool', tool_call_id: 'call-two', content: 'Two.' },
      ],
      tools: [...tools, makeTool('discovered_later')],
      maxTokens: 100,
    },
    {},
    () => undefined,
  );
  const before = await requests[0]!.json();
  const after = await requests[1]!.json();
  expect(after.system).toEqual(before.system);
  expect(after.tools).toEqual(before.tools);
  expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
  expect(after.messages[1].content).toEqual([
    { type: 'thinking', thinking: '', signature: 'opaque-signature' },
    { type: 'tool_use', id: 'call-one', name: 'read_one', input: { day: 'synthetic' } },
    { type: 'redacted_thinking', data: 'opaque-redacted' },
    { type: 'text', text: 'Checking. Continuing.' },
    { type: 'tool_use', id: 'call-two', name: 'read_two', input: {} },
  ]);
  expect(after.messages[2].content.map((block: { tool_use_id: string }) => block.tool_use_id)).toEqual([
    'call-one',
    'call-two',
  ]);
  expect(after.messages[3]).toMatchObject({
    role: 'system',
    content: [{ type: 'tool_addition', tool: { type: 'tool_definition', definition: { name: 'discovered_later' } } }],
  });
  expect(requests[1]!.headers.get('anthropic-beta')).toContain('inline-tools-2026-09-15');
});

test('native missing usage remains unknown and a stream without a terminal reason fails', async () => {
  for (const terminal of [true, false]) {
    const client = createClaudeClient(
      ['synthetic-primary'],
      {
        baseURL: 'https://api.anthropic.com/v1',
        fetch: async () =>
          sse([
            {
              type: 'message_start',
              message: { id: 'synthetic', model: 'claude-synthetic', usage: { input_tokens: 7 } },
            },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } },
            { type: 'content_block_stop', index: 0 },
            ...(terminal
              ? [{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }]
              : []),
            { type: 'message_stop' },
          ]),
      },
      'native',
    );
    const slot = streamingSlot('Claude', 'claude', () => client, 'claude-synthetic', 'synthetic-circuit');
    const request = slot.stream(
      'claude-synthetic',
      { messages: [{ role: 'user', content: 'Synthetic.' }], maxTokens: 100 },
      {},
      () => undefined,
    );
    if (terminal) {
      const result = await request;
      expect(result.metrics?.usage).toMatchObject({
        freshInputTokens: 7,
        promptTokens: null,
        cacheWriteTokens: null,
        cachedTokens: null,
        completionTokens: 3,
        totalTokens: null,
      });
    } else await expect(request).rejects.toThrow('terminal stop reason');
  }
});

test('automatic history caching is limited to explicitly marked agent prompts', () => {
  const build = (system: OpenAI.ChatCompletionSystemMessageParam) =>
    nativeRequest({
      model: 'claude-synthetic',
      stream: true,
      max_tokens: 100,
      messages: [system, { role: 'user', content: 'Unique one-shot input.' }],
    });
  const oneShot = build({ role: 'system', content: 'Fixed rules.' });
  expect(oneShot.cache_control).toBeUndefined();
  expect(oneShot.system?.[0]?.cache_control).toEqual({ type: 'ephemeral' });
  const agent = build(cacheableSystemMessage('Fixed rules. Dynamic context.', 'Fixed rules.'));
  expect(agent.cache_control).toEqual({ type: 'ephemeral' });
  expect(agent.system?.[1]?.cache_control).toBeUndefined();
});

test('native failure accounting keeps newer terminal usage when the stop reason is rejected', async () => {
  let observed: AiTokenUsage | null = null;
  const client = createClaudeClient(
    ['synthetic-primary'],
    {
      baseURL: 'https://api.anthropic.com/v1',
      fetch: async () =>
        sse([
          {
            type: 'message_start',
            message: {
              id: 'synthetic',
              model: 'claude-synthetic',
              usage: {
                input_tokens: 7,
                cache_creation_input_tokens: 100,
                cache_read_input_tokens: 200,
                output_tokens: 1,
              },
            },
          },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Partial.' } },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'unexpected_reason' },
            usage: { output_tokens: 5, output_tokens_details: { thinking_tokens: 2 } },
          },
        ]),
    },
    'native',
  );
  const slot = streamingSlot('Claude', 'claude', () => client, 'claude-synthetic', 'synthetic-circuit');
  let failure: unknown;
  try {
    await slot.stream(
      'claude-synthetic',
      { messages: [{ role: 'user', content: 'Synthetic.' }], maxTokens: 100 },
      {
        onNativeUsage: (usage) => {
          observed = usage;
        },
      },
      () => undefined,
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failureAttempt(scope, slot, 'claude-synthetic', failure, false, 1, performance.now(), observed)).toMatchObject(
    {
      promptTokens: 307,
      completionTokens: 5,
      reasoningTokens: 2,
      freshInputTokens: 7,
      cacheWriteTokens: 100,
      cachedTokens: 200,
    },
  );
});

test('incomplete native content blocks cannot publish executable tool calls', async () => {
  const client = createClaudeClient(
    ['synthetic-primary'],
    {
      baseURL: 'https://api.anthropic.com/v1',
      fetch: async () =>
        sse([
          {
            type: 'message_start',
            message: {
              id: 'synthetic',
              model: 'claude-synthetic',
              usage: {
                input_tokens: 7,
                cache_creation_input_tokens: 100,
                cache_read_input_tokens: 200,
                output_tokens: 1,
              },
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'one', name: 'read_one', input: {} },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"day":"synthetic"}' },
          },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
          { type: 'message_stop' },
        ]),
    },
    'native',
  );
  const slot = streamingSlot('Claude', 'claude', () => client, 'claude-synthetic', 'synthetic-circuit');
  await expect(
    slot.stream(
      'claude-synthetic',
      { messages: [{ role: 'user', content: 'Synthetic.' }], maxTokens: 100 },
      {},
      () => undefined,
    ),
  ).rejects.toThrow('incomplete content blocks');
});

test('native unknown usage is null-tolerant and a visible cutoff never reports initial output as final', async () => {
  let call = 0;
  const client = createClaudeClient(
    ['synthetic-primary'],
    {
      baseURL: 'https://api.anthropic.com/v1',
      fetch: async () => {
        call++;
        return sse([
          {
            type: 'message_start',
            message: {
              id: 'synthetic',
              model: 'claude-synthetic',
              usage: {
                input_tokens: 7,
                cache_creation_input_tokens: 100,
                cache_read_input_tokens: 200,
                output_tokens: 1,
              },
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: call === 1 ? 'A long visible answer. '.repeat(20) : 'ok' },
          },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 5 } },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: {
              input_tokens: null,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
              output_tokens: null,
            },
          },
          { type: 'message_stop' },
        ]);
      },
    },
    'native',
  );
  const slot = streamingSlot('Claude', 'claude', () => client, 'claude-synthetic', 'synthetic-circuit');
  const options = { messages: [{ role: 'user' as const, content: 'Synthetic.' }], maxTokens: 1 };
  const cut = await slot.stream('claude-synthetic', options, {}, () => undefined);
  expect(cut.finishReason).toBe('length');
  expect(cut.metrics?.usage).toMatchObject({ promptTokens: 307, completionTokens: null });
  const complete = await slot.stream('claude-synthetic', { ...options, maxTokens: 100 }, {}, () => undefined);
  expect(complete.metrics?.usage).toMatchObject({
    promptTokens: 307,
    completionTokens: 5,
    freshInputTokens: 7,
    cachedTokens: 200,
    cacheWriteTokens: 100,
  });
});

test('native cancellation attribution is attempt-local even when runs share one abort reason', async () => {
  const controller = new AbortController();
  const reason = new DOMException('Synthetic shared cancellation', 'AbortError');
  const observed: (AiTokenUsage | null)[] = [null, null];
  let visible = 0;
  const slots = [7, 17].map((fresh, index) => {
    const client = createClaudeClient(
      [`synthetic-${index}`],
      {
        baseURL: 'https://api.anthropic.com/v1',
        fetch: async () => {
          const prefix = await sse([
            {
              type: 'message_start',
              message: {
                id: 'synthetic',
                model: 'claude-synthetic',
                usage: {
                  input_tokens: fresh,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                  output_tokens: 1,
                },
              },
            },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Partial.' } },
          ]).text();
          return new Response(
            new ReadableStream({
              start(stream) {
                stream.enqueue(new TextEncoder().encode(prefix));
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      },
      'native',
    );
    return streamingSlot('Claude', 'claude', () => client, 'claude-synthetic', `synthetic-${index}`);
  });
  const outcomes = await Promise.allSettled(
    slots.map((slot, index) =>
      slot.stream(
        'claude-synthetic',
        { messages: [{ role: 'user', content: 'Synthetic.' }], maxTokens: 100, signal: controller.signal },
        {
          onNativeUsage: (usage) => {
            observed[index] = usage;
          },
          onTextDelta: () => {
            if (++visible === 2) controller.abort(reason);
          },
        },
        () => undefined,
      ),
    ),
  );
  expect(outcomes.every((result) => result.status === 'rejected' && result.reason === reason)).toBe(true);
  expect(observed[0]?.freshInputTokens).toBe(7);
  expect(observed[1]?.freshInputTokens).toBe(17);
  expect(observed[0]?.credentialId).not.toBe(observed[1]?.credentialId);
});

test('native cancellation before message_start still reports the selected credential with unknown usage', async () => {
  const controller = new AbortController();
  let observed: AiTokenUsage | null = null;
  const client = createClaudeClient(
    ['synthetic-primary'],
    {
      baseURL: 'https://api.anthropic.com/v1',
      fetch: async () => {
        setTimeout(() => controller.abort(), 0);
        return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
      },
    },
    'native',
  );
  const slot = streamingSlot('Claude', 'claude', () => client, 'claude-synthetic', 'synthetic');
  await expect(
    slot.stream(
      'claude-synthetic',
      { messages: [{ role: 'user', content: 'Synthetic.' }], maxTokens: 100, signal: controller.signal },
      {
        onNativeUsage: (usage) => {
          observed = usage;
        },
      },
      () => undefined,
    ),
  ).rejects.toBeInstanceOf(Error);
  expect(observed).toMatchObject({
    credentialId: createHash('sha256').update('synthetic-primary').digest('hex').slice(0, 12),
    promptTokens: null,
    completionTokens: null,
  });
});

test.each([
  ['overloaded_error', 'server'],
  ['rate_limit_error', 'rate_limit'],
] as const)('native SSE %s keeps usage and classifies the error without inventing HTTP status', async (type, errorClass) => {
  let observed: AiTokenUsage | null = null;
  const client = createClaudeClient(
    ['synthetic-primary'],
    {
      baseURL: 'https://api.anthropic.com/v1',
      fetch: async () =>
        sse([
          {
            type: 'message_start',
            message: {
              id: 'synthetic',
              model: 'claude-synthetic',
              usage: {
                input_tokens: 7,
                cache_creation_input_tokens: 100,
                cache_read_input_tokens: 200,
                output_tokens: 1,
              },
            },
          },
          { type: 'error', error: { type, message: 'Synthetic provider failure.' } },
        ]),
    },
    'native',
  );
  const slot = streamingSlot('Claude', 'claude', () => client, 'claude-synthetic', 'synthetic');
  const error = await slot
    .stream(
      'claude-synthetic',
      { messages: [{ role: 'user', content: 'Synthetic.' }], maxTokens: 100 },
      {
        onNativeUsage: (usage) => {
          observed = usage;
        },
      },
      () => undefined,
    )
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(OpenAI.APIError);
  expect(classifyProviderError(error, false)).toEqual({ errorClass, httpStatus: null });
  expect(observed).toMatchObject({
    promptTokens: 307,
    freshInputTokens: 7,
    cacheWriteTokens: 100,
    cachedTokens: 200,
    completionTokens: 1,
  });
});

test('native conversion accepts foreign no-argument null tool calls without altering IDs', () => {
  const body = nativeRequest({
    model: 'claude-synthetic',
    max_tokens: 128,
    stream: true,
    messages: [
      { role: 'user', content: 'Synthetic.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'foreign-null', type: 'function', function: { name: 'read_all', arguments: 'null' } }],
      },
      { role: 'tool', tool_call_id: 'foreign-null', content: 'Synthetic result.' },
    ],
  });
  expect(body.messages[1]?.content).toEqual([{ type: 'tool_use', id: 'foreign-null', name: 'read_all', input: {} }]);
  expect(body.messages[2]?.content).toEqual([
    { type: 'tool_result', tool_use_id: 'foreign-null', content: [{ type: 'text', text: 'Synthetic result.' }] },
  ]);
});
