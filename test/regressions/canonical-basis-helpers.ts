import type { Database } from 'bun:sqlite';
import { mock } from 'bun:test';
import { createIntentMatcherLayer } from '../../src/bot/pipeline/intent-matcher-layer.ts';
import type { GroupContext } from '../../src/bot/pipeline/types.ts';
import type { BotCommandContext } from '../../src/bot/types.ts';
import { ChatHistoryRepository } from '../../src/database/repositories/chat-history.repository.ts';
import { ContactRepository } from '../../src/database/repositories/contact.repository.ts';
import { EventRepository } from '../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../src/database/repositories/holiday.repository.ts';
import { IntentRepository } from '../../src/database/repositories/intent.repository.ts';
import { NotificationPreferencesRepository } from '../../src/database/repositories/notification-preferences.repository.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import { WorkflowSessionRepository } from '../../src/database/repositories/workflow-session.repository.ts';
import { executeTool, isMutationTool } from '../../src/services/ai/tool-executor.ts';
import type { AgentContext, ToolResult } from '../../src/services/ai/types.ts';
import { ConversationLogger } from '../../src/services/conversation-logger.ts';
import { EventService } from '../../src/services/event/event-service.ts';
import { HolidayService } from '../../src/services/holiday/holiday-service.ts';
import type { ImageRenderer } from '../../src/services/image/render-service.ts';
import { IntentExecutor } from '../../src/services/intent/intent-executor.ts';
import { IntentMatcher } from '../../src/services/intent/intent-matcher.ts';
import { seedIntents } from '../../src/services/intent/seed-catalog.ts';
import type { EventSummary } from '../../src/services/intent/variable-resolver.ts';

// Shared by the canonical-basis-*.test.ts files: seeded-rule helpers and the real-SQLite pipeline fixture.
// Each test file owns its own `db` and beforeEach/afterEach, and binds it through createFixture(db, ...).

// Saturday 2026-09-19 10:00 in Belgrade (UTC+2). The clocks go back on 2026-10-25 and forward on 2027-03-28.
export const NOW = new Date('2026-09-19T08:00:00Z');
export const USER = 7001;
export const OTHER = 7002;
export const GROUP_CHAT = -100500;

export type IntentRow = Parameters<IntentMatcher['load']>[0][number];

export function seedRows(db: Database): IntentRow[] {
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

export function matcherOver(rows: IntentRow[]): { matcher: IntentMatcher; idOf: Map<string, number> } {
  const matcher = new IntentMatcher();
  matcher.load(rows);
  return { matcher, idOf: new Map(rows.map((row) => [row.canonical_name, row.id])) };
}

export interface Fixture {
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

export interface FixtureOptions {
  tz?: string;
  language?: 'en' | 'ru';
  lastMentioned?: EventSummary;
  wrapTool?: (name: string, input: unknown, real: () => Promise<ToolResult>) => Promise<ToolResult>;
  /** Receives every picture job; without it the context has no renderer, as in a worker-less bot. */
  renderer?: ImageRenderer;
}

export function createFixture(db: Database, options: FixtureOptions = {}): Fixture {
  const users = new UserRepository(db);
  users.create({
    telegram_id: USER,
    timezone: options.tz ?? 'Europe/Belgrade',
    language: options.language ?? 'en',
    first_name: 'Ann',
  });
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
      // As in message.handler: the intent layer's own confirmation step guards its writes.
      toolOrigin: 'intent_workflow',
      notifications: {
        notificationPrefs: {
          ensureDefaults: (id: number) => prefsRepo.ensureDefaults(id),
          getPrefs: (id: number) => prefsRepo.get(id)!,
          update: (id: number, patch: never) => prefsRepo.update(id, patch),
        },
      },
      ...(options.renderer
        ? {
            renderService: options.renderer,
            sender: {
              sendPhoto: async () => ({ message_id: 2 }),
              sendMessage: async () => ({ message_id: 3 }),
            },
          }
        : {}),
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

export const toolNames = (f: Fixture) => f.call.mock.calls.map((entry) => entry[0]);
export const mutationCalls = (f: Fixture) => f.call.mock.calls.filter((entry) => isMutationTool(entry[0], entry[1]));
