import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { createIntentMatcherLayer } from '../../src/bot/pipeline/intent-matcher-layer.ts';
import type { GroupContext } from '../../src/bot/pipeline/types.ts';
import type { BotCommandContext } from '../../src/bot/types.ts';
import { migrations } from '../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../src/database/repositories/chat-history.repository.ts';
import { ContactRepository } from '../../src/database/repositories/contact.repository.ts';
import { EventRepository } from '../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../src/database/repositories/holiday.repository.ts';
import { IntentRepository } from '../../src/database/repositories/intent.repository.ts';
import { NotificationPreferencesRepository } from '../../src/database/repositories/notification-preferences.repository.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import { WorkflowSessionRepository } from '../../src/database/repositories/workflow-session.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import { _resetToolThrottleForTest, executeTool, isMutationTool } from '../../src/services/ai/tool-executor.ts';
import { toolSchemas } from '../../src/services/ai/tool-schemas.ts';
import type { AgentContext, ToolResult } from '../../src/services/ai/types.ts';
import { ConversationLogger } from '../../src/services/conversation-logger.ts';
import { EventService } from '../../src/services/event/event-service.ts';
import { HolidayService } from '../../src/services/holiday/holiday-service.ts';
import { IntentExecutor } from '../../src/services/intent/intent-executor.ts';
import { IntentMatcher } from '../../src/services/intent/intent-matcher.ts';
import { canonicalMetadata, seedIntents } from '../../src/services/intent/seed-catalog.ts';
import type { EventSummary } from '../../src/services/intent/variable-resolver.ts';
import { WorkflowSchema } from '../../src/services/intent/workflow-schema.ts';
import { validateWorkflow } from '../../src/services/intent/workflow-validator.ts';

// Saturday 2026-09-19 10:00 in Belgrade (UTC+2). The clocks go back on 2026-10-25 and forward on 2027-03-28.
const NOW = new Date('2026-09-19T08:00:00Z');
const USER = 7001;
const OTHER = 7002;
const GROUP_CHAT = -100500;

type IntentRow = Parameters<IntentMatcher['load']>[0][number];

function seedRows(db: Database): IntentRow[] {
  const insert = db.query(
    'INSERT INTO intents (canonical_name,phrases,trigger_words,pattern,workflow,status,format,source_message) VALUES(?,?,?,?,?,?,?,?)',
  );
  for (const seed of seedIntents)
    insert.run(
      seed.canonical_name,
      JSON.stringify(seed.phrases),
      JSON.stringify(seed.trigger_words),
      seed.pattern,
      JSON.stringify(seed.workflow),
      'approved',
      'text',
      seed.source_message,
    );
  return db.query<IntentRow, []>('SELECT * FROM intents').all();
}

