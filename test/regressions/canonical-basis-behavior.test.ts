import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import { runMigrations } from '../../src/database/schema.ts';
import { _resetToolThrottleForTest, isMutationTool } from '../../src/services/ai/tool-executor.ts';
import { toolSchemas } from '../../src/services/ai/tool-schemas.ts';
import type { ToolResult } from '../../src/services/ai/types.ts';
import { IntentExecutor } from '../../src/services/intent/intent-executor.ts';
import type { IntentMatcher } from '../../src/services/intent/intent-matcher.ts';
import { canonicalMetadata, seedIntents } from '../../src/services/intent/seed-catalog.ts';
import type { EventSummary } from '../../src/services/intent/variable-resolver.ts';
import { WorkflowSchema } from '../../src/services/intent/workflow-schema.ts';
import { validateWorkflow } from '../../src/services/intent/workflow-validator.ts';
import { GROUP_CHAT, matcherOver, NOW, seedRows, USER } from './canonical-basis-helpers.ts';

// The original single file registered these hooks at module level, so they also covered these in-memory
// describes: the clock is pinned to NOW and the tool throttle starts fresh for every test.
beforeEach(() => {
  _resetToolThrottleForTest();
  setSystemTime(NOW);
});
afterEach(() => {
  setSystemTime();
});

// ─── executor-level harness: real IntentExecutor + real schema dispatch, stubbed tool bodies ───────────

const STANDUP: EventSummary = { id: 12, title: 'Standup', date: '2026-10-05', time: '10:00', all_day: false };
const CONTACT = {
  id: 5,
  name: 'Ivan',
  preferred_name: null,
  username: null,
  telegram_id: null,
  confidence: 1,
  created_at: '2026-01-01',
};

interface Recorded {
  name: string;
  input: unknown;
}

/** Plausible tool results; every call is recorded and the executor still validates the resolved input. */
function stubTools(overrides: { [tool: string]: (input: unknown) => ToolResult } = {}) {
  const calls: Recorded[] = [];
  const run = (name: string, input: unknown): ToolResult => {
    calls.push({ name, input });
    const override = overrides[name];
    if (override) return override(input);
    const mutationState = isMutationTool(name, input) ? ('confirmed' as const) : ('not_applied' as const);
    switch (name) {
      case 'get_events':
        return { success: true, output: '', data: [] };
      case 'get_event':
        return { success: true, output: 'event', data: STANDUP };
      case 'search_events':
        return { success: true, output: 'id: 12', data: [STANDUP] };
      case 'find_contact':
        return { success: true, output: 'contact', data: { matches: [CONTACT] } };
      case 'convert_to_timezone':
        return {
          success: true,
          output: JSON.stringify({
            timezone: 'Asia/Tokyo',
            local_datetime: '2026-09-19T15:00:00+09:00',
            utc_offset: '+09:00',
          }),
        };
      default:
        return { success: true, output: 'ok', mutationState };
    }
  };
  return { calls, run };
}

const userCtx = (extra: { group?: boolean; tz?: string } = {}) => ({
  timezone: extra.tz ?? 'Europe/Belgrade',
  language: 'en',
  userId: USER,
  groupIsGroup: extra.group ?? false,
  groupChatId: extra.group ? GROUP_CHAT : undefined,
});

const decide = (matcher: IntentMatcher, text: string) => matcher.explain(text);
const mutations = (calls: Recorded[]) => calls.filter((call) => isMutationTool(call.name, call.input));

const { matcher: allMatcher, idOf: allIds } = (() => {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  const built = matcherOver(seedRows(db));
  db.close();
  return built;
})();

function workflowFor(name: string) {
  const seed = seedIntents.find((candidate) => candidate.canonical_name === name)!;
  return WorkflowSchema.parse(seed.workflow);
}

