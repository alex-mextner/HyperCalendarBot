import { describe, expect, test } from 'bun:test';
import {
  type CaseOutcome,
  classifyTurn,
  formatOutcomeRow,
  totalsByProvider,
  verdict,
} from '../../scripts/dryrun-tool-selection.ts';
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
