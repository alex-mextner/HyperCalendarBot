import { describe, expect, spyOn, test } from 'bun:test';
import OpenAI from 'openai';
import { DRYRUN_CASES } from '../../scripts/dryrun-cases.ts';
import {
  type CaseOutcome,
  classifyTurn,
  formatOutcomeRow,
  type ProviderSpec,
  runCase,
  totalsByProvider,
  verdict,
} from '../../scripts/dryrun-tool-selection.ts';
import { createClaudeClient } from '../../src/services/ai/claude-client-pool.ts';
import { DISCOVERY_TOOL } from '../../src/services/ai/tool-exposure.ts';

const outcome = (overrides: Partial<CaseOutcome>): CaseOutcome => ({
  id: 'case-1',
  provider: 'zai',
  model: 'm',
  temperature: 0,
  maxTokens: 100,
  tools: [],
  text: '',
  promptTokens: null,
  finishReason: null,
  error: null,
  discoverRounds: 0,
  blindCalls: 0,
  ok: true,
  ...overrides,
});

describe('dryrun tool-selection scoring', () => {
  test('classifyTurn: with every schema carried nothing is blind and a real tool is the first move', () => {
    expect(classifyTurn(['get_events'], undefined)).toEqual({
      discovered: false,
      blind: [],
      firstMoves: ['get_events'],
      needsAnotherRound: false,
    });
  });

  test('classifyTurn: a tool without a schema in the request is blind and forces another round', () => {
    expect(classifyTurn(['create_event'], new Set(['calculate']))).toEqual({
      discovered: false,
      blind: ['create_event'],
      firstMoves: [],
      needsAnotherRound: true,
    });
  });

  test('classifyTurn: a discovery call alone needs another round and is never a first move', () => {
    expect(classifyTurn([DISCOVERY_TOOL], new Set(['calculate']))).toEqual({
      discovered: true,
      blind: [],
      firstMoves: [],
      needsAnotherRound: true,
    });
  });

  test('classifyTurn: discovery next to a carried real tool is already the first move', () => {
    expect(classifyTurn([DISCOVERY_TOOL, 'calculate', 'create_event'], new Set(['calculate']))).toEqual({
      discovered: true,
      blind: ['create_event'],
      firstMoves: ['calculate'],
      needsAnotherRound: false,
    });
  });

  test('classifyTurn: a text-only answer needs no further round', () => {
    expect(classifyTurn([], new Set(['calculate'])).needsAnotherRound).toBe(false);
  });

  test('verdict: silence must be exactly [SKIP] with only silent tools', () => {
    const silent = { id: 's', message: 'hi', expectSilence: true as const };
    expect(verdict(silent, [], ' [SKIP] ')).toBe(true);
    expect(verdict(silent, ['set_reaction'], '[SKIP]')).toBe(true);
    expect(verdict(silent, ['get_events'], '[SKIP]')).toBe(false);
    expect(verdict(silent, [], 'sure!')).toBe(false);
  });

  test('verdict: any expected tool passes, but a parallel destructive tool it did not expect fails', () => {
    const expecting = { id: 'e', message: 'agenda', expectAnyOf: ['get_events'] as [string, ...string[]] };
    expect(verdict(expecting, ['get_events'], '')).toBe(true);
    expect(verdict(expecting, ['search_events'], '')).toBe(false);
    expect(verdict(expecting, ['get_events', 'delete_event'], '')).toBe(false);
    const deleting = { id: 'd', message: 'delete', expectAnyOf: ['delete_event'] as [string, ...string[]] };
    expect(verdict(deleting, ['delete_event'], '')).toBe(true);
  });

  test('formatOutcomeRow: shows tools, a non-default finish reason and discovery counts', () => {
    const row = formatOutcomeRow(
      outcome({ tools: ['get_events', 'calculate'], finishReason: 'length', discoverRounds: 1, blindCalls: 2 }),
    );
    expect(row).toBe(`ok   zai     ${'case-1'.padEnd(22)} get_events,calculate [length] (discover rounds 1, blind 2)`);
  });

  test('formatOutcomeRow: a tool_calls finish reason is not repeated, and a no-tool answer quotes the text', () => {
    const row = formatOutcomeRow(outcome({ ok: false, text: `  ${'x'.repeat(60)}`, finishReason: 'tool_calls' }));
    expect(row).toBe(`FAIL zai     ${'case-1'.padEnd(22)} "${'x'.repeat(40)}"`);
    expect(formatOutcomeRow(outcome({ ok: false, text: '' }))).toContain('""');
  });

  test('formatOutcomeRow: an error replaces the choice', () => {
    expect(formatOutcomeRow(outcome({ ok: false, error: 'timeout', tools: ['ignored'] }))).toContain('ERROR timeout');
  });

  test('totalsByProvider: counts passes, collects first-request tokens and sums discovery per provider', () => {
    const totals = totalsByProvider([
      outcome({ provider: 'zai', ok: true, promptTokens: 100, discoverRounds: 1, blindCalls: 0 }),
      outcome({ provider: 'zai', ok: false, promptTokens: null, discoverRounds: 2, blindCalls: 3 }),
      outcome({ provider: 'hf', ok: true, promptTokens: 40 }),
    ]);
    expect([...totals.keys()]).toEqual(['zai', 'hf']);
    expect(totals.get('zai')).toEqual({ pass: 1, total: 2, tokens: [100], rounds: 3, blind: 3 });
    expect(totals.get('hf')).toEqual({ pass: 1, total: 1, tokens: [40], rounds: 0, blind: 0 });
  });
});

