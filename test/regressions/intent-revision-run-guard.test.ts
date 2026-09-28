// A suspended or running intent workflow must never write through a rule the administrator has
// since changed: an approval committed while the run is in flight leaves the running workflow on
// its snapshot, but its resume, and every tool call dispatched after the change, stop unapplied.
// Real migrated SQLite, the real layer, executor, tool dispatcher, ledger and session store; only
// the Telegram transport is faked.
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { createIntentMatcherLayer } from '../../src/bot/pipeline/intent-matcher-layer.ts';
import type { BotCommandContext } from '../../src/bot/types.ts';
import { t } from '../../src/config/constants.ts';
import { ChatHistoryRepository } from '../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../src/database/repositories/holiday.repository.ts';
import { IntentRepository } from '../../src/database/repositories/intent.repository.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import { WorkflowSessionRepository } from '../../src/database/repositories/workflow-session.repository.ts';
import { _resetToolThrottleForTest, executeTool } from '../../src/services/ai/tool-executor.ts';
import type { AgentContext } from '../../src/services/ai/types.ts';
import { ConversationLogger } from '../../src/services/conversation-logger.ts';
import { EventService } from '../../src/services/event/event-service.ts';
import { HolidayService } from '../../src/services/holiday/holiday-service.ts';
import { IntentExecutor } from '../../src/services/intent/intent-executor.ts';
import { IntentMatcher } from '../../src/services/intent/intent-matcher.ts';
import type { RevisionBodyInput } from '../../src/services/intent/revision-body.ts';
import { adminFromTelegram, IntentRevisionService } from '../../src/services/intent/revision-service.ts';
import type { JsonValue } from '../../src/services/intent/rule-fingerprint.ts';
import { seedIntents } from '../../src/services/intent/seed-catalog.ts';
import { WorkflowSchema } from '../../src/services/intent/workflow-schema.ts';
import { installSeed, openTempRegistry, type TempRegistry } from '../helpers/intent-registry.ts';

const USER = 890020001;
const DEFAULT_MINUTES = 60;
const readSettings = { call: 'manage_settings', input: { action: 'get', category: 'general' }, as: 'original' };
const writeSettings = {
  call: 'manage_settings',
  input: { action: 'update', category: 'general', updates: { default_event_duration_minutes: 30 } },
};
const ASK_STEPS: JsonValue[] = [
  { call: 'ask_user', input: { question: 'Apply?', options: ['Yes', 'No'] }, as: 'confirm' },
  { when: "ask.confirm == 'No'", respond: 'Cancelled; unchanged.' },
  writeSettings,
  { respond: 'Updated.' },
];
const ASK_FLOW: JsonValue = { version: 2, steps: [readSettings, ...ASK_STEPS] };
const DIRECT_FLOW: JsonValue = { version: 2, steps: [readSettings, writeSettings, { respond: 'Updated.' }] };

const rule = (name: string, workflow: JsonValue, phrases: string[]) => ({
  canonical_name: name,
  pattern: `^(?:${phrases.join('|')})$`,
  workflow,
  phrases,
  trigger_words: ['duration'],
  source_message: phrases[0]!,
});
const create = (intent: ReturnType<typeof rule>): RevisionBodyInput => ({
  type: 'operations',
  summary: `Add ${intent.canonical_name}`,
  operations: [{ kind: 'create', sourceNames: [], reason: 'settings shortcut', intents: [intent] }],
});
const generalize = (intent: ReturnType<typeof rule>): RevisionBodyInput => ({
  type: 'operations',
  summary: `Widen ${intent.canonical_name}`,
  operations: [
    { kind: 'generalize', sourceNames: [intent.canonical_name], reason: 'another wording', intents: [intent] },
  ],
});

let registry: TempRegistry;
beforeEach(() => {
  registry = openTempRegistry();
  _resetToolThrottleForTest();
});
afterEach(() => registry.close());

