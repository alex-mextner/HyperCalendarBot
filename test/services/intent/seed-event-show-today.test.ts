// test/services/intent/seed-event-show-today.test.ts
//
// GH-653 §26: "покажи сегодняшнюю встречу" must be handled deterministically (0 LLM calls) via
// the canonical seed catalog, calling the same show_event tool the AI path and /event command
// use — not falling through to the AI agent, and not colliding with the existing full-agenda
// "что у меня сегодня" family (basis.calendar.day).
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { Intent } from '../../../src/database/types.ts';
import { IntentExecutor } from '../../../src/services/intent/intent-executor.ts';
import { IntentMatcher } from '../../../src/services/intent/intent-matcher.ts';
import { seedIntents } from '../../../src/services/intent/seed-catalog.ts';
import type { UserContext } from '../../../src/services/intent/variable-resolver.ts';

function rowsFor(seeds: typeof seedIntents): Intent[] {
  return seeds.map(
    (seed, index) =>
      ({
        id: index + 1,
        canonical_name: seed.canonical_name,
        phrases: JSON.stringify(seed.phrases),
        trigger_words: JSON.stringify(seed.trigger_words),
        pattern: seed.pattern,
        workflow: JSON.stringify(seed.workflow),
        format: 'text',
        status: 'approved',
        source_message: seed.source_message,
        created_at: '',
      }) satisfies Intent,
  );
}

const matcher = new IntentMatcher();
matcher.load(rowsFor(seedIntents));

const USER_CTX: UserContext = { timezone: 'Europe/Belgrade', language: 'ru', userId: 700001 };

describe('deterministic "show today\'s meeting" intent', () => {
  beforeEach(() => setSystemTime(new Date('2026-09-28T10:00:00Z')));
  afterEach(() => setSystemTime());

  test('"покажи сегодняшнюю встречу" matches a seeded rule, not an abstain', () => {
    const decision = matcher.explain('покажи сегодняшнюю встречу');
    expect(decision.kind).toBe('matched');
  });

  test('matches a different rule than the full-agenda "что у меня сегодня" family', () => {
    const today = matcher.explain('покажи сегодняшнюю встречу');
    const agenda = matcher.explain('что у меня сегодня');
    expect(today.kind).toBe('matched');
    expect(agenda.kind).toBe('matched');
    if (today.kind === 'matched' && agenda.kind === 'matched') {
      expect(today.result.intentId).not.toBe(agenda.result.intentId);
    }
  });

  test("the matched workflow calls show_event with today's date, once, and asks for no AI supplement", async () => {
    const decision = matcher.explain('покажи сегодняшнюю встречу');
    expect(decision.kind).toBe('matched');
    if (decision.kind !== 'matched') return;
    const row = rowsFor(seedIntents)[decision.result.intentId - 1]!;
    const workflow = JSON.parse(row.workflow) as import('../../../src/services/intent/workflow-schema.ts').Workflow;

    const calls: { tool: string; input: unknown }[] = [];
    const executor = new IntentExecutor();
    const result = await executor.run(workflow, decision.result.captures, USER_CTX, (tool, input) => {
      calls.push({ tool, input });
      // The real show_event returns no `output` on success (see events.ts) — the executor and
      // intent-matcher-layer must treat that as "already delivered", not "say nothing happened".
      return { success: true, agentHint: 'delivered' };
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe('show_event');
    expect(calls[0]!.input).toMatchObject({ start_date: '2026-09-28', end_date: '2026-09-28' });
    expect(result.success).toBe(true);
    // Empty/undefined response is exactly what stops intent-matcher-layer from calling the AI
    // agent as a supplement (see IntentMatcherLayer step 8: `if (result.response) { ...supplement... }`).
    expect(result.response).toBeUndefined();
  });

  test('"покажи завтрашнюю встречу" resolves to tomorrow, not today', async () => {
    const decision = matcher.explain('покажи завтрашнюю встречу');
    expect(decision.kind).toBe('matched');
    if (decision.kind !== 'matched') return;
    const row = rowsFor(seedIntents)[decision.result.intentId - 1]!;
    const workflow = JSON.parse(row.workflow) as import('../../../src/services/intent/workflow-schema.ts').Workflow;
    const calls: { tool: string; input: unknown }[] = [];
    const executor = new IntentExecutor();
    await executor.run(workflow, decision.result.captures, USER_CTX, (tool, input) => {
      calls.push({ tool, input });
      return { success: true };
    });
    expect(calls[0]!.input).toMatchObject({ start_date: '2026-09-29', end_date: '2026-09-29' });
  });

  test('does not steal a quoted-title or numeric-id show request from basis.event.show', () => {
    const rows = rowsFor(seedIntents);
    const showByRefId = seedIntents.findIndex((s) => s.canonical_name === 'basis.event.show') + 1;
    const byId = matcher.explain('покажи событие #12');
    const byTitle = matcher.explain('открой встречу «Стендап»');
    expect(byId.kind).toBe('matched');
    expect(byTitle.kind).toBe('matched');
    if (byId.kind === 'matched') {
      expect(rows[byId.result.intentId - 1]!.canonical_name).toBe('basis.event.show');
      expect(byId.result.intentId).toBe(showByRefId);
    }
    if (byTitle.kind === 'matched') expect(rows[byTitle.result.intentId - 1]!.canonical_name).toBe('basis.event.show');
  });

  test('a plain "покажи сегодня" without an event noun still resolves to the agenda family', () => {
    const decision = matcher.explain('покажи сегодня');
    expect(decision.kind).toBe('matched');
    if (decision.kind !== 'matched') return;
    const rows = rowsFor(seedIntents);
    expect(rows[decision.result.intentId - 1]!.canonical_name).toBe('basis.calendar.day');
  });
});