async function runMessage(text: string, tools = stubTools(), ctx = userCtx()) {
  const decision = decide(allMatcher, text);
  if (decision.kind !== 'matched') throw new Error(`no rule for: ${text}`);
  const name = [...allIds.entries()].find(([, id]) => id === decision.result.intentId)![0];
  const workflow = workflowFor(name);
  const result = await new IntentExecutor().run(workflow, decision.result.captures, ctx, tools.run);
  return { name, workflow, result, tools, captures: decision.result.captures };
}

async function answer(
  name: string,
  first: Awaited<ReturnType<typeof runMessage>>,
  choice: 'yes' | 'no',
  captures = first.captures,
) {
  const { result, tools } = first;
  const options = result.responseOptions ?? [];
  const userAnswer = choice === 'yes' ? options[0]! : options[1]!;
  return new IntentExecutor().run(workflowFor(name), captures, userCtx(), tools.run, {
    stepIndex: result.suspendedAt!,
    stepResults: result.stepResults!,
    userAnswer,
  });
}

/** Direct writes are explicit, typed and reversible; every other write must ask first. */
const DIRECT_WRITES = new Set([
  'basis.settings.toggle',
  'basis.settings.agenda_time',
  'basis.settings.duration',
  'basis.settings.language',
  'basis.contacts.add',
  'basis.memory.remember',
]);

describe('static contract of all rules', () => {
  test('the basis has between 40 and 70 rules and metadata for each', () => {
    expect(seedIntents.length).toBeGreaterThanOrEqual(40);
    expect(seedIntents.length).toBeLessThanOrEqual(70);
    expect(canonicalMetadata.map((meta) => meta.name)).toEqual(seedIntents.map((seed) => seed.canonical_name));
  });

  test('every workflow passes the actual schema and validator and only names real tools', () => {
    for (const seed of seedIntents) {
      const parsed = WorkflowSchema.safeParse(seed.workflow);
      expect(parsed.success, seed.canonical_name).toBe(true);
      if (!parsed.success) continue;
      expect(validateWorkflow(parsed.data, seed.pattern), seed.canonical_name).toEqual([]);
      const steps = 'steps' in parsed.data ? parsed.data.steps : [];
      for (const step of steps)
        if (step.call && step.call !== 'ask_user')
          expect(Object.hasOwn(toolSchemas, step.call), `${seed.canonical_name}: ${step.call}`).toBe(true);
    }
  });

  test('every synthetic example routes to its own rule and no other', () => {
    for (const meta of canonicalMetadata)
      for (const example of meta.examples.synthetic)
        expect(decide(allMatcher, example), `${meta.name}: ${example}`).toMatchObject({
          kind: 'matched',
          result: { intentId: allIds.get(meta.name) },
        });
  });

  test('a negative example never routes to the family it is a negative of', () => {
    for (const meta of canonicalMetadata)
      for (const text of meta.negativeExamples) {
        const decision = decide(allMatcher, text);
        const routed = decision.kind === 'matched' ? decision.result.intentId : null;
        expect(routed, `${meta.name}: ${text}`).not.toBe(allIds.get(meta.name));
      }
  });

  test('empirical examples stay separate from synthetic ones', () => {
    for (const meta of canonicalMetadata) {
      expect(Array.isArray(meta.examples.empirical), meta.name).toBe(true);
      for (const text of meta.examples.empirical) expect(meta.examples.synthetic).not.toContain(text);
    }
  });

  test('no rule can pass force, drop the group guard on private data, or reach a forbidden tool', () => {
    const guarded = [
      'basis.contacts.',
      'basis.settings.',
      'basis.history.',
      'basis.actionlog.',
      'basis.memory.',
      'basis.invite.',
      'basis.secretary.invite',
      'basis.secretary.list',
      'basis.google.status',
      'basis.google.calendars',
      'basis.event.hide',
    ];
    for (const seed of seedIntents) {
      expect(JSON.stringify(seed.workflow), seed.canonical_name).not.toContain('"force"');
      const first = workflowFor(seed.canonical_name);
      const firstStep = 'steps' in first ? first.steps[0] : undefined;
      if (guarded.some((prefix) => seed.canonical_name.startsWith(prefix)))
        expect(firstStep?.when, seed.canonical_name).toBe('group.is_group == true');
    }
  });
});