function fixture(workflow: JsonValue, options: { unmanaged?: boolean; format?: string } = {}) {
  const db = registry.db;
  installSeed(db, [seedIntents.find((seed) => seed.canonical_name === 'basis.time.now')!]);
  const users = new UserRepository(db);
  const user = users.create({ telegram_id: USER, timezone: 'UTC', language: 'en' });
  const sessions = new WorkflowSessionRepository(db);
  const intents = new IntentRepository(db);
  const service = new IntentRevisionService(db, { sessions });
  const admin = adminFromTelegram(42, 42)!;
  const approve = (body: RevisionBodyInput) => {
    const proposed = service.propose(body, { kind: 'manual', principal: admin });
    if (proposed.status !== 'created' || proposed.revision.status !== 'validated')
      throw new Error(`revision not validated: ${JSON.stringify(proposed)}`);
    const { id, bodyHash, baseRevisionId } = proposed.revision;
    const result = service.approve(admin, { id, bodyHash, baseRevisionId: baseRevisionId! });
    if (result.status !== 'active') throw new Error(`approval refused: ${result.code}`);
    return id;
  };
  const initial = rule('manual.duration', workflow, ['configure duration']);
  if (options.unmanaged) {
    registry.db.run('DELETE FROM intents');
    registry.db.run('DELETE FROM intent_basis_manifest');
    registry.db.run('DELETE FROM intent_revisions');
    const format = options.format ?? 'text';
    const id = intents.create({ ...initial, workflow: WorkflowSchema.parse(workflow), format });
    intents.updateStatus(id, 'approved');
  } else approve(create(initial));
  const changed = generalize(rule('manual.duration', workflow, ['configure duration', 'set duration']));
  const matcher = new IntentMatcher();
  matcher.load(intents.getApproved());
  const history = new ChatHistoryRepository(db);
  const agentCtx: AgentContext = {
    user,
    chatId: USER,
    messageText: 'configure duration',
    isGroup: false,
    userRepo: users,
    eventService: new EventService({ eventRepo: new EventRepository(db) }),
    holidayService: new HolidayService(new HolidayRepository(db)),
    chatHistory: history,
    eventReminderRepo: new EventReminderRepository(db),
    conversationLogger: new ConversationLogger(history),
  };
  let duringNextTool: (() => void) | null = null;
  const dispatch = (name: string, input: unknown) => {
    const hook = duringNextTool;
    duringNextTool = null;
    hook?.();
    return executeTool(agentCtx, name, input);
  };
  const layer = createIntentMatcherLayer(matcher, intents, new IntentExecutor(), dispatch, sessions);
  const sent: string[] = [];
  const send = mock(async (text: string, _options?: unknown) => {
    sent.push(text);
    return { message_id: 1 };
  });
  const ctx = { dbUser: user, chatId: USER, id: 1, send } as unknown as BotCommandContext;
  return {
    db,
    service,
    sessions,
    matcher,
    intents,
    sent,
    approve,
    changed,
    say: (text: string) => layer(ctx, text),
    minutes: () => users.findByTelegramId(USER)?.default_event_duration_minutes,
    idOf: (name: string) =>
      db.query<{ id: number }, [string]>('SELECT id FROM intents WHERE canonical_name=?').get(name)?.id,
    approveDuringNextTool: (body: RevisionBodyInput) => {
      duringNextTool = () => approve(body);
    },
    duringNextTool: (hook: () => void) => {
      duringNextTool = hook;
    },
  };
}
const refusal = t('en').intentWorkflow.failedUnchanged;

