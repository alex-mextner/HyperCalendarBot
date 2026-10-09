// Intents run for messages without a Telegram context (scheduled messages, triggers, retries)
// stop before a write once their rule changed, like the message pipeline does. Real migrated
// SQLite, ledger, executor and tool dispatcher; only the Telegram transport is faked.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { t } from '../../../src/config/constants.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { IntentRepository } from '../../../src/database/repositories/intent.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { WorkflowSessionRepository } from '../../../src/database/repositories/workflow-session.repository.ts';
import { _resetToolThrottleForTest, executeTool } from '../../../src/services/ai/tool-executor.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';
import { IntentExecutor } from '../../../src/services/intent/intent-executor.ts';
import { IntentMatcher } from '../../../src/services/intent/intent-matcher.ts';
import type { RevisionBodyInput } from '../../../src/services/intent/revision-body.ts';
import { adminFromTelegram, IntentRevisionService } from '../../../src/services/intent/revision-service.ts';
import type { JsonValue } from '../../../src/services/intent/rule-fingerprint.ts';
import { seedIntents } from '../../../src/services/intent/seed-catalog.ts';
import { runSyntheticIntent } from '../../../src/services/intent/synthetic-intent-run.ts';
import { installSeed, openTempRegistry, type TempRegistry } from '../../helpers/intent-registry.ts';

const USER = 890030001;
const setMinutes = (minutes: number) => ({
  call: 'manage_settings',
  input: { action: 'update', category: 'general', updates: { default_event_duration_minutes: minutes } },
});
const readSettings = { call: 'manage_settings', input: { action: 'get', category: 'general' }, as: 'original' };
const ruleWith = (steps: JsonValue[], phrases: string[]) => ({
  canonical_name: 'manual.scheduled_duration',
  pattern: `^(?:${phrases.join('|')})$`,
  workflow: { version: 2, steps } satisfies JsonValue,
  phrases,
  trigger_words: ['duration'],
  source_message: phrases[0]!,
});

let registry: TempRegistry;
beforeEach(() => {
  registry = openTempRegistry();
  _resetToolThrottleForTest();
});
afterEach(() => registry.close());

function fixture(steps: JsonValue[]) {
  const db = registry.db;
  installSeed(db, [seedIntents.find((seed) => seed.canonical_name === 'basis.time.now')!]);
  const users = new UserRepository(db);
  const user = users.create({ telegram_id: USER, timezone: 'UTC', language: 'en' });
  const intents = new IntentRepository(db);
  const service = new IntentRevisionService(db, { sessions: new WorkflowSessionRepository(db) });
  const admin = adminFromTelegram(42, 42)!;
  const approve = (body: RevisionBodyInput) => {
    const proposed = service.propose(body, { kind: 'manual', principal: admin });
    if (proposed.status !== 'created' || proposed.revision.status !== 'validated')
      throw new Error(`revision not validated: ${JSON.stringify(proposed)}`);
    const { id, bodyHash, baseRevisionId } = proposed.revision;
    const result = service.approve(admin, { id, bodyHash, baseRevisionId: baseRevisionId! });
    if (result.status !== 'active') throw new Error(`approval refused: ${result.code}`);
  };
  const initial = ruleWith(steps, ['scheduled duration']);
  approve({
    type: 'operations',
    summary: 'Add a scheduled settings shortcut',
    operations: [{ kind: 'create', sourceNames: [], reason: 'scheduled use', intents: [initial] }],
  });
  const changed: RevisionBodyInput = {
    type: 'operations',
    summary: 'Widen the scheduled settings shortcut',
    operations: [
      {
        kind: 'generalize',
        sourceNames: [initial.canonical_name],
        reason: 'another wording',
        intents: [ruleWith(steps, ['scheduled duration', 'planned duration'])],
      },
    ],
  };
  const matcher = new IntentMatcher();
  matcher.load(intents.getApproved());
  const sent: string[] = [];
  const history = new ChatHistoryRepository(db);
  const agentCtx: AgentContext = {
    user,
    chatId: USER,
    messageText: 'scheduled duration',
    isGroup: false,
    userRepo: users,
    eventService: new EventService({ eventRepo: new EventRepository(db) }),
    holidayService: new HolidayService(new HolidayRepository(db)),
    chatHistory: history,
    eventReminderRepo: new EventReminderRepository(db),
    conversationLogger: new ConversationLogger(history),
    sender: {
      sendMessage: async (_chatId: number, text: string) => {
        sent.push(text);
        return { message_id: 1 };
      },
      editMessageText: async () => {},
    },
  };
  let duringNextTool: (() => void) | null = null;
  const deps = {
    matcher,
    intentRepo: intents,
    executor: new IntentExecutor(),
    executeTool: (ctx: AgentContext, name: string, input: unknown) => {
      const hook = duringNextTool;
      duringNextTool = null;
      hook?.();
      return executeTool(ctx, name, input);
    },
  };
  return {
    db,
    sent,
    agentCtx,
    run: () => runSyntheticIntent(deps, agentCtx, 'scheduled duration'),
    runWithoutRepository: () => runSyntheticIntent({ ...deps, intentRepo: undefined }, agentCtx, 'scheduled duration'),
    minutes: () => users.findByTelegramId(USER)?.default_event_duration_minutes,
    approveDuringNextTool: () => {
      duringNextTool = () => approve(changed);
    },
  };
}