describe('every example runs through the real executor and schema dispatch', () => {
  test('examples resolve cleanly, never write before asking, and only send schema-valid input', async () => {
    for (const meta of canonicalMetadata)
      for (const example of meta.examples.synthetic) {
        const run = await runMessage(example);
        const label = `${meta.name}: ${example}`;
        expect(run.result.errorCode, label).toBeUndefined();
        if (meta.risk === 'read' || meta.risk === 'private_read') {
          expect(mutations(run.tools.calls), label).toEqual([]);
          expect(run.result.success, label).toBe(true);
          continue;
        }
        if (DIRECT_WRITES.has(meta.name)) {
          expect(run.result.success, label).toBe(true);
          expect(mutations(run.tools.calls).length, label).toBeGreaterThan(0);
        } else {
          expect(run.result.suspended, label).toBe(true);
          expect(mutations(run.tools.calls), label).toEqual([]);
          expect(run.result.mutationEvidence, label).toBe('none');
        }
      }
  });

  test('a confirmed write happens exactly once and a denied one never happens', async () => {
    for (const meta of canonicalMetadata) {
      if (meta.risk === 'read' || meta.risk === 'private_read' || DIRECT_WRITES.has(meta.name)) continue;
      const example = meta.examples.synthetic[0]!;
      const yes = await runMessage(example);
      const done = await answer(meta.name, yes, 'yes');
      expect(done.success, meta.name).toBe(true);
      expect(mutations(yes.tools.calls).length, meta.name).toBe(1);
      const no = await runMessage(example);
      const cancelled = await answer(meta.name, no, 'no');
      expect(cancelled.success, meta.name).toBe(true);
      expect(mutations(no.tools.calls), meta.name).toEqual([]);
    }
  });

  test('every private rule refuses in a group before any tool runs', async () => {
    let checked = 0;
    for (const meta of canonicalMetadata) {
      const workflow = workflowFor(meta.name);
      const first = 'steps' in workflow ? workflow.steps[0] : undefined;
      if (first?.when !== 'group.is_group == true') continue;
      checked++;
      const run = await runMessage(meta.examples.synthetic[0]!, stubTools(), userCtx({ group: true }));
      expect(run.tools.calls, meta.name).toEqual([]);
      expect(run.result.success, meta.name).toBe(true);
      expect(run.result.response, meta.name).toBeTruthy();
      expect(run.result.mutationEvidence, meta.name).toBe('none');
    }
    expect(checked).toBeGreaterThanOrEqual(20);
  });

  test('typed arguments a pattern accepts but a binding rejects fail before any tool', async () => {
    let checked = 0;
    for (const meta of canonicalMetadata)
      for (const text of meta.invalidInputExamples) {
        checked++;
        const run = await runMessage(text);
        expect(run.name, text).toBe(meta.name);
        expect(run.result.success, text).toBe(false);
        expect(run.result.errorCode, text).toBe('INVALID_INPUT');
        expect(run.tools.calls, text).toEqual([]);
        expect(run.result.mutationEvidence, text).toBe('none');
      }
    expect(checked).toBeGreaterThan(10);
  });
});

