import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import { AllProvidersFailedError } from '../../../src/services/ai/streaming.ts';
import {
  createToolExposure,
  HYBRID_ALWAYS_ON_TOOLS,
  runRoundRevealingRejectedTools,
} from '../../../src/services/ai/tool-exposure.ts';
import { getToolDefinitions } from '../../../src/services/ai/tools.ts';
import { initProviderAlerts, isAiChainDown, resetProviderAlertState } from '../../../src/utils/ai-provider-alert.ts';

const allowed = getToolDefinitions('text');
test('calculate is available on the first lazy round because the prompt requires it', () => {
  const s = createToolExposure(allowed);
  expect(s.schemas().flatMap((tool) => (tool.type === 'function' ? [tool.function.name] : []))).toEqual([
    'discover_tools',
    'calculate',
  ]);
  expect(s.intercept('calculate', { expression: '2 + 2' }, s.snapshot())).toBeUndefined();
});
test('new schemas do not authorize another call in the same model batch', () => {
  const s = createToolExposure(allowed);
  const original = s.snapshot();
  expect(s.intercept('discover_tools', { groups: ['calendar.write'], tools: [] }, original)?.success).toBe(true);
  expect(s.intercept('update_event', { event_id: 1 }, original)?.success).toBe(false);
  expect(s.intercept('update_event', { event_id: 1 }, s.snapshot())).toBeUndefined();
});
test('schema and index fidelity survive caller mutations', () => {
  const original = structuredClone(allowed);
  const s = createToolExposure(original);
  const before = s.prompt;
  original.length = 0;
  s.intercept('discover_tools', { groups: [], tools: ['calculate'] }, s.snapshot());
  const schemas = s.schemas();
  const canonical = allowed.find((t) => t.type === 'function' && t.function.name === 'calculate');
  expect(schemas[1]).toEqual(canonical);
  schemas.length = 0;
  expect(s.schemas()).toHaveLength(2);
  expect(s.prompt).toBe(before);
  expect(s.prompt).toContain('delete_event:');
  expect(s.prompt).toContain('calculate:');
});
test('unknown tool cannot become executable', () => {
  const s = createToolExposure(allowed);
  const result = s.intercept('discover_tools', { groups: [], tools: ['not_a_tool'] }, s.snapshot());
  expect(result?.output).toContain('not_a_tool');
  const blind = s.intercept('not_a_tool', {}, s.snapshot());
  expect(blind?.success).toBe(false);
  expect(blind?.error).toContain('reveal the tool');
  expect(blind?.error).not.toContain('budget');
});
test('discovery returns names, not a second copy of full parameter schemas', () => {
  const s = createToolExposure(allowed);
  const r = s.intercept('discover_tools', { groups: ['calendar.read'], tools: ['calculate'] }, s.snapshot());
  expect(r?.success).toBe(true);
  expect(r?.output).toContain('get_events');
  expect(r?.output).not.toContain('properties');
  expect(r?.output).not.toContain('description');
});
test('bounded discovery never evicts already disclosed schemas', () => {
  const s = createToolExposure(allowed);
  for (let i = 0; i < 6; i++)
    expect(s.intercept('discover_tools', { groups: [], tools: ['calculate'] }, s.snapshot())?.success).toBe(true);
  const limitHit = s.intercept('discover_tools', { groups: [], tools: ['get_event'] }, s.snapshot());
  expect(limitHit?.success).toBe(false);
  expect(limitHit?.error).toContain('use already revealed tools or explain what remains unavailable');
  expect(s.intercept('calculate', {}, s.snapshot())).toBeUndefined();
});
test('mode-specific tools are not advertised or activated', () => {
  const voice = createToolExposure(getToolDefinitions('live_call'));
  expect(voice.prompt).not.toContain('render_day_image:');
  expect(voice.intercept('render_day_image', {}, voice.snapshot())?.success).toBe(false);
  const supplement = createToolExposure(getToolDefinitions('text', true));
  expect(supplement.prompt).toContain('supplement_skip:');
  expect(supplement.prompt).not.toContain('end_conversation:');
});
test('invalid discovery input does not activate anything', () => {
  const s = createToolExposure(allowed);
  for (const input of [
    null,
    { groups: 'calendar.read' },
    { tools: [], extra: true },
    { tools: Array(25).fill('get_event') },
  ])
    expect(s.intercept('discover_tools', input, s.snapshot())?.success).toBe(false);
  expect(s.schemas()).toHaveLength(2);
});

test('discovery accepts groups alone, defaulting tools to empty (reproduces GH-285 incident payload)', () => {
  const s = createToolExposure(allowed);
  const result = s.intercept('discover_tools', { groups: ['contacts'] }, s.snapshot());
  expect(result?.success).toBe(true);
  expect(result?.output).toContain('find_user');
  expect(s.intercept('find_user', { username: 'ghost_handle' }, s.snapshot())?.success).toBeUndefined();
});

