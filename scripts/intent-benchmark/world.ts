// Builds the isolated environment one benchmark conversation runs in: a migrated in-memory SQLite database holding
// the rule set under test, the model-history world (events, contacts, users), and the real intent layer, executor
// and tool executor wired to it. Nothing here reaches the network or a real transport.
import { Database } from 'bun:sqlite';
import { setSystemTime } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createIntentMatcherLayer } from '../../src/bot/pipeline/intent-matcher-layer.ts';
import type { BotCommandContext } from '../../src/bot/types.ts';
import { migrations } from '../../src/database/migrations.ts';
import { ActionLogRepository } from '../../src/database/repositories/action-log.repository.ts';
import { ChatHistoryRepository } from '../../src/database/repositories/chat-history.repository.ts';
import { ContactRepository } from '../../src/database/repositories/contact.repository.ts';
import { EditProposalRepository } from '../../src/database/repositories/edit-proposal.repository.ts';
import { EventRepository } from '../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../src/database/repositories/holiday.repository.ts';
import { IntentRepository } from '../../src/database/repositories/intent.repository.ts';
import { InvitationRepository } from '../../src/database/repositories/invitation.repository.ts';
import { SharedEventRepository } from '../../src/database/repositories/shared-event.repository.ts';
import { SharingSettingsRepository } from '../../src/database/repositories/sharing-settings.repository.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import { WorkflowSessionRepository } from '../../src/database/repositories/workflow-session.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import type { User } from '../../src/database/types.ts';
import { _resetToolThrottleForTest, executeTool, isMutationTool } from '../../src/services/ai/tool-executor.ts';
import type { AgentContext, SharingCapability, TelegramSender } from '../../src/services/ai/types.ts';
import { ConversationLogger } from '../../src/services/conversation-logger.ts';
import { EventService } from '../../src/services/event/event-service.ts';
import { HolidayService } from '../../src/services/holiday/holiday-service.ts';
import type { ImageRenderer } from '../../src/services/image/render-service.ts';
import { IntentExecutor } from '../../src/services/intent/intent-executor.ts';
import type { IntentMatcher } from '../../src/services/intent/intent-matcher.ts';
import {
  applySeedReplacement,
  type CanonicalSeed,
  planSeedReplacement,
} from '../../src/services/intent/seed-replacement.ts';
import { InvitationService } from '../../src/services/sharing/invitation-service.ts';
import { PrivacyService } from '../../src/services/sharing/privacy-service.ts';
import { SharingService } from '../../src/services/sharing/sharing-service.ts';
import { type Anchor, localInstant } from './anchor.ts';
import { type Conversation, shiftDay } from './history.ts';

const WorldFile = z.object({
  events: z.array(
    z.object({
      id: z.number(),
      dayOffset: z.number(),
      at: z.string(),
      durationMin: z.number(),
      title: z.object({ ru: z.string(), en: z.string() }),
    }),
  ),
  contacts: z.array(z.object({ name: z.string(), username: z.string().nullable(), telegramId: z.number().nullable() })),
});
export type World = z.infer<typeof WorldFile>;
export type WorldEvent = World['events'][number];

const MODEL_HISTORY_DIR = new URL('../../docs/intents/model-history/', import.meta.url);
export const world: World = WorldFile.parse(JSON.parse(readFileSync(new URL('world.json', MODEL_HISTORY_DIR), 'utf8')));

/** A buffer with a real PNG signature and IHDR, which is all the transport checks of the render tools read. */
function pngStub(): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(buffer);
  buffer.writeUInt32BE(1080, 16);
  buffer.writeUInt32BE(800, 20);
  return buffer;
}

export const USER_ID = 7001;
export const GROUP_CHAT_ID = -100500;
export const PEOPLE: ReadonlyArray<{ id: number; username: string }> = [
  { id: 123456789, username: 'ivan_petrov' },
  { id: 987654321, username: 'anna_smith' },
  { id: 555000111, username: 'mark_t1' },
];

