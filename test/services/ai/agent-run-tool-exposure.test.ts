import type { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { ContactRepository } from '../../../src/database/repositories/contact.repository.ts';
import { CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import {
  AllProvidersFailedError,
  type ProviderFailure,
  type StreamRoundOptions,
} from '../../../src/services/ai/streaming.ts';
import { TelegramStreamWriter } from '../../../src/services/ai/telegram-stream.ts';
import type { AgentConfig, AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import { commonPrefixLength } from '../../helpers/common-prefix.ts';
import {
  createAgentRunFixture,
  createOwnedEvent,
  isValidatorCall,
  makeStreamImpl,
  USER_ID,
} from './agent-run-helpers.ts';

describe('CalendarBotAgent.run()', () => {
  let db: Database;
  let ctx: AgentContext;
  let config: AgentConfig;
  let sender: TelegramSender;

  beforeEach(() => {
    ({ db, ctx, config, sender } = createAgentRunFixture());
  });

  test.each([
    ['full', true, false],
    ['lazy', false, true],
  ] as const)('%s mode sends the full catalog only when it is full', async (toolSchemaMode, hasCreateEvent, hasDiscovery) => {
    const script = makeStreamImpl([{ kind: 'text', text: 'Synthetic reply.' }]);
    let toolNames: string[] = [];
    const impl: typeof script.impl = async (opts, cbs) => {
      if (!isValidatorCall(opts))
        toolNames = opts.tools?.flatMap((t) => (t.type === 'function' ? [t.function.name] : [])) ?? [];
      return script.impl(opts, cbs);
    };
    await new CalendarBotAgent({ ...config, toolSchemaMode }, sender, { streamImpl: impl }).run(ctx);
    expect(toolNames.includes('discover_tools')).toBe(hasDiscovery);
    expect(toolNames.includes('create_event')).toBe(hasCreateEvent);
  });

  test('every model round names its purpose so its usage rows say what the call was for', async () => {
    const script = makeStreamImpl([{ kind: 'text', text: 'A response requiring validation.' }]);
    const purposes: (StreamRoundOptions['purpose'] | 'validator-call')[] = [];
    const impl: typeof script.impl = async (opts, cbs) => {
      purposes.push(isValidatorCall(opts) ? 'validator-call' : opts.purpose);
      if (isValidatorCall(opts)) expect(opts.purpose).toBe('validator');
      return script.impl(opts, cbs);
    };

    await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);

    expect(purposes).toContain('agent');
    expect(purposes).not.toContain(undefined);
  });

  test('live calls keep their full tool contract during the text-only lazy canary', async () => {
    ctx.inputMode = 'live_call';
    const script = makeStreamImpl([{ kind: 'text', text: 'Synthetic spoken reply.' }]);
    let names: string[] = [];
    const impl: typeof script.impl = async (opts, cbs) => {
      if (!isValidatorCall(opts))
        names = opts.tools?.flatMap((t) => (t.type === 'function' ? [t.function.name] : [])) ?? [];
      return script.impl(opts, cbs);
    };
    await new CalendarBotAgent({ ...config, toolSchemaMode: 'lazy' }, sender, { streamImpl: impl }).run(ctx);
    expect(names).not.toContain('discover_tools');
    expect(names).toContain('end_call');
  });

  test.each([
    'full',
    'lazy',
  ] as const)('the system message sent in %s mode shares its leading bytes between users and puts the clock last', async (toolSchemaMode) => {
    const sent: string[] = [];
    const run = async (agentCtx: AgentContext) => {
      const script = makeStreamImpl([{ kind: 'text', text: 'Synthetic reply.' }]);
      const impl: typeof script.impl = async (opts, cbs) => {
        const system = opts.messages[0];
        if (!isValidatorCall(opts) && sent.length < 2 && system?.role === 'system') sent.push(String(system.content));
        return script.impl(opts, cbs);
      };
      await new CalendarBotAgent({ ...config, toolSchemaMode }, sender, { streamImpl: impl }).run(agentCtx);
    };
    const other = ctx.userRepo.create({
      telegram_id: USER_ID + 1,
      first_name: 'Борис',
      timezone: 'Pacific/Auckland',
      language: 'ru',
    });
    await run(ctx);
    await run({ ...ctx, user: other, chatId: other.telegram_id });

    expect(sent).toHaveLength(2);
    const [first, second] = sent as [string, string];
    expect(first).not.toBe(second);
    const shared = commonPrefixLength(first, second);
    // Everything before the user's own values is identical, and it is most of the prompt.
    const userInfoAt = first.indexOf('## User Info');
    expect(userInfoAt).toBeGreaterThan(0);
    expect(shared).toBeGreaterThanOrEqual(userInfoAt);
    expect(shared / first.length).toBeGreaterThan(0.8);
    expect(first.indexOf('Current local time:')).toBeGreaterThan(first.length * 0.8);
    if (toolSchemaMode === 'lazy') {
      const indexAt = first.indexOf('## Available tool names');
      expect(indexAt).toBeGreaterThan(0);
      expect(indexAt).toBeLessThan(userInfoAt);
    }
  });

  test('lazy schemas keep all names visible but expose only requested parameters', async () => {
    const script = makeStreamImpl([
      { kind: 'tool', callId: 'discover', name: 'discover_tools', input: { groups: [], tools: ['get_events'] } },
      {
        kind: 'tool',
        callId: 'events',
        name: 'get_events',
        input: { start_date: '2030-01-01T00:00:00Z', end_date: '2030-01-02T00:00:00Z' },
      },
      { kind: 'text', text: 'No matching events.' },
    ]);
    const captured: StreamRoundOptions[] = [];
    const impl: typeof script.impl = async (opts, cbs) => {
      if (!isValidatorCall(opts))
        captured.push({ ...opts, tools: structuredClone(opts.tools), messages: structuredClone(opts.messages) });
      return script.impl(opts, cbs);
    };
    const result = await new CalendarBotAgent({ ...config, toolSchemaMode: 'lazy' }, sender, { streamImpl: impl }).run(
      ctx,
    );
    expect(captured[0]?.tools?.map((tool) => (tool.type === 'function' ? tool.function.name : ''))).toEqual([
      'discover_tools',
      'calculate',
    ]);
    expect(captured[0]?.messages[0]?.content).toContain('delete_event:');
    expect(captured[1]?.tools?.map((tool) => (tool.type === 'function' ? tool.function.name : ''))).toEqual([
      'discover_tools',
      'calculate',
      'get_events',
    ]);
    expect(result.toolCalls.some((call) => call.name === 'get_events')).toBe(true);
    expect(result.toolCalls.some((call) => call.name === 'discover_tools')).toBe(false);
    const stored = JSON.stringify(ctx.chatHistory.getRecent(USER_ID));
    expect(stored).not.toContain('discover_tools');
    expect(stored).toContain('get_events');
  });

  test('lazy mode can execute calculate in the first round without discovery', async () => {
    const script = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'calc',
        name: 'calculate',
        input: { expression: '2026-07-15 12:30 Europe/Belgrade to UTC' },
      },
      { kind: 'text', text: 'Converted.' },
    ]);
    const result = await new CalendarBotAgent({ ...config, toolSchemaMode: 'lazy' }, sender, {
      streamImpl: script.impl,
    }).run(ctx);
    expect(result.toolCalls.map((call) => call.name)).toEqual(['calculate']);
    expect(result.toolResults[0]).toMatchObject({ success: true, output: '2026-07-15T10:30:00.000Z' });
    expect(JSON.stringify(ctx.chatHistory.getRecent(USER_ID))).not.toContain('TOOL_SCHEMA_NOT_EXPOSED');
  });

  test('hybrid mode sends the always-on tools in round one and runs one of them without discovery', async () => {
    const script = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'events',
        name: 'get_events',
        input: { start_date: '2030-01-01T00:00:00Z', end_date: '2030-01-02T00:00:00Z' },
      },
      { kind: 'text', text: 'Nothing planned.' },
    ]);
    const sentTools: string[][] = [];
    const impl: typeof script.impl = async (opts, cbs) => {
      if (!isValidatorCall(opts))
        sentTools.push(opts.tools?.flatMap((t) => (t.type === 'function' ? [t.function.name] : [])) ?? []);
      return script.impl(opts, cbs);
    };
    const result = await new CalendarBotAgent({ ...config, toolSchemaMode: 'hybrid' }, sender, {
      streamImpl: impl,
    }).run(ctx);
    expect(sentTools[0]).toHaveLength(18);
    expect(sentTools[0]).toContain('discover_tools');
    expect(sentTools[0]).toContain('get_events');
    expect(sentTools[0]).not.toContain('get_history');
    // Same tools, same order, next round: nothing was revealed, so the cached prefix is untouched.
    expect(sentTools[1]).toEqual(sentTools[0]);
    expect(result.toolCalls.map((call) => call.name)).toEqual(['get_events']);
    expect(JSON.stringify(ctx.chatHistory.getRecent(USER_ID))).not.toContain('TOOL_SCHEMA_NOT_EXPOSED');
  });

  test('hybrid mode reveals a tool outside the always-on set with one discovery round', async () => {
    const script = makeStreamImpl([
      { kind: 'tool', callId: 'discover', name: 'discover_tools', input: { tools: ['get_history'] } },
      { kind: 'text', text: 'Looked it up.' },
    ]);
    const sentTools: string[][] = [];
    const impl: typeof script.impl = async (opts, cbs) => {
      if (!isValidatorCall(opts))
        sentTools.push(opts.tools?.flatMap((t) => (t.type === 'function' ? [t.function.name] : [])) ?? []);
      return script.impl(opts, cbs);
    };
    await new CalendarBotAgent({ ...config, toolSchemaMode: 'hybrid' }, sender, { streamImpl: impl }).run(ctx);
    expect(sentTools[1]).toEqual([...(sentTools[0] ?? []), 'get_history']);
  });

  test('hybrid mode sends the always-on tools plus discovery, and live calls keep the full contract', async () => {
    const names = async (inputMode?: 'live_call') => {
      ctx.inputMode = inputMode ?? ctx.inputMode;
      const script = makeStreamImpl([{ kind: 'text', text: 'Synthetic reply.' }]);
      let sent: string[] = [];
      const impl: typeof script.impl = async (opts, cbs) => {
        if (!isValidatorCall(opts))
          sent = opts.tools?.flatMap((t) => (t.type === 'function' ? [t.function.name] : [])) ?? [];
        return script.impl(opts, cbs);
      };
      await new CalendarBotAgent({ ...config, toolSchemaMode: 'hybrid' }, sender, { streamImpl: impl }).run(ctx);
      return sent;
    };
    const text = await names();
    expect(text).toContain('discover_tools');
    expect(text).toContain('create_event');
    expect(text).not.toContain('get_history');
    expect(await names('live_call')).not.toContain('discover_tools');
  });

  test('discover_tools recovers from single-array payloads instead of exhausting into a hallucinated answer (GH-285 incident)', async () => {
    ctx.messageText = '@ghost_handle 15:00 tomorrow call';
    const script = makeStreamImpl([
      { kind: 'tool', callId: 'blind', name: 'find_user', input: { username: 'ghost_handle' } },
      { kind: 'tool', callId: 'discover-groups-only', name: 'discover_tools', input: { groups: ['contacts'] } },
      { kind: 'tool', callId: 'discover-tools-only', name: 'discover_tools', input: { tools: ['find_user'] } },
      { kind: 'tool', callId: 'lookup', name: 'find_user', input: { username: 'ghost_handle' } },
      { kind: 'text', text: 'Cannot verify that username right now.' },
    ]);
    const result = await new CalendarBotAgent({ ...config, toolSchemaMode: 'lazy' }, sender, {
      streamImpl: script.impl,
    }).run(ctx);
    const findUserCalls = result.toolCalls.filter((call) => call.name === 'find_user');
    expect(findUserCalls).toHaveLength(2);
    // The first attempt is correctly rejected as unexposed; the second, after
    // single-array discovery succeeds, must reach the real handler and report
    // truthfully that resolution is unavailable rather than lying about "not found".
    const stored = JSON.stringify(ctx.chatHistory.getRecent(USER_ID));
    expect(stored).toContain('unavailable');
    expect(stored).not.toContain('User @ghost_handle not found');
  });

  test('validation retry retains revealed schemas without replaying discovery', async () => {
    const script = makeStreamImpl([
      { kind: 'tool', callId: 'discovery', name: 'discover_tools', input: { groups: [], tools: ['get_events'] } },
      { kind: 'text', text: 'You have seven events today.' },
      {
        kind: 'tool',
        callId: 'actual-read',
        name: 'get_events',
        input: { start_date: '2030-01-01T00:00:00Z', end_date: '2030-01-02T00:00:00Z' },
      },
      { kind: 'text', text: 'No matching events.' },
    ]);
    let validators = 0;
    let calls = 0;
    const impl: typeof script.impl = async (opts, cbs) => {
      if (!isValidatorCall(opts)) {
        if (calls++ === 2)
          expect(opts.tools?.some((t) => t.type === 'function' && t.function.name === 'get_events')).toBe(true);
        return script.impl(opts, cbs);
      }
      const result = await script.impl(opts, cbs);
      const verdict = validators++ === 0 ? 'REJECT: no calendar evidence' : 'APPROVE';
      return { ...result, text: verdict, assistantMessage: { role: 'assistant' as const, content: verdict } };
    };
    const result = await new CalendarBotAgent({ ...config, toolSchemaMode: 'lazy' }, sender, { streamImpl: impl }).run(
      ctx,
    );
    expect(validators).toBe(2);
    expect(calls).toBe(4);
    expect(result.toolCalls.map((t) => t.name)).toEqual(['get_events']);
    expect(result.responseText).toContain('No matching events.');
  });

  test('an unexposed rejection does not poison dedup after the schema is revealed', async () => {
    const event = createOwnedEvent(ctx);
    const change = spyOn(ctx.eventService, 'updateEvent');
    const input = { event_id: event.id, title: 'Verified later change' };
    const script = makeStreamImpl([
      { kind: 'tool', callId: 'denied', name: 'update_event', input },
      { kind: 'tool', callId: 'reveal', name: 'discover_tools', input: { groups: [], tools: ['update_event'] } },
      { kind: 'tool', callId: 'apply', name: 'update_event', input },
      { kind: 'text', text: 'The title was changed.' },
    ]);
    try {
      const result = await new CalendarBotAgent({ ...config, toolSchemaMode: 'lazy' }, sender, {
        streamImpl: script.impl,
      }).run(ctx);
      expect(change).toHaveBeenCalledTimes(1);
      expect(ctx.eventService.getEvent(event.id, USER_ID)?.title).toBe('Verified later change');
      expect(result.responseText).not.toContain('Not completed');
      expect(result.toolCalls.map((call) => call.name)).toEqual(['update_event', 'update_event']);
    } finally {
      change.mockRestore();
    }
  });

  test('silent schema discovery never marks a visible operation completed', async () => {
    const marker = spyOn(TelegramStreamWriter.prototype, 'markToolResult');
    try {
      const script = makeStreamImpl([
        { kind: 'tool', callId: 'discover', name: 'discover_tools', input: { groups: [], tools: ['calculate'] } },
        { kind: 'text', text: 'Ready for a calculation.' },
      ]);
      await new CalendarBotAgent({ ...config, toolSchemaMode: 'lazy' }, sender, { streamImpl: script.impl }).run(ctx);
      expect(marker).not.toHaveBeenCalled();
    } finally {
      marker.mockRestore();
    }
  });

  test('unexposed mutating tool is rejected without calling the real handler', async () => {
    const event = createOwnedEvent(ctx);
    const change = spyOn(ctx.eventService, 'updateEvent');
    const script = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'wrong',
        name: 'update_event',
        input: { event_id: event.id, title: 'Incorrectly changed' },
      },
      { kind: 'text', text: 'Updated.' },
    ]);
    await new CalendarBotAgent({ ...config, toolSchemaMode: 'lazy' }, sender, { streamImpl: script.impl }).run(ctx);
    expect(change).not.toHaveBeenCalled();
    expect(ctx.eventService.getEvent(event.id, USER_ID)?.title).not.toBe('Incorrectly changed');
  });

  test('a blindly called mutating tool is exposed next round instead of failing forever (GH-344)', async () => {
    // Anonymized shape of a real production incident: the model called a mutating
    // contacts tool directly, without ever calling discover_tools, with a payload
    // missing the required `name` field — because it had only ever seen the
    // one-line index description, not the real schema. Both attempts failed
    ctx.messageText = '@someuser Name\nAdd to contacts';
    const contactRepo = new ContactRepository(db);
    ctx.contactRepo = contactRepo;
    const upsert = spyOn(contactRepo, 'upsert');
    const blindInput = { username: 'someuser', preferred_name: 'Name' };
    const correctedInput = { name: 'Name', username: 'someuser', preferred_name: 'Name' };
    const script = makeStreamImpl([
      { kind: 'tool', callId: 'blind', name: 'add_contact', input: blindInput },
      { kind: 'tool', callId: 'corrected', name: 'add_contact', input: correctedInput },
      { kind: 'text', text: 'Saved.' },
    ]);
    const captured: StreamRoundOptions[] = [];
    const impl: typeof script.impl = async (opts, cbs) => {
      if (!isValidatorCall(opts)) captured.push({ ...opts, tools: structuredClone(opts.tools) });
      return script.impl(opts, cbs);
    };
    const result = await new CalendarBotAgent({ ...config, toolSchemaMode: 'lazy' }, sender, {
      streamImpl: impl,
    }).run(ctx);
    // Round 2's tool contract must expose add_contact's real schema — the model
    // finally sees `name` is required instead of guessing from the index blurb.
    const round2Names = captured[1]?.tools?.flatMap((t) => (t.type === 'function' ? [t.function.name] : []));
    expect(round2Names).toContain('add_contact');
    // Round 1 is rejected by the exposure gate (TOOL_SCHEMA_NOT_EXPOSED) before it ever
    // reaches dispatcher validation or the handler — the payload's missing `name` field
    // is never even checked for that call. contactRepo.upsert must therefore be called
    // exactly once, for round 2's now-valid corrected retry. A row-count assertion alone
    // can't prove this: upsert is keyed by username, so two calls would collapse into
    // the same one row just as cleanly as one call would.
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(contactRepo.list(USER_ID)).toHaveLength(1);
    expect(result.toolCalls.filter((call) => call.name === 'add_contact')).toHaveLength(2);
    // add_contact is not in WriteOutcomes' targeted-dedup map (unlike update_event/
    // send_invitation), so the failed attempt 1 is never superseded by attempt 2's
    // success — the user sees both as a receipt, not a clean "Saved." reply. That is
    // pre-existing write-outcomes framing, not something this fix changes; pin what
    // is actually shown rather than a substring that happens to also match "Saved.".
    expect(result.responseText).toContain('Attempt 2: Completed');
    expect(result.responseText).not.toContain('Saved.');
  });

  test('a provider rejecting a call to an unexposed tool reveals it and retries the round instead of failing the chain', async () => {
    ctx.messageText = '@someuser Name\nAdd to contacts';
    const contactRepo = new ContactRepository(db);
    ctx.contactRepo = contactRepo;
    const upsert = spyOn(contactRepo, 'upsert');
    const rejection: ProviderFailure = {
      provider: 'HF (hf-main)',
      providerId: 'hf',
      model: 'hf-main',
      message:
        "Tool call validation failed: tool call validation failed: attempted to call tool 'add_contact' which was not in request.tools",
      transient: true,
    };
    const script = makeStreamImpl([
      { kind: 'error', error: new AllProvidersFailedError([rejection]) },
      { kind: 'tool', callId: 'ok', name: 'add_contact', input: { name: 'Name', username: 'someuser' } },
      { kind: 'text', text: 'Saved.' },
    ]);
    const captured: StreamRoundOptions[] = [];
    const impl: typeof script.impl = async (opts, cbs) => {
      if (!isValidatorCall(opts)) captured.push({ ...opts, tools: structuredClone(opts.tools) });
      return script.impl(opts, cbs);
    };
    await new CalendarBotAgent({ ...config, toolSchemaMode: 'lazy' }, sender, { streamImpl: impl }).run(ctx);
    const retryNames = captured[1]?.tools?.flatMap((t) => (t.type === 'function' ? [t.function.name] : []));
    expect(retryNames).toContain('add_contact');
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(contactRepo.list(USER_ID)).toHaveLength(1);
  });
});