test('discovery accepts tools alone, defaulting groups to empty (reproduces GH-285 incident payload)', () => {
  const s = createToolExposure(allowed);
  const result = s.intercept('discover_tools', { tools: ['find_user'] }, s.snapshot());
  expect(result?.success).toBe(true);
  expect(result?.output).toContain('find_user');
});

test('discovery with neither array present is still rejected (at least one selector required)', () => {
  const s = createToolExposure(allowed);
  const result = s.intercept('discover_tools', {}, s.snapshot());
  expect(result?.success).toBe(false);
  expect(s.schemas()).toHaveLength(2);
});

test('published discover_tools schema agrees with runtime validation on the empty-request case', () => {
  const s = createToolExposure(allowed);
  const discoverySchema = s.schemas().find((t) => t.type === 'function' && t.function.name === 'discover_tools');
  if (discoverySchema?.type !== 'function') throw new Error('discover_tools schema missing');
  // required: [] alone would make {} schema-valid while the runtime rejects it
  // (GH-341); minProperties: 1 closes that gap at the schema level too.
  expect(discoverySchema.function.parameters?.required).toEqual([]);
  expect(discoverySchema.function.parameters?.minProperties).toBe(1);
});

test('a blindly called tool (no discover_tools) is exposed for the next round instead of failing forever (GH-344)', () => {
  // Anonymized production shape: the model called a mutating contacts tool directly,
  // twice in a row, without ever calling discover_tools first. Both attempts failed
  // identically with TOOL_SCHEMA_NOT_EXPOSED and the run gave up without saving
  // anything, because a blind miss never exposed the tool for a later round.
  const s = createToolExposure(allowed);
  const original = s.snapshot();
  const roundOne = s.intercept('add_contact', { username: 'someuser', preferred_name: 'Name' }, original);
  expect(roundOne?.success).toBe(false);
  expect(roundOne?.mutationState).toBe('not_applied');
  expect(roundOne?.error).toContain('now revealed');
  // The schema excerpt must be inline in the rejection text itself, not only
  // structurally in the next round's tools list — some providers don't
  // reliably re-attend to a tools array that grew between rounds.
  expect(roundOne?.error).toContain('name (string, required)');
  // A same-batch retry (same round, same stale snapshot) must still be blocked —
  // "never execute a newly discovered tool in the same batch" is unaffected.
  expect(s.intercept('add_contact', { username: 'someuser', preferred_name: 'Name' }, original)?.success).toBe(false);
  // The NEXT round's snapshot must now include add_contact so the model's retry —
  // informed by the real schema this time, not just the one-line index blurb — can
  // actually reach the handler instead of repeating the same rejection forever.
  const nextRound = s.snapshot();
  expect(nextRound.has('add_contact')).toBe(true);
  expect(s.intercept('add_contact', { name: 'Name', username: 'someuser', preferred_name: 'Name' }, nextRound)).toBe(
    undefined,
  );
});

test('blind-call schema excerpt names every field with its type, required/optional and description (#346)', () => {
  const s = createToolExposure(allowed);
  const result = s.intercept('add_contact', {}, s.snapshot());
  expect(result?.error).toContain('name (string, required) — Full display name');
  expect(result?.error).toContain('username (string, optional) — Telegram @username without @.');
  expect(result?.error).toContain('preferred_name (string, optional)');
});

test('a blind call still fails forever once the active-schema budget is exhausted (known, bounded degradation)', () => {
  // Auto-exposing a blind call is best-effort: if the run has already spent its
  // active-schema budget (e.g. on other blind misses or large discover_tools
  // batches), the tool cannot be silently activated and the original failure
  // mode this diff fixes reappears — but only at that documented boundary, and
  // it never crashes or corrupts state. Each description stays under the
  // catalog's own single-request budget (16,000 chars) so every blind call
  // resolves individually; four of them exceed the exposure session's
  // cumulative 48,000-char active-schema budget.
  const bigDescription = 'x'.repeat(14_000);
  const names = ['tool_a', 'tool_b', 'tool_c', 'tool_d'];
  const synthetic: OpenAI.ChatCompletionTool[] = names.map((name) => ({
    type: 'function',
    function: { name, description: bigDescription, parameters: { type: 'object', properties: {} } },
  }));
  const s = createToolExposure(synthetic);
  for (const name of names.slice(0, 3)) {
    expect(s.intercept(name, {}, s.snapshot())?.success).toBe(false);
    expect(s.snapshot().has(name)).toBe(true);
  }
  const overBudget = s.intercept('tool_d', {}, s.snapshot());
  expect(overBudget?.success).toBe(false);
  expect(overBudget?.mutationState).toBe('not_applied');
  expect(overBudget?.error).toContain("cannot be revealed within this run's reveal budget");
  expect(s.snapshot().has('tool_d')).toBe(false);
});