/** A migrated database with the rule set installed through the operator replacement path; built once per rule set. */
export interface RuleSetTemplate {
  image: Uint8Array;
  ruleCount: number;
}

export function buildTemplate(rules: readonly CanonicalSeed[]): RuleSetTemplate {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  runMigrations(db, migrations);
  const plan = planSeedReplacement(db, rules);
  const directory = mkdtempSync(join(tmpdir(), 'intent-benchmark-'));
  try {
    const backup = join(directory, 'before.db');
    db.query('VACUUM INTO ?').run(backup);
    applySeedReplacement(db, rules, plan, backup);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const image = db.serialize();
  db.close();
  return { image, ruleCount: rules.length };
}

export interface ToolRecord {
  name: string;
  input: unknown;
  ok: boolean;
  error: string | undefined;
  mutation: boolean;
  /** Result evidence the executor itself recorded. */
  mutationState: string | undefined;
}

export interface BotMessage {
  text: string;
  keyboard: string[];
}

export interface TurnObservation {
  said: string;
  /** What the intent layer reported; null when it threw. */
  handled: boolean | null;
  threw: string | undefined;
  messages: BotMessage[];
  tools: ToolRecord[];
  /** Intent rule the matcher chose, from the layer's action-log row. */
  ruleName: string | undefined;
  /** Wall-clock time the layer took, milliseconds. */
  elapsedMs: number;
}

export interface EventRow {
  id: number;
  title: string;
  start_at: string;
  end_at: string | null;
  location: string | null;
  description: string | null;
  is_deleted: number;
}

export interface Snapshot {
  events: EventRow[];
  reminders: Array<{ event_id: number; interval_minutes: number }>;
  overrides: Array<{ id: number; reminder_overrides: string | null }>;
  invitations: Array<{ event_id: number; invitee_username: string | null; invitee_id: number }>;
  visibility: Array<{ event_id: number; visibility: string }>;
}

export interface Fixture {
  say: (text: string) => Promise<TurnObservation>;
  snapshot: () => Snapshot;
  sessionOpen: () => boolean;
  /** Titles of the world events in the conversation's language, with their stored start instants. */
  worldEvents: () => ReadonlyArray<{ id: number; title: string; startMs: number; durationMin: number }>;
  close: () => void;
}

type FixtureConversation = Pick<Conversation, 'lang' | 'chat' | 'world' | 'tz' | 'seedEvents' | 'say' | 'real'>;
type WorldListEntry = { id: number; title: string; startMs: number; durationMin: number };

function registerPeople(users: UserRepository, conversation: FixtureConversation): void {
  for (const person of PEOPLE)
    users.create({ telegram_id: person.id, timezone: 'UTC', language: 'en', username: person.username });
  // Real history: a message that names a @username addresses a person the bot knows (the recorded exchange reached them).
  const known = new Set(PEOPLE.map((person) => person.username.toLowerCase()));
  for (const [index, [, handle]] of (conversation.real
    ? [...conversation.say.matchAll(/@([A-Za-z][A-Za-z0-9_]{4,31})/g)]
    : []
  ).entries()) {
    if (handle === undefined || known.has(handle.toLowerCase())) continue;
    known.add(handle.toLowerCase());
    users.create({ telegram_id: 900_000 + index, timezone: 'UTC', language: 'en', username: handle });
  }
}

/** Creates the world events, the conversation's own seed events and the contacts; returns the event list. */
function seedCalendar(
  events: EventService,
  contacts: ContactRepository,
  db: Database,
  conversation: FixtureConversation,
  anchor: Anchor,
): WorldListEntry[] {
  const group = conversation.chat === 'group';
  const scope = group ? { owner_type: 'group' as const, group_id: GROUP_CHAT_ID, created_by: USER_ID } : {};
  const startOf = (event: Pick<WorldEvent, 'dayOffset' | 'at'>): number =>
    localInstant(anchor.tz, shiftDay(anchor.date, event.dayOffset), event.at);
  const worldList: WorldListEntry[] = [];
  if (conversation.world === 'rich') {
    for (const event of world.events) {
      const created = events.createEvent({
        user_id: USER_ID,
        title: event.title[conversation.lang],
        start_at: new Date(startOf(event)).toISOString(),
        end_at: new Date(startOf(event) + event.durationMin * 60_000).toISOString(),
        timezone: anchor.tz,
        ...scope,
      });
      if (created.id !== event.id) throw new Error(`world event id drift: ${created.id} != ${event.id}`);
      worldList.push({
        id: event.id,
        title: event.title[conversation.lang],
        startMs: startOf(event),
        durationMin: event.durationMin,
      });
    }
  }
  for (const event of conversation.seedEvents ?? []) {
    const start = startOf(event);
    const created = events.createEvent({
      user_id: USER_ID,
      title: event.title,
      start_at: new Date(start).toISOString(),
      end_at: new Date(start + event.durationMin * 60_000).toISOString(),
      timezone: anchor.tz,
      ...scope,
    });
    // A message that names an event by number ("#643") is only answerable when that number exists.
    if (event.id !== undefined) db.query('UPDATE events SET id = ? WHERE id = ?').run(event.id, created.id);
    worldList.push({ id: event.id ?? created.id, title: event.title, startMs: start, durationMin: event.durationMin });
  }
  for (const contact of world.contacts)
    contacts.add(USER_ID, contact.name, contact.username ?? undefined, contact.telegramId ?? undefined);
  return worldList;
}

/** `lang`/`chat`/anchor decide the user row, the calendar scope and the frozen clock. */
export function buildFixture(
  template: RuleSetTemplate,
  matcher: IntentMatcher,
  conversation: Pick<Conversation, 'lang' | 'chat' | 'world' | 'tz' | 'seedEvents' | 'say' | 'real'>,
  anchor: Anchor,
): Fixture {
  setSystemTime(new Date(anchor.instantMs));
  _resetToolThrottleForTest();
  const db = Database.deserialize(template.image);
  db.exec('PRAGMA foreign_keys=ON');
  const users = new UserRepository(db);
  users.create({
    telegram_id: USER_ID,
    timezone: anchor.tz,
    language: conversation.lang,
    first_name: 'Ann',
    username: 'ann_test',
  });
  registerPeople(users, conversation);
  const eventRepo = new EventRepository(db);
  const events = new EventService({ eventRepo });
  const contacts = new ContactRepository(db);
  const history = new ChatHistoryRepository(db);
  const sessions = new WorkflowSessionRepository(db);
  const group = conversation.chat === 'group';
  const chat = group ? GROUP_CHAT_ID : USER_ID;

  const worldList = seedCalendar(events, contacts, db, conversation, anchor);

  const sharingSettingsRepo = new SharingSettingsRepository(db);
  const privacyService = new PrivacyService(sharingSettingsRepo);
  const invitationRepo = new InvitationRepository(db);
  const sharing: SharingCapability = {
    invitationService: new InvitationService(invitationRepo, eventRepo, sharingSettingsRepo),
    invitationRepo,
    sharingService: new SharingService(
      (userId, startUtc, endUtc) => events.getEventsInRange(userId, startUtc, endUtc),
      privacyService,
    ),
    sharingSettingsRepo,
    sharedEventRepo: new SharedEventRepository(db),
    privacyService,
    editProposalRepo: new EditProposalRepository(db),
  };
  const renderService: ImageRenderer = { renderDirect: async () => pngStub() };
  const sender: TelegramSender = {
    sendMessage: async () => ({ message_id: 3 }),
    editMessageText: async () => {},
    sendPhoto: async () => ({ message_id: 2 }),
    sendInvitation: async () => ({ message_id: 4 }),
  };
  const state = { current: '', calls: [] as ToolRecord[], messages: [] as BotMessage[] };
  const agentContext = (text: string): AgentContext => ({
    user: requireUser(users.findByTelegramId(USER_ID)),
    chatId: chat,
    messageText: text,
    isGroup: group,
    ...(group ? { groupChatId: GROUP_CHAT_ID, groupTitle: 'Team' } : {}),
    eventService: events,
    holidayService: new HolidayService(new HolidayRepository(db)),
    chatHistory: history,
    conversationLogger: new ConversationLogger(history),
    userRepo: users,
    contactRepo: contacts,
    eventReminderRepo: new EventReminderRepository(db),
    actionLogRepo: new ActionLogRepository(db),
    toolOrigin: 'intent_workflow',
    sharing: sharing,
    renderService,
    sender,
  });
  const callTool = async (name: string, input: unknown, origin?: { text: string; actorId: number; chatId: number }) => {
    const text = origin?.actorId === USER_ID && origin.chatId === chat ? origin.text : state.current;
    const result = await executeTool(agentContext(text), name, input);
    state.calls.push({
      name,
      input,
      ok: result.success,
      error: result.error,
      mutation: isMutationTool(name, input),
      mutationState: result.mutationState,
    });
    return result;
  };
  const layer = createIntentMatcherLayer(
    matcher,
    new IntentRepository(db),
    new IntentExecutor(),
    callTool,
    sessions,
    undefined,
    async () => ({}),
    () => {},
    new ActionLogRepository(db),
  );
  const send = async (text: string, options?: { reply_markup?: { keyboard?: Array<Array<{ text: string }>> } }) => {
    state.messages.push({
      text: unescapeHtml(String(text)),
      keyboard: (options?.reply_markup?.keyboard ?? []).flat().map((button) => button.text),
    });
    return { message_id: 1 };
  };
  return {
    async say(text) {
      state.current = text;
      state.calls = [];
      state.messages = [];
      const ctx = {
        dbUser: users.findByTelegramId(USER_ID),
        chatId: chat,
        id: 1,
        send,
      } as unknown as BotCommandContext;
      const started = performance.now();
      let handled: boolean | null = null;
      let threw: string | undefined;
      try {
        const result = await layer(
          ctx,
          text,
          group ? { groupContext: { isGroup: true, groupChatId: chat } } : undefined,
        );
        handled = result.handled;
      } catch (error) {
        threw = String(error instanceof Error ? error.message : error).slice(0, 300);
      }
      const elapsedMs = performance.now() - started;
      const row = db
        .query<{ action_name: string }, [number]>(
          `SELECT action_name FROM user_action_log WHERE action_type = 'intent_match' AND user_id = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(USER_ID);
      return {
        said: text,
        handled,
        threw,
        messages: [...state.messages],
        tools: [...state.calls],
        ruleName: handled ? row?.action_name : undefined,
        elapsedMs,
      };
    },
    snapshot: () => snapshotOf(db),
    sessionOpen: () => sessions.get(chat, USER_ID) !== null,
    worldEvents: () => worldList,
    close: () => db.close(),
  };
}

function requireUser(user: User | null): User {
  if (!user) throw new Error('benchmark user missing');
  return user;
}

const unescapeHtml = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

function snapshotOf(db: Database): Snapshot {
  const rows = <T>(sql: string): T[] => db.query<T, []>(sql).all();
  return {
    events: rows<EventRow>('SELECT id,title,start_at,end_at,location,description,is_deleted FROM events ORDER BY id'),
    reminders: rows('SELECT event_id, interval_minutes FROM event_reminders ORDER BY id'),
    overrides: rows('SELECT id, reminder_overrides FROM events ORDER BY id'),
    invitations: rows('SELECT event_id, invitee_username, invitee_id FROM invitations ORDER BY id'),
    visibility: rows('SELECT event_id, visibility FROM event_visibility ORDER BY event_id'),
  };
}
