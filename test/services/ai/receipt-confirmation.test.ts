// The receipt-only confirmation names every event the run wrote, from the tool results alone.
import { describe, expect, test } from 'bun:test';
import { buildReceiptConfirmation } from '../../../src/services/ai/agent/receipt-confirmation.ts';
import type { ToolEvidence } from '../../../src/services/ai/response-grounding.ts';
import { WRITE_TOOLS } from '../../../src/services/ai/tool-executor.ts';
import { WriteOutcomes } from '../../../src/services/ai/write-outcomes.ts';
import type { ReceiptView } from '../../../src/services/ai/write-receipt.ts';

/** A requester who has no contacts and manages no calendar: nothing is named by id. */
function view(language: string, overrides: Partial<ReceiptView> = {}): ReceiptView {
  return {
    language,
    timezone: 'UTC',
    hideTargets: false,
    requesterId: 1001,
    now: new Date('2026-10-31T09:00:00Z'),
    personLabel: () => null,
    personKey: ({ id, username }) => (id === null ? `@${username}` : `id:${id}`),
    calendarOwnerName: () => null,
    hasCalendarAccess: () => false,
    ...overrides,
  };
}

type Result = { success: boolean; disposition: 'executed' | 'failed'; mutationState?: 'confirmed' | 'uncertain' };

function run(
  ...calls: { name: string; input: { [key: string]: unknown }; result: Result; data?: ToolEvidence['data'] }[]
) {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  const evidence: ToolEvidence[] = [];
  for (const call of calls) {
    ledger.record(call.name, call.input, call.result);
    evidence.push({ name: call.name, input: call.input, success: call.result.success, data: call.data });
  }
  return { ledger, evidence };
}

const OK: Result = { success: true, disposition: 'executed', mutationState: 'confirmed' };
const event = (title: string, date: string, time?: string, id = 1) => ({
  id,
  title,
  date,
  all_day: time === undefined,
  ...(time ? { time } : {}),
});

describe('receipt-only confirmation', () => {
  test('names every event with its exact title and local weekday, day and time (ru)', () => {
    const { ledger, evidence } = run(
      {
        name: 'create_event',
        input: { title: 'Synthetic standup' },
        result: OK,
        data: event('Synthetic standup', '2035-03-06', '09:00'),
      },
      {
        name: 'create_event',
        input: { title: 'Synthetic day off' },
        result: OK,
        data: event('Synthetic day off', '2035-03-07', undefined, 2),
      },
    );
    const receipt = buildReceiptConfirmation(view('ru'), evidence, ledger) ?? '';
    expect(receipt).toContain('Создано: «Synthetic standup» — вторник, 6 марта, 09:00');
    expect(receipt).toContain('Создано: «Synthetic day off» — среда, 7 марта, весь день');
    expect(receipt).not.toMatch(/прерван/i);
  });

  test('names an updated event once however many fields changed (en)', () => {
    const { ledger, evidence } = run({
      name: 'update_event',
      input: { event_id: 7, title: 'Synthetic renamed', start_at: '2035-03-06T10:30:00Z' },
      result: OK,
      data: event('Synthetic renamed', '2035-03-06', '10:30'),
    });
    const receipt = buildReceiptConfirmation(view('en'), evidence, ledger) ?? '';
    expect(receipt.match(/Synthetic renamed/g)).toHaveLength(1);
    expect(receipt).toContain('Updated: "Synthetic renamed" — now Tuesday, March 6, 10:30');
  });

  test('is null with no write, a failed or uncertain write, or a write that names no event', () => {
    expect(buildReceiptConfirmation(view('en'), [], new WriteOutcomes(WRITE_TOOLS))).toBeNull();

    const partial = run(
      {
        name: 'create_event',
        input: { title: 'Synthetic ok' },
        result: OK,
        data: event('Synthetic ok', '2035-03-06', '09:00'),
      },
      {
        name: 'delete_event',
        input: { event_id: 9 },
        result: { success: false, disposition: 'failed', mutationState: 'uncertain' },
      },
    );
    expect(buildReceiptConfirmation(view('en'), partial.evidence, partial.ledger)).toBeNull();
  });

  test('a write that names no event falls back to the ledger summary, never "interrupted"', () => {
    const noEvent = run({ name: 'create_event', input: { title: 'Synthetic bare' }, result: OK });
    const receipt = buildReceiptConfirmation(view('en'), noEvent.evidence, noEvent.ledger) ?? '';
    expect(receipt).toContain('Completed');
    expect(receipt).not.toMatch(/interrupted/i);
  });

  test('a group chat never gets an event title or time in the receipt', () => {
    const { ledger, evidence } = run({
      name: 'update_event',
      input: { event_id: 7, title: 'Synthetic private title' },
      result: OK,
      data: event('Synthetic private title', '2035-03-06', '10:30'),
    });
    const receipt = buildReceiptConfirmation(view('en', { hideTargets: true }), evidence, ledger) ?? '';
    expect(receipt).not.toContain('Synthetic private title');
    expect(receipt).not.toContain('10:30');
    expect(receipt).not.toMatch(/interrupted/i);
  });

  test('two creates of the same title and time stay two events by id, not one line', () => {
    const a = event('Synthetic twin', '2035-03-06', '09:00');
    const { ledger, evidence } = run(
      { name: 'create_event', input: { title: 'Synthetic twin' }, result: OK, data: a },
      { name: 'create_event', input: { title: 'Synthetic twin' }, result: OK, data: { ...a, id: 2 } },
    );
    const receipt = buildReceiptConfirmation(view('en'), evidence, ledger) ?? '';
    expect(receipt.match(/Synthetic twin/g)).toHaveLength(2);
  });
});
