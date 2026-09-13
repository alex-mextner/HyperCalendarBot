import { expect, test } from 'bun:test';
import { createToolSession, runRoutedTurn } from '../../../src/services/ai/routed-turn.ts';
import { createToolCatalog } from '../../../src/services/ai/tool-catalog.ts';
import { getToolDefinitions } from '../../../src/services/ai/tools.ts';

const catalog = createToolCatalog(getToolDefinitions('text'));
const turn = { id: 'u1', kind: 'message' as const, text: 'Не то, что я просил' };
const state = {
  repairOpen: false,
  nowIso: '2026-09-13T10:00:00Z',
  timezone: 'Europe/Belgrade',
  actorId: '1',
  chatId: '1',
  scope: 'private' as const,
};
const base = {
  tier: 'medium',
  groups: ['calculator'],
  tools: [],
  calendar: 'none',
  signals: { misunderstanding: false, repeated_request: false, frustration_at_bot: false },
  evidence_turn_ids: [],
};
test('classification always precedes a deterministic match', async () => {
  const order: string[] = [];
  const r = await runRoutedTurn({
    catalog,
    turn,
    recent: [],
    state,
    classify: async () => {
      order.push('router');
      return JSON.stringify(base);
    },
    tryDeterministic: async () => {
      order.push('intent');
      return { handled: true as const, value: 'OK' };
    },
    execute: async () => {
      order.push('model');
      return 'wrong';
    },
  });
  expect(order).toEqual(['router', 'intent']);
  expect(r.kind).toBe('deterministic');
});
test('repair bypasses deterministic writes and selects smart', async () => {
  let intent = 0;
  const r = await runRoutedTurn({
    catalog,
    turn,
    recent: [],
    state,
    classify: async () =>
      JSON.stringify({
        ...base,
        tier: 'light',
        signals: { ...base.signals, repeated_request: true },
        evidence_turn_ids: ['u1'],
      }),
    tryDeterministic: async () => {
      intent++;
      return { handled: true as const, value: 'WRONG' };
    },
    execute: async (tier, session) => {
      expect(tier).toBe('smart');
      expect(session.index).toContain('delete_event');
      expect(session.exposedNames()).toContain('discover_tools');
      return 'repair';
    },
  });
  expect(intent).toBe(0);
  expect(r.kind === 'model' && r.repairOpen).toBe(true);
});
test('missing descriptions remain discoverable and wrong tool names never activate', async () => {
  await runRoutedTurn({
    catalog,
    turn,
    recent: [],
    state,
    classify: async () => JSON.stringify(base),
    execute: async (tier, session) => {
      expect(tier).toBe('medium');
      expect(session.exposedNames()).not.toContain('get_events');
      const first = session.discover({ groups: ['calendar.read'], tools: ['not_a_tool'] });
      expect(first.ok).toBe(true);
      expect(session.exposedNames()).toContain('get_events');
      expect(session.exposedNames()).not.toContain('not_a_tool');
      expect(session.index).toContain('delete_event');
      return 'OK';
    },
  });
});
test('auth protocols never go through models or deterministic business actions', async () => {
  let called = 0;
  const r = await runRoutedTurn({
    catalog,
    turn: { ...turn, kind: 'auth_secret' },
    recent: [],
    state,
    classify: async () => {
      called++;
      return '';
    },
    execute: async () => {
      called++;
      return 'bad';
    },
  });
  expect(called).toBe(0);
  expect(r.kind).toBe('protocol');
});
test('smart unavailable never silently downgrades or repeats writes', async () => {
  let calls = 0;
  await expect(
    runRoutedTurn({
      catalog,
      turn,
      recent: [],
      state: { ...state, repairOpen: true },
      classify: async () => JSON.stringify(base),
      execute: async (tier) => {
        calls++;
        expect(tier).toBe('smart');
        throw new Error('SMART_UNAVAILABLE');
      },
    }),
  ).rejects.toThrow('SMART_UNAVAILABLE');
  expect(calls).toBe(1);
});