test('a single tool too large for the catalog per-request budget reports budget_exhausted, not unknown', () => {
  // catalog.describe({ tools: [name] }) defers a tool whose own schema alone
  // exceeds its 16,000-char per-request budget — that tool is known, just
  // permanently unrevealable via this path. The blind-call rejection must say
  // so honestly instead of the generic "reveal it" message, which would be a
  // guaranteed-to-fail instruction for a name that can never be discovered.
  const oversized: OpenAI.ChatCompletionTool = {
    type: 'function',
    function: { name: 'huge_tool', description: 'x'.repeat(20_000), parameters: { type: 'object', properties: {} } },
  };
  const s = createToolExposure([oversized]);
  const result = s.intercept('huge_tool', {}, s.snapshot());
  expect(result?.success).toBe(false);
  expect(result?.error).toContain("cannot be revealed within this run's reveal budget");
  expect(s.snapshot().has('huge_tool')).toBe(false);
});

describe('runRoundRevealingRejectedTools', () => {
  beforeEach(() => {
    resetProviderAlertState();
    initProviderAlerts({ botToken: 't', adminId: 1, send: async () => {} });
  });

  afterEach(() => {
    resetProviderAlertState();
  });

  const REJECTION = "attempted to call tool 'update_event' which was not in request.tools";

  function rejected(deferredAlertChain?: 'smart' | 'fast'): AllProvidersFailedError {
    return new AllProvidersFailedError(
      [
        {
          provider: 'hf (test)',
          providerId: 'hf',
          model: 'test',
          status: 400,
          message: REJECTION,
          transient: false,
        },
      ],
      undefined,
      deferredAlertChain,
    );
  }

  test('a rejected tool is revealed and the round retried with its schema', async () => {
    const exposure = createToolExposure(allowed);
    const sent: string[][] = [];
    const { result } = await runRoundRevealingRejectedTools(exposure, async (tools, deferOutageAlert) => {
      expect(deferOutageAlert).toBe(true);
      sent.push(tools.map((t) => (t.type === 'function' ? t.function.name : '')));
      if (sent.length === 1) throw rejected('smart');
      return 'answered';
    });
    expect(result).toBe('answered');
    expect(sent[0]).not.toContain('update_event');
    expect(sent[1]).toContain('update_event');
  });

  test('giving up on a deferred rejection reports the outage on the chain the round ran on', async () => {
    const exposure = createToolExposure(allowed);
    await expect(
      runRoundRevealingRejectedTools(exposure, async () => {
        throw rejected('smart');
      }),
    ).rejects.toThrow(AllProvidersFailedError);
    expect(isAiChainDown()).toBe(true);
  });

  test('a tool still rejected after it was revealed is retried once, then reported', async () => {
    const exposure = createToolExposure(allowed);
    let rounds = 0;
    await expect(
      runRoundRevealingRejectedTools(exposure, async () => {
        rounds++;
        throw rejected('smart');
      }),
    ).rejects.toThrow(AllProvidersFailedError);
    expect(rounds).toBe(2);
    expect(isAiChainDown()).toBe(true);
  });

  test('a failure the round reported itself is left alone', async () => {
    const exposure = createToolExposure(allowed);
    await expect(
      runRoundRevealingRejectedTools(exposure, async () => {
        throw rejected();
      }),
    ).rejects.toThrow(AllProvidersFailedError);
    expect(isAiChainDown()).toBe(false);
  });
});

