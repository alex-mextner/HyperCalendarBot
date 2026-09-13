import { describe, expect, test } from 'bun:test';
import { createToolCatalog } from '../../../src/services/ai/tool-catalog.ts';
import { getToolDefinitions } from '../../../src/services/ai/tools.ts';
import { buildRoutingPacket, planUserTurn } from '../../../src/services/ai/turn-routing.ts';

const catalog = createToolCatalog(getToolDefinitions('text'));
const turn = { id: 'u1', kind: 'message' as const, text: 'Что у меня сегодня?' };
const state = {
  repairOpen: false,
  nowIso: '2026-09-12T21:00:00Z',
  timezone: 'Europe/Belgrade',
  actorId: '1',
  chatId: '1',
  scope: 'private' as const,
};
const ordinary = {
  tier: 'medium',
  groups: ['calendar.read'],
  tools: ['get_events'],
  calendar: 'today',
  signals: { misunderstanding: false, repeated_request: false, frustration_at_bot: false },
  evidence_turn_ids: [],
};
describe('three-tier routing', () => {
  test('medium stays medium for ordinary work', async () => {
    const r = await planUserTurn(catalog, turn, [], state, async () => JSON.stringify(ordinary));
    expect(r.kind).toBe('plan');
    if (r.kind === 'plan') expect(r.plan.tier).toBe('medium');
  });
  test.each([
    'misunderstanding',
    'repeated_request',
    'frustration_at_bot',
  ] as const)('%s escalates even when classifier proposes light', async (signal) => {
    const p = {
      ...ordinary,
      tier: 'light',
      signals: { ...ordinary.signals, [signal]: true },
      evidence_turn_ids: ['u1'],
    };
    const r = await planUserTurn(catalog, turn, [], state, async () => JSON.stringify(p));
    if (r.kind !== 'plan') throw new Error('fixture');
    expect(r.plan.tier).toBe('smart');
  });
  test('every message including a deterministic command is classified once', async () => {
    let calls = 0;
    for (const kind of ['message', 'command'] as const)
      await planUserTurn(catalog, { ...turn, kind }, [], state, async () => {
        calls++;
        return JSON.stringify(ordinary);
      });
    expect(calls).toBe(2);
  });
  test.each(['auth_secret', 'callback', 'system'] as const)('%s never reaches the classifier', async (kind) => {
    let calls = 0;
    const r = await planUserTurn(catalog, { ...turn, kind }, [], state, async () => {
      calls++;
      return '';
    });
    expect(r.kind).toBe('protocol');
    expect(calls).toBe(0);
  });
  test('open repair never downgrades on a terse followup', async () => {
    const r = await planUserTurn(catalog, { ...turn, text: 'Да' }, [], { ...state, repairOpen: true }, async () =>
      JSON.stringify({ ...ordinary, tier: 'light' }),
    );
    if (r.kind !== 'plan') throw new Error('fixture');
    expect(r.plan.tier).toBe('smart');
  });
  test('unsupported groups and malformed output safely escalate', async () => {
    for (const value of [
      'no json',
      JSON.stringify({ ...ordinary, groups: ['not_allowed'] }),
      JSON.stringify({ ...ordinary, actor_id: 99 }),
    ]) {
      const r = await planUserTurn(catalog, turn, [], state, async () => value);
      if (r.kind !== 'plan') throw new Error('fixture');
      expect(r.plan.tier).toBe('smart');
      expect(r.fallback).toBe(true);
    }
  });
  test('failure of the classifier has a smart fallback, not automatic business execution', async () => {
    const r = await planUserTurn(catalog, turn, [], state, async () => {
      throw new Error('offline');
    });
    if (r.kind !== 'plan') throw new Error('fixture');
    expect(r.plan.tools).toEqual([]);
    expect(r.plan.tier).toBe('smart');
  });
  test('full short index survives and discover_tools is always exposed', () => {
    const packet = buildRoutingPacket(catalog, turn, [], state);
    expect(JSON.stringify(packet)).toContain('calculate');
    expect(JSON.stringify(packet)).toContain('delete_event');
    expect(packet.executorTools[0]?.function.name).toBe('discover_tools');
  });
  test('secret history is excluded and truncation is explicit', () => {
    const packet = buildRoutingPacket(
      catalog,
      turn,
      [
        { id: 'secret', kind: 'auth_secret', text: 'sensitive' },
        { id: 'old', kind: 'message', text: 'x'.repeat(5000) },
      ],
      state,
    );
    expect(JSON.stringify(packet)).not.toContain('sensitive');
    expect(JSON.stringify(packet)).toContain('truncated');
  });
});

describe('router transport safety', () => {
  test('structured-output request contains no incompatible API tools field', () => {
    const p = buildRoutingPacket(catalog, turn, [], state);
    expect(p.request).not.toHaveProperty('tools');
    expect(JSON.stringify(p.request.messages)).toContain('discover_tools');
  });
  test('assistant messages retain attribution but cannot be user evidence', async () => {
    const history = [{ id: 'a1', kind: 'message' as const, role: 'assistant' as const, text: 'Wrong answer' }];
    expect(JSON.stringify(buildRoutingPacket(catalog, turn, history, state))).toContain('assistant');
    const r = await planUserTurn(catalog, turn, history, state, async () =>
      JSON.stringify({ ...ordinary, evidence_turn_ids: ['a1'] }),
    );
    expect(r.kind === 'plan' && r.fallback).toBe(true);
  });
  test('a transport ignoring the deadline cannot hang planning', async () => {
    const r = await planUserTurn(catalog, turn, [], state, () => new Promise<string>(() => {}), undefined, 20);
    expect(r.kind === 'plan' && r.plan.tier).toBe('smart');
  });
  test('caller cancellation does not launch an expensive fallback', async () => {
    const c = new AbortController();
    c.abort();
    await expect(planUserTurn(catalog, turn, [], state, async () => '', c.signal)).rejects.toThrow();
  });
});

describe('review regressions', () => {
  test('caller abort winning alongside ready output never returns an executable plan', async () => {
    const c = new AbortController();
    await expect(
      planUserTurn(
        catalog,
        turn,
        [],
        state,
        async () => {
          c.abort();
          return JSON.stringify(ordinary);
        },
        c.signal,
      ),
    ).rejects.toThrow();
  });
  test('extra state fields are never serialized', () => {
    const extra = { ...state, authToken: 'SECRET_SENTINEL' };
    expect(JSON.stringify(buildRoutingPacket(catalog, turn, [], extra))).not.toContain('SECRET_SENTINEL');
  });
  test('empty discovery request is a valid no-op matching its public schema', () => {
    const r = catalog.describe({ groups: [], tools: [] });
    expect(r.ok && r.tools).toEqual([]);
  });
});

test('caller signal does not disable the separate planner deadline', async () => {
  const c = new AbortController();
  const result = await planUserTurn(catalog, turn, [], state, () => new Promise<string>(() => {}), c.signal, 20);
  expect(result.kind === 'plan' && result.fallback).toBe(true);
});

test('synchronous transport abort plus throw has no unhandled rejection', async () => {
  const c = new AbortController();
  await expect(
    planUserTurn(
      catalog,
      turn,
      [],
      state,
      () => {
        c.abort();
        throw new Error('sync transport');
      },
      c.signal,
    ),
  ).rejects.toThrow();
  await Bun.sleep(1);
});