test('an approval committed mid-run keeps the running snapshot and refuses its resume', async () => {
  const f = fixture(ASK_FLOW);
  const matchedId = f.idOf('manual.duration');
  f.approveDuringNextTool(f.changed);
  expect(await f.say('configure duration')).toEqual({ handled: true });
  // The approval committed inside the first tool call; the run still asked its own question.
  expect(f.service.activeRevisionId()).not.toBeNull();
  expect(f.idOf('manual.duration')).not.toBe(matchedId);
  expect(f.sent.at(-1)).toBe('Apply?');
  expect(f.sessions.get(USER, USER)?.intentId).toBe(matchedId);
  expect(await f.say('Yes')).toEqual({ handled: true });
  expect(f.minutes()).toBe(DEFAULT_MINUTES);
  expect(f.sessions.get(USER, USER)).toBeNull();
  expect(f.sent.at(-1)).toBe(refusal);
});

test('an in-flight run whose rule changes before its write stops without writing', async () => {
  const f = fixture(DIRECT_FLOW);
  f.approveDuringNextTool(f.changed);
  const result = await f.say('configure duration');
  expect(f.minutes()).toBe(DEFAULT_MINUTES);
  expect(result).toEqual({ handled: true });
  expect(f.sessions.get(USER, USER)).toBeNull();
  expect(f.sent).toEqual([refusal]);
});

test('a refused resume after an earlier write of the same run does not claim nothing changed', async () => {
  const write45 = {
    ...writeSettings,
    input: { ...writeSettings.input, updates: { default_event_duration_minutes: 45 } },
  };
  const f = fixture({ version: 2, steps: [write45, ...ASK_STEPS] });
  f.approveDuringNextTool(f.changed);
  await f.say('configure duration');
  expect(f.minutes()).toBe(45);
  expect(await f.say('Yes')).toEqual({ handled: true });
  expect(f.minutes()).toBe(45);
  expect(f.sent.at(-1)).toBe(t('en').intentWorkflow.appliedIncomplete);
});

test('a change observed mid-resume stops the next write and reports the earlier one', async () => {
  const write45 = {
    ...writeSettings,
    input: { ...writeSettings.input, updates: { default_event_duration_minutes: 45 } },
  };
  const f = fixture({ version: 2, steps: [write45, ...ASK_STEPS.slice(0, 2), readSettings, ...ASK_STEPS.slice(2)] });
  await f.say('configure duration');
  expect(f.minutes()).toBe(45);
  f.approveDuringNextTool(f.changed);
  expect(await f.say('Yes')).toEqual({ handled: true });
  expect(f.minutes()).toBe(45);
  expect(f.sessions.get(USER, USER)).toBeNull();
  expect(f.sent.at(-1)).toBe(t('en').intentWorkflow.appliedIncomplete);
});

test('a rule edited right after the run read it is refused at its first tool call', async () => {
  // An unmanaged registry edits a rule in place (same id); the edit lands between the read that
  // produced the running workflow and anything after it, as another connection could.
  const f = fixture(DIRECT_FLOW, { unmanaged: true });
  const id = f.idOf('manual.duration')!;
  const read = f.intents.getById.bind(f.intents);
  let editPending = true;
  f.intents.getById = (intentId: number) => {
    const row = read(intentId);
    if (editPending) {
      editPending = false;
      f.intents.update(intentId, { phrases: ['configure duration', 'edited elsewhere'] });
    }
    return row;
  };
  await f.say('configure duration');
  expect(f.idOf('manual.duration')).toBe(id);
  expect(f.minutes()).toBe(DEFAULT_MINUTES);
  expect(f.sent).toEqual([refusal]);
});

test('a format-only edit between suspension and resume refuses the resume', async () => {
  const f = fixture(ASK_FLOW, { unmanaged: true });
  await f.say('configure duration');
  f.intents.update(f.idOf('manual.duration')!, { format: 'settings' });
  expect(await f.say('Yes')).toEqual({ handled: true });
  expect(f.minutes()).toBe(DEFAULT_MINUTES);
  expect(f.sent.at(-1)).toBe(refusal);
});

