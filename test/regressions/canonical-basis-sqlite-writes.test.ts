import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { createIntentMatcherLayer } from '../../src/bot/pipeline/intent-matcher-layer.ts';
import type { BotCommandContext } from '../../src/bot/types.ts';
import { migrations } from '../../src/database/migrations.ts';
import { IntentRepository } from '../../src/database/repositories/intent.repository.ts';
import { NotificationPreferencesRepository } from '../../src/database/repositories/notification-preferences.repository.ts';
import { WorkflowSessionRepository } from '../../src/database/repositories/workflow-session.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import { _resetToolThrottleForTest } from '../../src/services/ai/tool-executor.ts';
import type { ToolResult } from '../../src/services/ai/types.ts';
import { IntentExecutor } from '../../src/services/intent/intent-executor.ts';
import {
  createFixture,
  type Fixture,
  type FixtureOptions,
  type IntentRow,
  matcherOver,
  mutationCalls,
  NOW,
  OTHER,
  toolNames,
  USER,
} from './canonical-basis-helpers.ts';

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

const fixture = (options: FixtureOptions = {}): Fixture => createFixture(db, options);

describe('reminders against real SQLite', () => {
  test('a standalone reminder is one explicit confirmed entry, not a duplicate of an existing event', async () => {
    const f = fixture();
    f.addEvent('Existing unrelated event');
    await f.say('напомни через 10 минут позвонить маме');
    expect(f.eventRows()).toHaveLength(1);
    expect(f.lastText()).toContain('Позвонить маме');
    expect(f.lastText()).toContain('10:10');
    await f.no();
    expect(f.eventRows()).toHaveLength(1);
    await f.say('remind me in 10 minutes take a break');
    await f.yes();
    // Seed 6 capitalises the first letter of a title, as it does for "Standup".
    const added = f.eventRows().find((row) => row.title === 'Take a break');
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
