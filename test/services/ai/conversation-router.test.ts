import { describe, expect, test } from 'bun:test';
import { classifyConversationTurn } from '../../../src/services/ai/conversation-router.ts';
import { InMemoryRoutingRepairStore } from '../../../src/services/ai/routing-repair-store.ts';
import { createToolCatalog } from '../../../src/services/ai/tool-catalog.ts';
import { getToolDefinitions } from '../../../src/services/ai/tools.ts';

const catalog = createToolCatalog(getToolDefinitions('text'));
const basePlan = {
  tier: 'light',
  groups: ['calendar.read'],
  tools: ['get_events'],
  calendar: 'today',
  signals: { misunderstanding: false, repeated_request: false, frustration_at_bot: false },
  evidence_turn_ids: ['u2'],
};
const turn = { id: 'u2', kind: 'message' as const, role: 'user' as const, text: 'Покажи сегодня' };

describe('stateful conversation routing', () => {
  test('ordinary light plan allows deterministic path', async () => {
    const route = await classifyConversationTurn({
      catalog,
      classify: async () => JSON.stringify(basePlan),
      repairStore: new InMemoryRoutingRepairStore(),
      chatId: 1,
      userId: 2,
      timezone: 'Europe/Belgrade',
      scope: 'private',
      turn,
      recent: [],
    });
    expect(route.kind).toBe('plan');
    if (route.kind === 'plan') {
      expect(route.plan.tier).toBe('light');
      expect(route.allowDeterministic).toBe(true);
    }
  });
  test('misunderstanding opens repair and forces smart on terse followup', async () => {
    const store = new InMemoryRoutingRepairStore();
    const first = await classifyConversationTurn({
      catalog,
      classify: async () => JSON.stringify({ ...basePlan, signals: { ...basePlan.signals, misunderstanding: true } }),
      repairStore: store,
      chatId: 1,
      userId: 2,
      timezone: 'Europe/Belgrade',
      scope: 'private',
      turn,
      recent: [],
    });
    expect(first.kind === 'plan' && first.plan.tier).toBe('smart');
    expect(await store.isOpen(1, 2)).toBe(true);
    const follow = { ...turn, id: 'u3', text: 'Да' };
    const second = await classifyConversationTurn({
      catalog,
      classify: async () => JSON.stringify({ ...basePlan, evidence_turn_ids: ['u3'] }),
      repairStore: store,
      chatId: 1,
      userId: 2,
      timezone: 'Europe/Belgrade',
      scope: 'private',
      turn: follow,
      recent: [turn],
    });
    expect(second.kind === 'plan' && second.plan.tier).toBe('smart');
    if (second.kind === 'plan') expect(second.allowDeterministic).toBe(false);
  });
  test('classifier failure never enables deterministic execution', async () => {
    const route = await classifyConversationTurn({
      catalog,
      classify: async () => {
        throw new Error('down');
      },
      repairStore: new InMemoryRoutingRepairStore(),
      chatId: 1,
      userId: 2,
      timezone: 'UTC',
      scope: 'private',
      turn,
      recent: [],
    });
    expect(route.kind).toBe('plan');
    if (route.kind === 'plan') {
      expect(route.fallback).toBe(true);
      expect(route.plan.tier).toBe('smart');
      expect(route.allowDeterministic).toBe(false);
    }
  });
});
