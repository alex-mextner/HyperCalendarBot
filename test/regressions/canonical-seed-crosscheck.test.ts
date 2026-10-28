import { Database } from 'bun:sqlite';
import { afterAll, afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import type { Intent } from '../../src/database/types.ts';
import { handleConvertToTimezone } from '../../src/services/ai/tool-handlers/timezone.ts';
import type { ToolResult } from '../../src/services/ai/types.ts';
import { IntentExecutor } from '../../src/services/intent/intent-executor.ts';
import { IntentMatcher } from '../../src/services/intent/intent-matcher.ts';
import { canonicalMetadata, legacyDisposition, seedIntents } from '../../src/services/intent/seed-catalog.ts';
import { WorkflowSchema } from '../../src/services/intent/workflow-schema.ts';
import { validateWorkflow } from '../../src/services/intent/workflow-validator.ts';

const db = new Database(':memory:');
runMigrations(db, migrations);
const user = new UserRepository(db).create({ telegram_id: 1001, timezone: 'UTC', language: 'en' });
const context = { telegramId: 1001, timezone: 'UTC', language: 'en' as const, user, isGroup: false };
const rows = seedIntents.map((s, i) => ({
  ...s,
  id: i + 1,
  workflow: JSON.stringify(s.workflow),
  phrases: JSON.stringify(s.phrases),
  trigger_words: JSON.stringify(s.trigger_words),
  status: 'approved',
  format: 'text',
  created_at: '2026-09-19 00:00:00',
})) as Intent[];
const matcher = new IntentMatcher();
matcher.load(rows);
afterAll(() => {
  db.close();
  setSystemTime();
});
afterEach(() => setSystemTime());
type ToolInput = { event_id?: number; query?: string; name?: string };

const convertToTimezone = (input: unknown): ToolResult => {
  if (!input || typeof input !== 'object') throw new Error('Expected conversion inputs');
  const datetime = Reflect.get(input, 'datetime'),
    timezone = Reflect.get(input, 'timezone');
  if (typeof datetime !== 'string' || typeof timezone !== 'string') throw new Error('Expected typed date/timezone');
  return handleConvertToTimezone({ datetime, timezone });
};

const syntheticEvent = (value: ToolInput) => ({
  id: value.event_id ?? 17,
  title: value.query ?? 'Synthetic event',
  date: '2026-10-05',
  time: '10:00',
  all_day: false,
});

const findContactResult = (value: ToolInput): ToolResult => ({
  success: true,
  output: 'One owned contact',
  data: {
    matches: [
      {
        id: 3,
        name: value.name ?? 'Anna',
        preferred_name: null,
        username: 'anna_test',
        telegram_id: 123456,
        confidence: 1,
      },
    ],
  },
});

const tools = async (name: string, input: unknown): Promise<ToolResult> => {
  if (name === 'convert_to_timezone') return convertToTimezone(input);
  const value = input as ToolInput;
  if (name === 'create_event')
    return {
      success: true,
      output: 'Created',
      data: { ...syntheticEvent(value), id: 21, title: 'Created event' },
      mutationState: 'confirmed',
    };
  if (name === 'search_events') return { success: true, output: 'Found one event', data: [syntheticEvent(value)] };
  if (name === 'get_event') return { success: true, output: 'Event details', data: syntheticEvent(value) };
  if (name === 'get_events') return { success: true, output: 'No events', data: [] };
  if (name === 'find_contact') return findContactResult(value);
  return {
    success: true,
    output: 'Synthetic tool result',
    mutationState: name.startsWith('get_') || name.startsWith('list_') ? 'not_applied' : 'confirmed',
  };
};

/** Seven consecutive days: a weekday named in an example is "today" on exactly one of them. */
const CLOCKS = Array.from({ length: 7 }, (_, day) => new Date(Date.UTC(2026, 8, 14 + day, 10)));

describe('every canonical family is executable, not just listed in a catalogue', () => {
  for (const [index, meta] of canonicalMetadata.entries()) {
    test(`${meta.name}: typed schema, contracts and all declared examples`, async () => {
      const definition = seedIntents[index]!;
      const workflow = WorkflowSchema.parse(definition.workflow);
      expect(validateWorkflow(workflow, definition.pattern)).toEqual([]);
      for (const example of meta.examples.synthetic) {
        const match = matcher.match(example);
        expect(match?.intentId, example).toBe(index + 1);
        const refused: string[] = [];
        for (const clock of CLOCKS) {
          setSystemTime(clock);
          const executor = new IntentExecutor();
          let result = await executor.run(workflow, match!.captures, context, tools);
          for (let steps = 0; result.suspended && steps < 6; steps++) {
            result = await executor.run(workflow, match!.captures, context, tools, {
              stepIndex: result.suspendedAt!,
              stepResults: result.stepResults!,
              userAnswer: 'yes',
            });
          }
          expect(result.suspended, `${meta.name}: ${example}`).not.toBe(true);
          if (result.success) continue;
          // The only refusal an example may meet is "the named weekday is today": the rule hands that to the AI.
          expect(result.errorCode, `${meta.name}: ${example} -> ${result.response}`).toBe('INVALID_INPUT');
          refused.push(clock.toISOString());
        }
        expect(refused.length, `${meta.name}: ${example} is refused on ${refused.join(', ')}`).toBeLessThanOrEqual(1);
      }
    });
    test(`${meta.name}: negated or unrelated phrasing is not this rule`, () => {
      for (const example of meta.negativeExamples)
        expect(matcher.match(example)?.intentId, example).not.toBe(index + 1);
    });
  }
  test('all historical families have one explicit successor or retirement', () => {
    expect(legacyDisposition).toHaveLength(104);
    expect(new Set(legacyDisposition.map((x) => x.oldKey)).size).toBe(104);
    const names = new Set(seedIntents.map((x) => x.canonical_name));
    for (const item of legacyDisposition) {
      expect(item.reason.length).toBeGreaterThan(20);
      if (item.disposition === 'retire') expect(item.target).toBeNull();
      else expect(names.has(item.target!)).toBe(true);
    }
  });
});