describe('hybrid exposure: the most-used tools always loaded, the rest behind a compact index', () => {
  const toolName = (tool: OpenAI.ChatCompletionTool) => (tool.type === 'function' ? tool.function.name : '');
  const names = (tools: readonly OpenAI.ChatCompletionTool[]) => tools.map(toolName);

  test('the first round carries discover_tools and exactly the always-on tools, in catalog order', () => {
    const s = createToolExposure(allowed, 'hybrid');
    const loaded = names(s.schemas());
    expect(loaded[0]).toBe('discover_tools');
    expect(loaded.slice(1)).toEqual(names(allowed).filter((name) => HYBRID_ALWAYS_ON_TOOLS.includes(name)));
    expect(loaded.slice(1)).toHaveLength(15);
  });

  test('the always-on set is the 15 most called tools in production and exists in the text catalog', () => {
    // Counted from chat_history tool_calls on 2026-10-25 (aggregates only); 705 of 722 persisted calls (98%).
    expect([...HYBRID_ALWAYS_ON_TOOLS].sort()).toEqual(
      [
        'add_contact',
        'ask_user',
        'calculate',
        'create_event',
        'delete_event',
        'find_contact',
        'find_user',
        'get_contacts',
        'get_events',
        'pick_users',
        'render_day_image',
        'render_week_image',
        'search_events',
        'send_invitation',
        'update_event',
      ].sort(),
    );
    expect(names(allowed)).toEqual(expect.arrayContaining([...HYBRID_ALWAYS_ON_TOOLS]));
  });

  test('every always-on tool runs on the first round without a discovery call', () => {
    const s = createToolExposure(allowed, 'hybrid');
    for (const name of HYBRID_ALWAYS_ON_TOOLS) expect(s.intercept(name, {}, s.snapshot())).toBeUndefined();
  });

  test('a tool outside the always-on set still needs discovery, and discovery reveals it for the next round', () => {
    const s = createToolExposure(allowed, 'hybrid');
    const before = s.snapshot();
    expect(s.intercept('get_history', {}, before)?.success).toBe(false);
    expect(s.intercept('discover_tools', { tools: ['get_action_log'] }, s.snapshot())?.success).toBe(true);
    expect(s.snapshot().has('get_action_log')).toBe(true);
  });

  test('the index lists only the tools whose schema is not loaded', () => {
    const s = createToolExposure(allowed, 'hybrid');
    // Index lines start with the tool name; another tool's description may mention it in passing.
    for (const name of HYBRID_ALWAYS_ON_TOOLS) expect(s.prompt).not.toMatch(new RegExp(`^${name}: `, 'm'));
    for (const name of ['get_history', 'manage_settings', 'set_reaction', 'get_timezone_info']) {
      expect(s.prompt).toContain(`${name}:`);
    }
  });

  test('discovery offers only tools that are not already loaded, but every group', () => {
    const s = createToolExposure(allowed, 'hybrid');
    const discovery = s.schemas()[0];
    if (discovery?.type !== 'function') throw new Error('discover_tools missing');
    const properties = discovery.function.parameters?.properties as {
      tools: { items: { enum: string[] } };
      groups: { items: { enum: string[] } };
    };
    expect(properties.tools.items.enum).not.toContain('create_event');
    expect(properties.tools.items.enum).toContain('get_history');
    expect(properties.groups.items.enum).toContain('calendar.write');
  });

  test('discovering a tool or group that is already loaded succeeds and leaves the loaded prefix alone', () => {
    const s = createToolExposure(allowed, 'hybrid');
    const before = JSON.stringify(s.schemas());
    expect(s.intercept('discover_tools', { tools: ['create_event'] }, s.snapshot())?.success).toBe(true);
    expect(s.intercept('discover_tools', { groups: ['calendar.write'] }, s.snapshot())?.success).toBe(true);
    // A group reveals its not-yet-loaded members only, appended after the loaded prefix.
    expect(JSON.stringify(s.schemas()).startsWith(before.slice(0, -1))).toBe(true);
    expect(names(s.schemas()).filter((name) => name === 'create_event')).toHaveLength(1);
  });

  test('revealing a tool only appends, so the request prefix of earlier rounds stays identical', () => {
    const s = createToolExposure(allowed, 'hybrid');
    const first = JSON.stringify(s.schemas());
    s.intercept('discover_tools', { tools: ['get_history'] }, s.snapshot());
    const second = JSON.stringify(s.schemas());
    expect(second.startsWith(first.slice(0, -1))).toBe(true);
    expect(names(s.schemas()).at(-1)).toBe('get_history');
  });

  test('the first-round payload is a fraction of the full catalog and of the lazy index', () => {
    const hybrid = createToolExposure(allowed, 'hybrid');
    const lazy = createToolExposure(allowed);
    const hybridChars = JSON.stringify(hybrid.schemas()).length + hybrid.prompt.length;
    const fullChars = JSON.stringify(allowed).length;
    expect(hybridChars).toBeLessThan(fullChars * 0.55);
    // The always-on tools carry their own schema, so the index has to be shorter than the whole-catalog one.
    expect(hybrid.prompt.length).toBeLessThan(lazy.prompt.length);
  });

  test('a catalog without some always-on tools (supplement, live call) simply loads the ones it has', () => {
    const call = createToolExposure(getToolDefinitions('live_call'), 'hybrid');
    expect(names(call.schemas())).not.toContain('render_day_image');
    expect(names(call.schemas())).toContain('create_event');
    const supplement = createToolExposure(getToolDefinitions('text', true), 'hybrid');
    expect(supplement.prompt).toContain('supplement_skip:');
  });

  test('the default stays the lazy catalog: discover_tools and calculate only', () => {
    expect(names(createToolExposure(allowed).schemas())).toEqual(['discover_tools', 'calculate']);
  });
});
