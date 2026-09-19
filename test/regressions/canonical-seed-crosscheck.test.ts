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
const tools = async (name: string, input: unknown): Promise<ToolResult> => {
  const value = input as { event_id?: number; query?: string; name?: string };
  if (name === 'convert_to_timezone') {
    if (!input || typeof input !== 'object') throw new Error('Expected conversion inputs');
    const datetime = Reflect.get(input, 'datetime'),
      timezone = Reflect.get(input, 'timezone');
    if (typeof datetime !== 'string' || typeof timezone !== 'string') throw new Error('Expected typed date/timezone');
    return handleConvertToTimezone({ datetime, timezone });
  }
  const event = {
    id: value.event_id ?? 17,
    title: value.query ?? 'Synthetic event',
    date: '2026-10-05',
    time: '10:00',
    all_day: false,
  };
  if (name === 'search_events') return { success: true, output: 'Found one event', data: [event] };
  if (name === 'get_event') return { success: true, output: 'Event details', data: event };
  if (name === 'get_events') return { success: true, output: 'No events', data: [] };
  if (name === 'find_contact')
    return {
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
    };
  return {
    success: true,
    output: 'Synthetic tool result',
    mutationState: name.startsWith('get_') || name.startsWith('list_') ? 'not_applied' : 'confirmed',
  };
};

describe('every canonical family is executable, not just listed in a catalogue', () => {
  for (const [index, meta] of canonicalMetadata.entries()) {
    test(`${meta.name}: typed schema, contracts and all declared examples`, async () => {
      setSystemTime(new Date('2026-09-19T10:00:00Z'));
      const definition = seedIntents[index]!;
      const workflow = WorkflowSchema.parse(definition.workflow);
      expect(validateWorkflow(workflow, definition.pattern)).toEqual([]);
      for (const example of meta.examples.synthetic) {
        const match = matcher.match(example);
        expect(match?.intentId, example).toBe(index + 1);
        const executor = new IntentExecutor();
        let result = await executor.run(workflow, match!.captures, context, tools);
        for (let steps = 0; result.suspended && steps < 6; steps++) {
          result = await executor.run(workflow, match!.captures, context, tools, {
            stepIndex: result.suspendedAt!,
            stepResults: result.stepResults!,
            userAnswer: 'yes',
          });
        }
        expect(result.success, `${meta.name}: ${example} -> ${result.errorCode ?? result.response}`).toBe(true);
        expect(result.suspended).not.toBe(true);
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