test('an unchanged rule runs and sends its response', async () => {
  const f = fixture([readSettings, setMinutes(30), { respond: 'Updated.' }]);
  expect(await f.run()).toEqual({ handled: true, response: 'Updated.' });
  expect(f.minutes()).toBe(30);
  expect(f.sent).toEqual(['Updated.']);
});

test('a rule changed before the write hands the message to the agent without writing', async () => {
  const f = fixture([readSettings, setMinutes(30), { respond: 'Updated.' }]);
  f.approveDuringNextTool();
  expect(await f.run()).toEqual({ handled: false });
  expect(f.minutes()).toBe(60);
  expect(f.sent).toEqual([]);
});

test('a rule changed after a write stops the next write and reports the earlier one', async () => {
  const f = fixture([setMinutes(45), readSettings, setMinutes(30), { respond: 'Updated.' }]);
  f.approveDuringNextTool();
  const applied = t('en').intentWorkflow.appliedIncomplete;
  expect(await f.run()).toEqual({ handled: true, response: applied });
  expect(f.minutes()).toBe(45);
  expect(f.sent).toEqual([applied]);
});

test('without an intent repository the message goes to the agent', async () => {
  const f = fixture([readSettings, setMinutes(30), { respond: 'Updated.' }]);
  expect(await f.runWithoutRepository()).toEqual({ handled: false });
  expect(f.minutes()).toBe(60);
});

test('a registry that fails its integrity check runs nothing', async () => {
  const f = fixture([readSettings, setMinutes(30), { respond: 'Updated.' }]);
  f.db.run("UPDATE intents SET phrases='[\"tampered\"]' WHERE canonical_name='basis.time.now'");
  expect(await f.run()).toEqual({ handled: false });
  expect(f.minutes()).toBe(60);
});

test('an event read is sent as the formatted agenda, not the tool text written for the agent', async () => {
  const day = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const f = fixture([{ call: 'get_events', input: { start_date: day, end_date: day, scope: '{{env.scope}}' } }]);
  f.agentCtx.eventService.createEvent({
    user_id: USER,
    title: 'English lesson',
    start_at: `${day}T10:30:00.000Z`,
    timezone: 'UTC',
  });
  const outcome = await f.run();
  expect(outcome).toEqual({ handled: true, response: `${day} 10:30  English lesson` });
  expect(f.sent).toEqual([`${day} 10:30  English lesson`]);
});

test('a run that fails before any write hands the message to the agent without sending its error', async () => {
  // A scheduled message cannot answer ask_user, so the executor refuses the workflow up front.
  const f = fixture([{ call: 'ask_user', input: { question: 'How long?' }, as: 'answer' }, setMinutes(30)]);
  expect(await f.run()).toEqual({ handled: false });
  expect(f.sent).toEqual([]);
  expect(f.minutes()).toBe(60);
});