describe('dryrun request round', () => {
  interface Recorded {
    authorization: string | null;
    body: unknown;
  }

  const jsonObject = (body: unknown): body is { [key: string]: unknown } =>
    typeof body === 'object' && body !== null && !Array.isArray(body);
  const fieldOf = (body: unknown, key: string): unknown => {
    if (!jsonObject(body)) throw new Error('request body is not a JSON object');
    return body[key];
  };
  const keysOf = (body: unknown): string[] => {
    if (!jsonObject(body)) throw new Error('request body is not a JSON object');
    return Object.keys(body);
  };

  // No network: answers each request with the next scripted status (default: 200 with one
  // get_events tool call). Error replies carry retry-after-ms: 0 so SDK retries never sleep.
  const transport =
    (recorded: Recorded[], statuses: number[] = []) =>
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      const status = statuses[recorded.length] ?? 200;
      recorded.push({
        authorization: request.headers.get('authorization'),
        body: JSON.parse(await request.text()),
      });
      if (status !== 200) {
        return new Response(JSON.stringify({ error: { message: 'synthetic', type: 'synthetic' } }), {
          status,
          headers: { 'content-type': 'application/json', 'retry-after-ms': '0' },
        });
      }
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-synthetic',
          object: 'chat.completion',
          created: 0,
          model: 'synthetic-model',
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_events', arguments: '{}' } }],
              },
            },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
  const providerFor = (name: ProviderSpec['name'], client: OpenAI): ProviderSpec => ({
    name,
    model: 'synthetic-model',
    client: () => client,
  });
  const testCase = DRYRUN_CASES[0];
  if (!testCase) throw new Error('DRYRUN_CASES is empty');
  const baseURL = 'https://api.anthropic.com/v1';

  for (const malformed of ['bad\u200btoken', 'tok\u2026en', 'tok\r\nen']) {
    for (const tokens of [[malformed], [malformed, `${malformed}2`]]) {
      test(`claude with only malformed credentials (${tokens.length}) fails closed without echoing a token`, async () => {
        const recorded: Recorded[] = [];
        const client = createClaudeClient(tokens, { baseURL, fetch: transport(recorded) });
        const create = spyOn(client.chat.completions, 'create');
        const result = await runCase(providerFor('claude', client), testCase);
        expect(create).not.toHaveBeenCalled();
        expect(recorded).toEqual([]);
        expect(result.ok).toBe(false);
        expect(result.error).toBe('Claude API token is not a valid HTTP header value');
        for (const token of tokens) {
          expect(JSON.stringify(result)).not.toContain(token.trim());
          expect(formatOutcomeRow(result)).not.toContain(token.trim());
        }
      });
    }
  }

  const expectedKeys = ['max_tokens', 'messages', 'model', 'temperature', 'tools'];

  test('claude with one usable key among malformed ones has no pool, so the SDK retries a 429 in place', async () => {
    const recorded: Recorded[] = [];
    const client = createClaudeClient(['bad\u200btoken', 'backup'], {
      baseURL,
      fetch: transport(recorded, [429, 200]),
    });
    const create = spyOn(client.chat.completions, 'create');
    const result = await runCase(providerFor('claude', client), testCase);
    expect(result.error).toBeNull();
    expect(result.tools).toEqual(['get_events']);
    expect(recorded.map((r) => r.authorization)).toEqual(['Bearer backup', 'Bearer backup']);
    expect(recorded[1]?.body).toEqual(recorded[0]?.body);
    expect(fieldOf(recorded[0]?.body, 'model')).toBe('synthetic-model');
    expect(create.mock.calls[0]?.[1]).toMatchObject({ maxRetries: 4 });
  });

  test('claude with a single configured key retries a 429 with the same request', async () => {
    const recorded: Recorded[] = [];
    const client = createClaudeClient(['backup'], { baseURL, fetch: transport(recorded, [429, 200]) });
    const create = spyOn(client.chat.completions, 'create');
    const result = await runCase(providerFor('claude', client), testCase);
    expect(result.error).toBeNull();
    expect(result.tools).toEqual(['get_events']);
    expect(recorded.map((r) => r.authorization)).toEqual(['Bearer backup', 'Bearer backup']);
    expect(recorded[1]?.body).toEqual(recorded[0]?.body);
    expect(fieldOf(recorded[0]?.body, 'model')).toBe('synthetic-model');
    expect(create.mock.calls[0]?.[1]).toMatchObject({ maxRetries: 4 });
  });

  test('claude with two keys rotates on 401 and retries a 429 on the next key with identical requests', async () => {
    const recorded: Recorded[] = [];
    const client = createClaudeClient(['primary', 'backup'], {
      baseURL,
      fetch: transport(recorded, [401, 429, 200]),
    });
    const create = spyOn(client.chat.completions, 'create');
    const result = await runCase(providerFor('claude', client), testCase);
    expect(result.error).toBeNull();
    expect(result.tools).toEqual(['get_events']);
    expect(recorded.map((r) => r.authorization)).toEqual(['Bearer primary', 'Bearer backup', 'Bearer backup']);
    expect(recorded[1]?.body).toEqual(recorded[0]?.body);
    expect(recorded[2]?.body).toEqual(recorded[0]?.body);
    expect(fieldOf(recorded[0]?.body, 'model')).toBe('synthetic-model');
    for (const call of create.mock.calls) expect(call[1]).toMatchObject({ maxRetries: 4 });
  });

  test('non-claude providers keep the direct call, SDK retries and unforced tools', async () => {
    const recorded: Recorded[] = [];
    const client = new OpenAI({
      apiKey: 'synthetic',
      baseURL: 'https://dryrun.invalid/v1',
      fetch: transport(recorded),
    });
    const create = spyOn(client.chat.completions, 'create');
    const result = await runCase(providerFor('zai', client), testCase);
    expect(result.error).toBeNull();
    expect(result.tools).toEqual(['get_events']);
    expect(recorded).toHaveLength(1);
    const body = recorded[0]?.body;
    expect(keysOf(body).sort()).toEqual(expectedKeys);
    expect(fieldOf(body, 'model')).toBe('synthetic-model');
    expect(fieldOf(body, 'temperature')).toBe(0);
    expect(create.mock.calls[0]?.[1]).toMatchObject({ maxRetries: 4 });
  });
});