test('an undisclosed tool never reaches the business handler', async () => {
  const s = createToolSession(catalog, turn, [], state);
  let executed = 0;
  await expect(
    s.invoke('calculate', {}, async () => {
      executed++;
      return 1;
    }),
  ).rejects.toThrow('TOOL_NOT_EXPOSED');
  s.discover({ tools: ['calculate'] });
  expect(
    await s.invoke('calculate', { expression: '1+1' }, async () => {
      executed++;
      return 2;
    }),
  ).toBe(2);
  await expect(s.invoke('discover_tools', {}, async () => 1)).rejects.toThrow('TOOL_NOT_EXPOSED');
  expect(executed).toBe(1);
});
test('discovery is bounded across the whole run and returned schemas cannot corrupt it', () => {
  const s = createToolSession(catalog, turn, [], state);
  expect(s.discover({ tools: 'invalid' }).ok).toBe(false);
  for (let i = 0; i < 4; i++) expect(s.discover({ tools: ['calculate'] }).ok).toBe(true);
  expect(s.discover({ groups: ['calendar.read'] }).ok).toBe(false);
  const copy = s.schemas();
  copy.length = 0;
  expect(s.schemas().length).toBe(2);
});

test('shared repair state changing during classification cannot lower the tier', async () => {
  const shared = { ...state, repairOpen: true };
  let intents = 0;
  const r = await runRoutedTurn({
    catalog,
    turn,
    recent: [],
    state: shared,
    classify: async () => {
      shared.repairOpen = false;
      return JSON.stringify(base);
    },
    tryDeterministic: async () => {
      intents++;
      return { handled: false as const };
    },
    execute: async (tier) => tier,
  });
  expect(intents).toBe(0);
  expect(r.kind === 'model' && r.tier).toBe('smart');
});
test('deterministic callback cannot mutate the validated executor tier', async () => {
  const r = await runRoutedTurn({
    catalog,
    turn,
    recent: [],
    state,
    classify: async () => JSON.stringify(base),
    tryDeterministic: async (plan) => {
      plan.tier = 'light';
      return { handled: false as const };
    },
    execute: async (tier) => tier,
  });
  expect(r.kind === 'model' && r.tier).toBe('medium');
});
test('abort before invocation prevents a business action', async () => {
  const c = new AbortController();
  let writes = 0;
  await expect(
    runRoutedTurn({
      catalog,
      turn,
      recent: [],
      state,
      signal: c.signal,
      classify: async () => JSON.stringify(base),
      execute: async (_, session) => {
        c.abort();
        return session.invoke('calculate', {}, async () => {
          writes++;
          return 'bad';
        });
      },
    }),
  ).rejects.toThrow();
  expect(writes).toBe(0);
});
test('discovery cannot begin over the schema budget', () => {
  const huge = createToolCatalog(
    Array.from({ length: 450 }, (_, i) => ({
      type: 'function' as const,
      function: { name: `tool_${i}_${'x'.repeat(50)}`, parameters: {} },
    })),
  );
  expect(() => createToolSession(huge, turn, [], state)).toThrow('CATALOG_TOO_LARGE');
});