describe('what the rules actually send', () => {
  test('a day and a week use the caller scope; a group reads the group calendar', async () => {
    const dm = await runMessage("what's tomorrow");
    expect(dm.tools.calls[0]).toEqual({
      name: 'get_events',
      input: { start_date: '2026-09-20', end_date: '2026-09-20', scope: 'personal' },
    });
    const week = await runMessage('show this week');
    expect(week.tools.calls[0]?.input).toMatchObject({ start_date: '2026-09-19', end_date: '2026-09-25' });
    const group = await runMessage('show this week', stubTools(), userCtx({ group: true }));
    expect(group.tools.calls[0]?.input).toMatchObject({ scope: 'group' });
  });

  test('free time for a week asks for the next seven days, starting today', async () => {
    const run = await runMessage('when am i free this week');
    const dates = run.tools.calls
      .filter((call) => call.name === 'get_free_slots')
      .map((call) => (call.input as { date: string }).date);
    expect(dates).toEqual([
      '2026-09-19',
      '2026-09-20',
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
    ]);
    for (const date of dates) expect(run.result.response).toContain(date);
  });

  test('a single day of free time defaults to today', async () => {
    const run = await runMessage('когда я свободен');
    expect(run.tools.calls[0]).toEqual({ name: 'get_free_slots', input: { date: '2026-09-19', scope: 'personal' } });
  });

  test('the image rule renders the matching kind with real date arguments', async () => {
    const month = await runMessage('show calendar as an image for this month');
    expect(month.tools.calls).toEqual([{ name: 'render_month_image', input: { month: '2026-09', scope: 'personal' } }]);
    const week = await runMessage('покажи календарь картинкой на следующую неделю');
    expect(week.tools.calls).toEqual([
      { name: 'render_week_image', input: { week_start: '2026-09-21', scope: 'personal' } },
    ]);
    const day = await runMessage('пришли расписание картинкой на завтра');
    expect(day.tools.calls).toEqual([{ name: 'render_day_image', input: { date: '2026-09-20', scope: 'personal' } }]);
  });

  test('a count reports the number of occurrences returned', async () => {
    const tools = stubTools({
      get_events: () => ({ success: true, output: '', data: [STANDUP, { ...STANDUP, id: 13 }] }),
    });
    const run = await runMessage('сколько событий на неделе', tools);
    expect(run.result.response).toContain('2');
  });

  test('the create rule sends an ISO instant with the offset of that date and no force', async () => {
    const run = await runMessage('create standup 2026-10-26 at 10:30');
    const done = await answer(run.name, run, 'yes');
    expect(done.success).toBe(true);
    const create = run.tools.calls.find((call) => call.name === 'create_event')!;
    expect(create.input).toEqual({ title: 'standup', start_at: '2026-10-26T10:30:00+01:00', scope: 'personal' });
  });

  test('the free-time check uses actual free intervals, not only events starting in the hour', async () => {
    const run = await runMessage('am i free tomorrow at 3pm');
    const call = run.tools.calls.find((entry) => entry.name === 'get_free_slots')!;
    expect(call.input).toMatchObject({ date: '2026-09-20', scope: 'personal' });
    expect(run.tools.calls.some((entry) => entry.name === 'get_events')).toBe(false);
  });

  test('settings toggles send real booleans in the right category', async () => {
    const off = await runMessage('disable morning agenda');
    expect(off.tools.calls[0]).toEqual({
      name: 'manage_settings',
      input: { action: 'update', category: 'notifications', updates: { morning_agenda_enabled: false } },
    });
    const on = await runMessage('включи голосовые ответы');
    expect(on.tools.calls[0]).toEqual({
      name: 'manage_settings',
      input: { action: 'update', category: 'voice', updates: { voice_response_enabled: true } },
    });
  });

  test('units are one rule: minutes and hours give minutes', async () => {
    const hours = await runMessage('remind me 2 hours before event #12');
    await answer(hours.name, hours, 'yes');
    expect(hours.tools.calls.find((call) => call.name === 'set_reminder')?.input).toMatchObject({
      event_id: 12,
      minutes_before: [120],
    });
    const minutes = await runMessage('отложи событие #12 на 15 минут');
    await answer(minutes.name, minutes, 'yes');
    expect(minutes.tools.calls.find((call) => call.name === 'snooze_event')?.input).toMatchObject({
      event_id: 12,
      minutes: 15,
    });
  });

  test('an invitation carries an exact @username or numeric ID, never force', async () => {
    const byName = await runMessage('invite @anna_smith to event #7');
    await answer(byName.name, byName, 'yes');
    expect(byName.tools.calls.find((call) => call.name === 'send_invitation')?.input).toEqual({
      event_id: 12,
      invitee_username: 'anna_smith',
    });
    const byId = await runMessage('пригласи 123456789 на событие #7');
    await answer(byId.name, byId, 'yes');
    expect(byId.tools.calls.find((call) => call.name === 'send_invitation')?.input).toEqual({
      event_id: 12,
      invitee_id: 123456789,
    });
  });

  test('access is only granted with a numeric ID and an explicit permission, after asking', async () => {
    const run = await runMessage('give user 123456789 read access to my calendar');
    expect(mutations(run.tools.calls)).toEqual([]);
    await answer(run.name, run, 'yes');
    expect(run.tools.calls.find((call) => call.name === 'manage_secretaries')?.input).toEqual({
      action: 'invite',
      secretary_telegram_id: 123456789,
      permission: 'read',
    });
    const byName = await runMessage('add @ivan_petrov as my secretary');
    expect(byName.name).toBe('basis.secretary.clarify');
    expect(byName.tools.calls).toEqual([]);
  });

  test('google disconnect only explains the command and calls nothing', async () => {
    const run = await runMessage('how do i disconnect google calendar');
    expect(run.tools.calls).toEqual([]);
    expect(run.result.response).toContain('/disconnect_google');
  });

  test('duplicate targets stop the workflow: several titles mean no write and a list to choose from', async () => {
    const tools = stubTools({
      search_events: () => ({ success: true, output: 'id: 12\nid: 13', data: [STANDUP, { ...STANDUP, id: 13 }] }),
    });
    for (const text of ['delete event standup', 'remind me 15 minutes before event standup', 'hide event standup']) {
      const run = await runMessage(text, tools);
      expect(mutations(run.tools.calls), text).toEqual([]);
      expect(run.result.suspended, text).toBeFalsy();
      expect(run.result.response, text).toContain('12');
    }
  });

  test('a title that matches nothing stops without a write', async () => {
    const tools = stubTools({ search_events: () => ({ success: true, output: '', data: [] }) });
    const run = await runMessage('delete event Nothing', tools);
    expect(mutations(run.tools.calls)).toEqual([]);
    expect(run.result.suspended).toBeFalsy();
    expect(run.result.response).toBeTruthy();
  });

  test('a rescheduled event that has an end time is refused instead of corrupted', async () => {
    const tools = stubTools({
      get_event: () => ({ success: true, output: 'e', data: { ...STANDUP, end_at: '2026-10-05T09:00:00.000Z' } }),
    });
    const run = await runMessage('reschedule event #12 to tomorrow at 3pm', tools);
    expect(run.result.suspended).toBeFalsy();
    expect(mutations(run.tools.calls)).toEqual([]);
  });
});