test('a resumed run keeps the response format it was matched with', async () => {
  const confirm = ASK_STEPS[0]!;
  const f = fixture({ version: 2, steps: [confirm, readSettings] }, { unmanaged: true, format: 'settings' });
  await f.say('configure duration');
  await f.say('Yes');
  const unchanged = f.sent.at(-1);
  _resetToolThrottleForTest();
  await f.say('configure duration');
  // Edited while the final call runs: that call was checked first, so the run finishes as matched.
  f.duringNextTool(() => f.intents.update(f.idOf('manual.duration')!, { format: 'text' }));
  await f.say('Yes');
  expect(f.sent.at(-1)).toBe(unchanged);
});

test('a first-pass write before the change is reported, the write after it refused', async () => {
  const write45 = {
    ...writeSettings,
    input: { ...writeSettings.input, updates: { default_event_duration_minutes: 45 } },
  };
  const f = fixture({ version: 2, steps: [write45, readSettings, writeSettings, { respond: 'Updated.' }] });
  f.approveDuringNextTool(f.changed);
  expect(await f.say('configure duration')).toEqual({ handled: true });
  expect(f.minutes()).toBe(45);
  expect(f.sent).toEqual([t('en').intentWorkflow.appliedIncomplete]);
});

test('a suspended session stored without a rule identity is refused on resume', async () => {
  const f = fixture(ASK_FLOW);
  f.sessions.set(USER, USER, {
    intentId: f.idOf('manual.duration')!,
    stepIndex: 1,
    stepResults: {},
    workflow: WorkflowSchema.parse(ASK_FLOW),
    captures: {},
    createdAt: Date.now(),
  });
  expect(await f.say('Yes')).toEqual({ handled: true });
  expect(f.minutes()).toBe(DEFAULT_MINUTES);
  expect(f.sessions.get(USER, USER)).toBeNull();
  expect(f.sent).toEqual([refusal]);
});

test('a resume is refused while the managed registry fails its integrity check', async () => {
  const f = fixture(ASK_FLOW);
  await f.say('configure duration');
  f.db.run("UPDATE intents SET phrases='[\"tampered\"]' WHERE canonical_name='basis.time.now'");
  expect(await f.say('Yes')).toEqual({ handled: true });
  expect(f.minutes()).toBe(DEFAULT_MINUTES);
  expect(f.sent.at(-1)).toBe(refusal);
});

test('an approval of an unrelated rule does not stop a suspended run', async () => {
  const f = fixture(ASK_FLOW);
  await f.say('configure duration');
  const ping = rule('manual.ping', { version: 2, steps: [{ call: 'get_bot_info', input: {} }] }, ['ping the bot']);
  f.approve(create(ping));
  expect(await f.say('Yes')).toEqual({ handled: true });
  expect(f.minutes()).toBe(30);
  expect(f.sent.at(-1)).toBe('Updated.');
});

test('a run suspended twice keeps its rule identity across both resumes', async () => {
  const again = { call: 'ask_user', input: { question: 'Sure?', options: ['Yes', 'No'] }, as: 'sure' };
  const f = fixture({ version: 2, steps: [readSettings, again, ...ASK_STEPS] });
  await f.say('configure duration');
  expect(await f.say('Yes')).toEqual({ handled: true });
  expect(f.sent.at(-1)).toBe('Apply?');
  expect(await f.say('Yes')).toEqual({ handled: true });
  expect(f.minutes()).toBe(30);
});

test('a run matched after an approval runs the approved revision', async () => {
  const f = fixture(ASK_FLOW);
  f.approve(f.changed);
  // Approval does not reload a running matcher (#577 item 1); the admin surface will.
  f.matcher.load(f.intents.getApproved());
  expect(await f.say('set duration')).toEqual({ handled: true });
  expect(f.sessions.get(USER, USER)?.intentId).toBe(f.idOf('manual.duration'));
  expect(await f.say('Yes')).toEqual({ handled: true });
  expect(f.minutes()).toBe(30);
});