test('execution receives the original allowlisted request identity', async () => {
  const shared = { ...state, actorId: 'actor-1' };
  const input = { ...turn };
  await runRoutedTurn({
    catalog,
    turn: input,
    recent: [],
    state: shared,
    classify: async () => {
      shared.actorId = 'actor-2';
      input.text = 'different request';
      return JSON.stringify(base);
    },
    execute: async (_tier, _session, _plan, _signal, context) => {
      expect(context.state.actorId).toBe('actor-1');
      expect(context.turn.text).toBe(turn.text);
      expect(Object.isFrozen(context.state)).toBe(true);
      return 'OK';
    },
  });
});
test('oversized catalogs never reach classification or deterministic actions', async () => {
  const huge = createToolCatalog(
    Array.from({ length: 129 }, (_, i) => ({
      type: 'function' as const,
      function: { name: `t_${i}`, parameters: {} },
    })),
  );
  let calls = 0;
  await expect(
    runRoutedTurn({
      catalog: huge,
      turn,
      recent: [],
      state,
      classify: async () => {
        calls++;
        return JSON.stringify(base);
      },
      tryDeterministic: async () => {
        calls++;
        return { handled: true as const, value: 'bad' };
      },
      execute: async () => 'bad',
    }),
  ).rejects.toThrow('CATALOG_TOO_LARGE');
  expect(calls).toBe(0);
});
test('mandatory discover_tools cannot be replaced by catalog content', () => {
  expect(() =>
    createToolCatalog([
      {
        type: 'function',
        function: { name: 'discover_tools', parameters: { type: 'object', properties: { rogue: { type: 'string' } } } },
      },
    ]),
  ).toThrow('RESERVED_TOOL_NAME');
});
test('snapshot work is bounded and does not touch omitted history', async () => {
  const history = Array.from({ length: 10000 }, (_, i) => ({ ...turn, id: `h${i}` }));
  Object.defineProperty(history, 0, {
    get() {
      throw new Error('unbounded history read');
    },
  });
  await runRoutedTurn({
    catalog,
    turn,
    recent: history,
    state,
    classify: async () => JSON.stringify(base),
    execute: async (_tier, _session, _plan, _signal, context) => {
      expect(context.recent.length).toBe(6);
      expect(context.omittedHistory).toBe(9994);
      return 'OK';
    },
  });
});

test('excluded protocols bypass conversational size validation', async () => {
  let calls = 0;
  const r = await runRoutedTurn({
    catalog,
    turn: { ...turn, kind: 'system', text: 'x'.repeat(131073) },
    recent: [],
    state,
    classify: async () => {
      calls++;
      return '';
    },
    execute: async () => {
      calls++;
      return 'bad';
    },
  });
  expect(r.kind).toBe('protocol');
  expect(calls).toBe(0);
});

test('malformed revealed arguments never reach a business callback', async () => {
  const s = createToolSession(catalog, turn, [], state);
  s.discover({ tools: ['delete_event'] });
  let writes = 0;
  await expect(
    s.invoke('delete_event', { event_id: { bad: true } }, async () => {
      writes++;
      return 'bad';
    }),
  ).rejects.toThrow('TOOL_ARGUMENTS_INVALID');
  expect(writes).toBe(0);
});
test('all canonical schemas can be activated for validation', () => {
  for (const t of getToolDefinitions('text', { assistantEnabled: true })) {
    if (t.type !== 'function') continue;
    const c = createToolCatalog([t]),
      s = createToolSession(c, turn, [], state);
    expect(s.discover({ tools: [t.function.name] }).ok).toBe(true);
  }
});
test('revealed additionalProperties false is enforced', async () => {
  const c = createToolCatalog([
    {
      type: 'function',
      function: {
        name: 'test_value',
        parameters: {
          type: 'object',
          properties: { value: { type: 'integer' } },
          required: ['value'],
          additionalProperties: false,
        },
      },
    },
  ]);
  const s = createToolSession(c, turn, [], state);
  s.discover({ tools: ['test_value'] });
  let calls = 0;
  await expect(
    s.invoke('test_value', { value: 1, extra: true }, async () => {
      calls++;
      return 1;
    }),
  ).rejects.toThrow('TOOL_ARGUMENTS_INVALID');
  expect(calls).toBe(0);
});

test('revealed update_event preserves canonical nullable clearing fields', async () => {
  const s = createToolSession(catalog, turn, [], state);
  s.discover({ tools: ['update_event'] });
  for (const field of ['end_at', 'description', 'location', 'recurrence_rule']) {
    const args = { event_id: 42, [field]: null };
    expect(await s.invoke('update_event', args, async (_name, input) => input)).toEqual(args);
  }
});