describe('malicious and control data stays data', () => {
  test('template, JSON and markup in a title are never evaluated or re-resolved', async () => {
    for (const title of ['{{user.id}}', '{"force":true}', '<b>x</b> & {{dates.today}}', `$${'{'}process.exit()}`]) {
      const run = await runMessage(`create ${title} tomorrow at 10:30`);
      const done = await answer(run.name, run, 'yes');
      expect(done.success, title).toBe(true);
      const create = run.tools.calls.find((call) => call.name === 'create_event')!;
      expect((create.input as { title: string }).title).toBe(title);
      expect(create.input).not.toHaveProperty('force');
    }
  });

  test('a value with a newline or control character cannot reach any tool', async () => {
    for (const text of ['create a\nb tomorrow at 10:30', 'remember that ab is a fact']) {
      const decision = decide(allMatcher, text);
      if (decision.kind !== 'matched') continue;
      const run = await runMessage(text);
      expect(mutations(run.tools.calls), text).toEqual([]);
    }
  });

  test('the calculator rule only accepts arithmetic characters', async () => {
    for (const text of ['calculate process.exit()', 'calc 1; rm -rf /', 'посчитай `id`'])
      expect(decide(allMatcher, text).kind, text).toBe('abstain');
    const run = await runMessage('calc 7*6');
    expect(run.tools.calls[0]).toEqual({ name: 'calculate', input: { expression: '7*6' } });
  });
});