function matcherOver(rows: IntentRow[]): { matcher: IntentMatcher; idOf: Map<string, number> } {
  const matcher = new IntentMatcher();
  matcher.load(rows);
  return { matcher, idOf: new Map(rows.map((row) => [row.canonical_name, row.id])) };
}

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
    expect(week.tools.calls[0]?.input).toMatchObject({ start_date: '2026-09-14', end_date: '2026-09-20' });
    const group = await runMessage('show this week', stubTools(), userCtx({ group: true }));
    expect(group.tools.calls[0]?.input).toMatchObject({ scope: 'group' });
  });

  test('free time for a week asks for all seven days, Monday to Sunday', async () => {
    const run = await runMessage('when am i free this week');
    const dates = run.tools.calls
      .filter((call) => call.name === 'get_free_slots')
      .map((call) => (call.input as { date: string }).date);
    expect(dates).toEqual([
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
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

// ─── real SQLite: real tools, real repositories, real pipeline layer ──────────────────────────────────

let db: Database;
beforeEach(() => {
  _resetToolThrottleForTest();
  setSystemTime(NOW);
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  runMigrations(db, migrations);
});
afterEach(() => {
  setSystemTime();
  db.close();
});

interface Fixture {
  layer: ReturnType<typeof createIntentMatcherLayer>;
  users: UserRepository;
  events: EventService;
  contacts: ContactRepository;
  store: WorkflowSessionRepository;
  send: ReturnType<typeof mock>;
  call: ReturnType<typeof mock>;
  mentioned: ReturnType<typeof mock>;
  say: (text: string, opts?: { as?: number; chat?: number; group?: boolean }) => Promise<{ handled: boolean }>;
  yes: () => Promise<{ handled: boolean }>;
  no: () => Promise<{ handled: boolean }>;
  lastText: () => string;
  eventRows: () => { id: number; title: string; start_at: string; reminder_overrides: string | null }[];
  addEvent: (title: string, start?: string) => number;
}

function fixture(
  options: {
    tz?: string;
    lastMentioned?: EventSummary;
    wrapTool?: (name: string, input: unknown, real: () => Promise<ToolResult>) => Promise<ToolResult>;
  } = {},
): Fixture {
  const users = new UserRepository(db);
  users.create({ telegram_id: USER, timezone: options.tz ?? 'Europe/Belgrade', language: 'en', first_name: 'Ann' });
  users.create({ telegram_id: OTHER, timezone: 'UTC', language: 'en' });
  const eventRepo = new EventRepository(db);
  const events = new EventService({ eventRepo });
  const contacts = new ContactRepository(db);
  const prefsRepo = new NotificationPreferencesRepository(db);
  const history = new ChatHistoryRepository(db);
  const rows = seedRows(db);
  const { matcher } = matcherOver(rows);
  const store = new WorkflowSessionRepository(db);
  const buildCtx = (actor: number, chat: number, group: boolean, messageText: string): AgentContext =>
    ({
      user: users.findByTelegramId(actor)!,
      chatId: chat,
      messageText,
      isGroup: group,
      groupChatId: group ? chat : undefined,
      userRepo: users,
      contactRepo: contacts,
      eventService: events,
      holidayService: new HolidayService(new HolidayRepository(db)),
      chatHistory: history,
      eventReminderRepo: new EventReminderRepository(db),
      conversationLogger: new ConversationLogger(history),
      notifications: {
        notificationPrefs: {
          ensureDefaults: (id: number) => prefsRepo.ensureDefaults(id),
          getPrefs: (id: number) => prefsRepo.get(id)!,
          update: (id: number, patch: never) => prefsRepo.update(id, patch),
        },
      },
    }) as unknown as AgentContext;
  let actor = USER;
  let chat = USER;
  let group = false;
  let text = '';
  const call = mock((name: string, input: unknown) => {
    const real = () => executeTool(buildCtx(actor, chat, group, text), name, input);
    return options.wrapTool ? options.wrapTool(name, input, real) : real();
  });
  const mentioned = mock((_user: number, _event: number) => {});
  const send = mock(async (_text: string, _opts?: unknown) => ({ message_id: 1 }));
  const layer = createIntentMatcherLayer(
    matcher,
    new IntentRepository(db),
    new IntentExecutor(),
    call,
    store,
    undefined,
    async () => (options.lastMentioned ? { lastMentionedEvent: options.lastMentioned } : {}),
    mentioned,
  );
  const say: Fixture['say'] = async (message, opts = {}) => {
    actor = opts.as ?? USER;
    group = opts.group ?? false;
    chat = opts.chat ?? (group ? GROUP_CHAT : actor);
    text = message;
    const ctx = { dbUser: users.findByTelegramId(actor)!, chatId: chat, id: 1, send } as unknown as BotCommandContext;
    const groupContext: GroupContext | undefined = group ? { isGroup: true, groupChatId: chat } : undefined;
    return layer(ctx, message, groupContext ? { groupContext } : undefined);
  };
  const choices = (): string[] => {
    const markup = (send.mock.calls.at(-1)?.[1] as { reply_markup?: { keyboard?: { text: string }[][] } } | undefined)
      ?.reply_markup;
    return (markup?.keyboard ?? []).flat().map((button) => button.text);
  };
  return {
    layer,
    users,
    events,
    contacts,
    store,
    send,
    call,
    mentioned,
    say,
    yes: () => say(choices()[0]!),
    no: () => say(choices()[1]!),
    lastText: () => String(send.mock.calls.at(-1)?.[0] ?? ''),
    eventRows: () =>
      db
        .query<{ id: number; title: string; start_at: string; reminder_overrides: string | null }, []>(
          'SELECT id,title,start_at,reminder_overrides FROM events WHERE is_deleted=0 ORDER BY id',
        )
        .all(),
    addEvent: (title, start = '2026-10-05T10:00:00+02:00') =>
      events.createEvent({ user_id: USER, title, start_at: start, timezone: 'Europe/Belgrade' }).id,
  };
}

const toolNames = (f: Fixture) => f.call.mock.calls.map((entry) => entry[0]);
const mutationCalls = (f: Fixture) => f.call.mock.calls.filter((entry) => isMutationTool(entry[0], entry[1]));

describe('creating an event against real SQLite', () => {
  test('nothing is written before the answer; yes writes once; a repeated yes writes nothing more', async () => {
    const f = fixture();
    expect(await f.say('create standup tomorrow at 10:30')).toEqual({ handled: true });
    expect(f.eventRows()).toEqual([]);
    expect(mutationCalls(f)).toEqual([]);
    expect(f.store.get(USER, USER)).not.toBeNull();
    await f.yes();
    const rows = f.eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('standup');
    expect(Date.parse(rows[0]!.start_at)).toBe(Date.parse('2026-09-20T10:30:00+02:00'));
    expect(f.store.get(USER, USER)).toBeNull();
    const again = await f.say('Yes');
    expect(again.handled).toBe(false);
    expect(f.eventRows()).toHaveLength(1);
    expect(mutationCalls(f)).toHaveLength(1);
  });

  test('cancelling leaves the calendar unchanged and clears the pending question', async () => {
    const f = fixture();
    await f.say('create standup tomorrow at 10:30');
    await f.no();
    expect(f.eventRows()).toEqual([]);
    expect(f.store.get(USER, USER)).toBeNull();
    expect(mutationCalls(f)).toEqual([]);
  });

  test('the pending date stays frozen when the answer arrives after midnight', async () => {
    setSystemTime(new Date('2026-09-19T21:59:00Z'));
    const f = fixture();
    await f.say('create standup tomorrow at 10:30');
    setSystemTime(new Date('2026-09-19T22:01:00Z'));
    await f.yes();
    expect(f.eventRows().map((row) => Date.parse(row.start_at))).toEqual([Date.parse('2026-09-20T10:30:00+02:00')]);
  });

  test('past, ambiguous, skipped and bare-hour times fall through with no write and no tool call', async () => {
    const f = fixture();
    for (const text of [
      'create standup yesterday at 10:30',
      'create standup 2026-10-25 at 02:30',
      'create standup 2027-03-28 at 02:30',
      'create standup tomorrow at 10',
      'create standup 31 февраля в 10:30',
    ]) {
      expect((await f.say(text)).handled, text).toBe(false);
    }
    expect(f.call).not.toHaveBeenCalled();
    expect(f.eventRows()).toEqual([]);
    expect(f.store.get(USER, USER)).toBeNull();
  });

  test('a hostile title is stored verbatim and shown escaped', async () => {
    const f = fixture();
    await f.say('create <b>{{user.id}}</b> & co tomorrow at 10:30');
    const prompt = f.lastText();
    expect(prompt).not.toContain('<b>');
    expect(prompt).toContain('&lt;b&gt;');
    await f.yes();
    expect(f.eventRows()[0]!.title).toBe('<b>{{user.id}}</b> & co');
  });

  test("another person or another chat cannot answer someone else's question", async () => {
    const f = fixture();
    await f.say('create standup tomorrow at 10:30');
    expect((await f.say('Yes', { as: OTHER, chat: USER })).handled).toBe(false);
    expect((await f.say('Yes', { chat: 999 })).handled).toBe(false);
    expect(f.eventRows()).toEqual([]);
    expect(f.store.get(USER, USER)).not.toBeNull();
    await f.yes();
    expect(f.eventRows()).toHaveLength(1);
  });

  test('an answer that is not one of the offered choices does not write and keeps the question', async () => {
    const f = fixture();
    await f.say('create standup tomorrow at 10:30');
    await f.say('maybe later');
    expect(f.eventRows()).toEqual([]);
    expect(f.store.get(USER, USER)).not.toBeNull();
  });
});

describe('deleting by title or number against real SQLite', () => {
  test('several matches: nothing is deleted and nothing is asked', async () => {
    const f = fixture();
    f.addEvent('Sync A');
    f.addEvent('Sync B');
    expect(await f.say('delete event Sync')).toMatchObject({ handled: true });
    expect(f.eventRows()).toHaveLength(2);
    expect(mutationCalls(f)).toEqual([]);
    expect(f.store.get(USER, USER)).toBeNull();
    expect(f.mentioned).not.toHaveBeenCalled();
  });

  test('one match: asks with the event named, deletes once on yes, and a second yes does nothing', async () => {
    const f = fixture();
    f.addEvent('Retro');
    f.addEvent('Planning');
    await f.say('delete event Retro');
    expect(f.lastText()).toContain('Retro');
    expect(f.eventRows()).toHaveLength(2);
    await f.yes();
    expect(f.eventRows().map((row) => row.title)).toEqual(['Planning']);
    expect((await f.say('Yes')).handled).toBe(false);
    expect(mutationCalls(f)).toHaveLength(1);
  });

  test('a number selects that event; cancelling keeps it', async () => {
    const f = fixture();
    const id = f.addEvent('Retro');
    await f.say(`delete event #${id}`);
    await f.no();
    expect(f.eventRows()).toHaveLength(1);
    await f.say(`delete event #${id}`);
    await f.yes();
    expect(f.eventRows()).toHaveLength(0);
  });

  test('the chosen event is the searched one, not the last mentioned one', async () => {
    const options: { lastMentioned?: EventSummary } = {};
    const f = fixture(options);
    const alpha = f.addEvent('Alpha');
    const beta = f.addEvent('Beta');
    options.lastMentioned = { id: beta, title: 'Beta', date: '2026-10-05', all_day: false };
    await f.say('delete event Alpha');
    await f.yes();
    expect(f.eventRows().map((row) => row.id)).toEqual([beta]);
    expect(alpha).not.toBe(beta);
  });

  test('a bulk request never reaches a write rule', async () => {
    const f = fixture();
    f.addEvent('One');
    f.addEvent('Two');
    for (const text of ['delete all events', 'удали все события', 'delete event all', 'удали событие все'])
      expect((await f.say(text)).handled, text).toBe(false);
    expect(f.eventRows()).toHaveLength(2);
    expect(mutationCalls(f)).toEqual([]);
  });

  test('renaming needs a number or quoted title and asks first', async () => {
    const f = fixture();
    const id = f.addEvent('Retro');
    expect((await f.say('rename event Retro to Planning')).handled).toBe(false);
    await f.say(`rename event #${id} to Planning`);
    expect(f.eventRows()[0]!.title).toBe('Retro');
    await f.yes();
    expect(f.eventRows()[0]!.title).toBe('Planning');
  });
});

describe('reminders against real SQLite', () => {
  test('a standalone reminder is one explicit confirmed entry, not a duplicate of an existing event', async () => {
    const f = fixture();
    f.addEvent('Existing unrelated event');
    await f.say('напомни через 10 минут позвонить маме');
    expect(f.eventRows()).toHaveLength(1);
    expect(f.lastText()).toContain('reminder event');
    await f.no();
    expect(f.eventRows()).toHaveLength(1);
    await f.say('remind me in 10 minutes take a break');
    await f.yes();
    const added = f.eventRows().find((row) => row.title === 'take a break');
    expect(added).toBeDefined();
    expect(Date.parse(added!.start_at)).toBe(NOW.getTime() + 600000);
    expect(JSON.parse(added!.reminder_overrides!)).toEqual([0]);
    expect(f.eventRows()).toHaveLength(2);
  });

  test('a reminder attaches to the real event and creates no extra event', async () => {
    const f = fixture();
    const id = f.addEvent('Retro');
    await f.say('remind me 15 minutes before event Retro');
    expect(f.eventRows()[0]!.reminder_overrides).toBeNull();
    await f.yes();
    expect(f.eventRows()).toHaveLength(1);
    expect(JSON.parse(f.eventRows().find((row) => row.id === id)!.reminder_overrides!)).toEqual([15]);
    expect(toolNames(f)).toContain('set_reminder');
    expect(toolNames(f)).not.toContain('create_event');
  });

  test('missing or ambiguous existing-event reminders change nothing', async () => {
    const f = fixture();
    f.addEvent('Sync A');
    f.addEvent('Sync B');
    expect((await f.say('remind me to call mom')).handled).toBe(false);
    await f.say('remind me 15 minutes before event Nothing');
    await f.say('remind me 15 minutes before event Sync');
    expect(f.eventRows()).toHaveLength(2);
    expect(f.eventRows().every((row) => row.reminder_overrides === null)).toBe(true);
    expect(mutationCalls(f)).toEqual([]);
  });

  test('a confirmed standalone reminder creates one explicitly described entry, with notification at start', async () => {
    const f = fixture();
    const intended = Date.now() + 10 * 60000;
    await f.say('напомни через 10 минут сделать перерыв');
    expect(f.eventRows()).toHaveLength(0);
    await f.yes();
    const rows = f.eventRows();
    expect(rows).toHaveLength(1);
    expect(Date.parse(rows[0]!.start_at)).toBe(intended);
    expect(JSON.parse(rows[0]!.reminder_overrides!)).toEqual([0]);
    expect(mutationCalls(f).filter((call) => call[0] === 'create_event')).toHaveLength(1);
  });
  test('explicit start and end are saved as one confirmed interval', async () => {
    const f = fixture();
    await f.say('создай стендап завтра с 10:00 до 11:00');
    expect(f.eventRows()).toHaveLength(0);
    await f.yes();
    const events = f.eventRows().map((row) => f.events.getEvent(row.id, USER)!);
    expect(events).toHaveLength(1);
    expect(Date.parse(events[0]!.end_at!) - Date.parse(events[0]!.start_at)).toBe(3600000);
  });

  test('clearing reminders sets an empty list only after confirmation', async () => {
    const f = fixture();
    const id = f.addEvent('Retro');
    await f.say(`remind me 30 minutes before event #${id}`);
    await f.yes();
    await f.say(`clear reminders for event #${id}`);
    expect(JSON.parse(f.eventRows()[0]!.reminder_overrides!)).toEqual([30]);
    await f.yes();
    expect(JSON.parse(f.eventRows()[0]!.reminder_overrides!)).toEqual([]);
  });
});

describe('settings and contacts against real SQLite', () => {
  test('typed toggles change the stored flags and nothing else', async () => {
    const f = fixture();
    const prefs = new NotificationPreferencesRepository(db);
    prefs.ensureDefaults(USER);
    prefs.ensureDefaults(OTHER);
    const eveningBefore = prefs.get(USER)!.evening_review_enabled;
    await f.say('disable morning agenda');
    expect(prefs.get(USER)!.morning_agenda_enabled).toBe(0);
    expect(prefs.get(USER)!.evening_review_enabled).toBe(eveningBefore);
    expect(prefs.get(OTHER)!.morning_agenda_enabled).toBe(1);
    await f.say('turn on morning agenda');
    expect(prefs.get(USER)!.morning_agenda_enabled).toBe(1);
  });

  test('duration and language are validated before the write', async () => {
    const f = fixture();
    await f.say('set default event duration to 90 minutes');
    expect(f.users.findByTelegramId(USER)!.default_event_duration_minutes).toBe(90);
    expect((await f.say('поставь длительность события по умолчанию 0 минут')).handled).toBe(false);
    expect(f.users.findByTelegramId(USER)!.default_event_duration_minutes).toBe(90);
    await f.say('switch language to russian');
    expect(f.users.findByTelegramId(USER)!.language).toBe('ru');
    expect((await f.say('switch language to klingon')).handled).toBe(false);
  });

  test('a settings change in a group is refused before any tool and changes nothing', async () => {
    const f = fixture();
    const prefs = new NotificationPreferencesRepository(db);
    prefs.ensureDefaults(USER);
    await f.say('disable morning agenda', { group: true });
    expect(f.call).not.toHaveBeenCalled();
    expect(prefs.get(USER)!.morning_agenda_enabled).toBe(1);
    expect(f.lastText().length).toBeGreaterThan(0);
  });

  test('contacts are private: a group is refused before any tool, a private chat is served', async () => {
    const f = fixture();
    f.contacts.upsert(USER, 'Ivan');
    await f.say('show my contacts', { group: true });
    expect(f.call).not.toHaveBeenCalled();
    await f.say('show my contacts');
    expect(toolNames(f)).toEqual(['get_contacts']);
  });

  test('deleting a contact needs one match and a yes, and a second yes does nothing', async () => {
    const f = fixture();
    f.contacts.upsert(USER, 'Ivan Petrov');
    f.contacts.upsert(USER, 'Ivan Sidorov');
    f.contacts.upsert(USER, 'Anna');
    await f.say('delete contact Ivan');
    expect(f.contacts.list(USER)).toHaveLength(3);
    expect(f.store.get(USER, USER)).toBeNull();
    await f.say('delete contact Anna');
    await f.yes();
    expect(
      f.contacts
        .list(USER)
        .map((contact) => contact.name)
        .sort(),
    ).toEqual(['Ivan Petrov', 'Ivan Sidorov']);
    expect((await f.say('Yes')).handled).toBe(false);
    expect(f.contacts.list(USER)).toHaveLength(2);
  });

  test('adding a contact is scoped to the caller', async () => {
    const f = fixture();
    await f.say('add contact Mark Twain');
    expect(f.contacts.list(USER).map((contact) => contact.name)).toEqual(['Mark Twain']);
    expect(f.contacts.list(OTHER)).toEqual([]);
  });
});

describe('failures never replay a write through the assistant', () => {
  const insertFlow = (name: string, phrase: string, workflow: object) =>
    db
      .query('INSERT INTO intents (canonical_name,phrases,trigger_words,workflow,status,format) VALUES(?,?,?,?,?,?)')
      .run(name, JSON.stringify([phrase]), '[]', JSON.stringify(workflow), 'approved', 'text');

  function flowFixture(
    workflow: object,
    wrapTool?: (name: string, input: unknown, real: () => Promise<ToolResult>) => Promise<ToolResult>,
  ) {
    const f = fixture({ wrapTool });
    // The synthetic rule joins the loaded matcher through a second layer over the same database.
    insertFlow('synthetic.flow', 'run synthetic flow', workflow);
    const rows = db.query<IntentRow, []>('SELECT * FROM intents').all();
    const { matcher } = matcherOver(rows);
    const send = mock(async () => ({ message_id: 1 }));
    const store = new WorkflowSessionRepository(db);
    const layer = createIntentMatcherLayer(matcher, new IntentRepository(db), new IntentExecutor(), f.call, store);
    const ctx = { dbUser: f.users.findByTelegramId(USER)!, chatId: USER, id: 1, send } as unknown as BotCommandContext;
    return { f, send, layer: (text: string) => layer(ctx, text), ctx };
  }

  const createThenBreak = {
    version: 2,
    steps: [
      { call: 'create_event', input: { title: 'x', start_at: '2030-01-01T10:00:00+01:00' } },
      { respond: '{{bind.missing}}' },
    ],
  };

  test('a step failing after a confirmed write ends the request without the assistant', async () => {
    const { f, send, layer } = flowFixture(createThenBreak);
    expect(await layer('run synthetic flow')).toEqual({ handled: true });
    expect(f.eventRows()).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(mutationCalls(f)).toHaveLength(1);
  });

  test('an uncertain write blocks replay too, and the tool is called once', async () => {
    const { f, layer } = flowFixture(
      { version: 2, steps: [{ call: 'create_event', input: { title: 'x', start_at: '2030-01-01T10:00:00+01:00' } }] },
      async () => ({ success: false, error: 'timeout', mutationState: 'uncertain' }),
    );
    expect(await layer('run synthetic flow')).toEqual({ handled: true });
    expect(f.call).toHaveBeenCalledTimes(1);
  });

  test('a tool that throws after a possible write is contained, not retried', async () => {
    const { f, layer } = flowFixture(
      { version: 2, steps: [{ call: 'create_event', input: { title: 'x', start_at: '2030-01-01T10:00:00+01:00' } }] },
      async () => {
        throw new Error('connection lost');
      },
    );
    expect(await layer('run synthetic flow')).toEqual({ handled: true });
    expect(f.call).toHaveBeenCalledTimes(1);
  });

  test('a failure after reads only may still fall back to the assistant', async () => {
    const { f, layer } = flowFixture({
      version: 2,
      steps: [
        { call: 'get_events', input: { start_date: '2026-09-19', end_date: '2026-09-19' } },
        { respond: '{{bind.missing}}' },
      ],
    });
    expect(await layer('run synthetic flow')).toEqual({ handled: false });
    expect(mutationCalls(f)).toEqual([]);
  });

  test('a failed answer to a question is terminal: the consumed answer is not replayed as a request', async () => {
    const { f, layer, send } = flowFixture(
      {
        version: 2,
        steps: [
          { call: 'ask_user', input: { question: 'Go?', options: ['Yes', 'No'] }, as: 'go' },
          { call: 'create_event', input: { title: 'x', start_at: '2030-01-01T10:00:00+01:00' } },
        ],
      },
      async (name) =>
        name === 'create_event'
          ? { success: false, error: 'boom', mutationState: 'uncertain' }
          : { success: true, output: '' },
    );
    await layer('run synthetic flow');
    expect((await layer('Yes')).handled).toBe(true);
    expect(send.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(f.call).toHaveBeenCalledTimes(1);
  });
});
