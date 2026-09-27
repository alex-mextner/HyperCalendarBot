import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { TZDate } from '@date-fns/tz';
import type OpenAI from 'openai';
import { t } from '../../../src/config/constants.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EditProposalRepository } from '../../../src/database/repositories/edit-proposal.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { SharedEventRepository } from '../../../src/database/repositories/shared-event.repository.ts';
import { SharingSettingsRepository } from '../../../src/database/repositories/sharing-settings.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { aiFailureNotices, CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import type { StreamCallbacks, StreamRoundOptions, StreamRoundResult } from '../../../src/services/ai/streaming.ts';
import { buildSystemPrompt } from '../../../src/services/ai/system-prompt.ts';
import { _resetToolThrottleForTest, executeTool } from '../../../src/services/ai/tool-executor.ts';
import { toolSchemas } from '../../../src/services/ai/tool-schemas.ts';
import type { AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';
import { InvitationService } from '../../../src/services/sharing/invitation-service.ts';
import { PrivacyService } from '../../../src/services/sharing/privacy-service.ts';
import { SharingService } from '../../../src/services/sharing/sharing-service.ts';
import { jsonCodec } from '../../../src/utils/json-codec.ts';

// Incident 2026-09-27: "встреча в 15 с Леной, Алексом, Аней и мной" was created with the four
// names (the inviter included) as its description, and the inviter, asking to be added, was told
// he "already participates because his name is in the description". These scenarios run the real
// agent loop, real handlers and a real database under a scripted model. The create call is not
// scripted: it is the example the rendered system prompt demonstrates, so the prompt's own advice
// is what gets executed.

const OWNER = 202;
const LENA = 789;
const DURATION_MINUTES = 45;

interface StoredEvent {
  id: number;
  start_at: string;
  end_at: string | null;
  description: string | null;
}

/** One scripted model turn: either a tool call or the final answer, chosen from what the model was given. */
type Turn = { tool: string; input: { [key: string]: unknown } } | { text: string };

function makeHarness(timezone: string): { ctx: AgentContext; db: Database; sender: TelegramSender } {
  _resetToolThrottleForTest();
  aiFailureNotices.reset();
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  const userRepo = new UserRepository(db);
  userRepo.create({ telegram_id: OWNER, first_name: 'Виталий', timezone, language: 'ru' });
  userRepo.update(OWNER, { default_event_duration_minutes: DURATION_MINUTES });
  userRepo.create({ telegram_id: LENA, first_name: 'Лена', timezone, language: 'ru' });
  const eventRepo = new EventRepository(db);
  const eventService = new EventService({ eventRepo });
  const invitationRepo = new InvitationRepository(db);
  const sharingSettingsRepo = new SharingSettingsRepository(db);
  const privacyService = new PrivacyService(sharingSettingsRepo);
  const chatHistory = new ChatHistoryRepository(db);
  const user = userRepo.findByTelegramId(OWNER);
  if (!user) throw new Error('owner fixture missing');
  const ctx: AgentContext = {
    user,
    chatId: OWNER,
    messageText: 'добавь встречу завтра в 15:00 с Леной и мной',
    isGroup: false,
    eventService,
    holidayService: new HolidayService(new HolidayRepository(db)),
    chatHistory,
    conversationLogger: new ConversationLogger(chatHistory),
    userRepo,
    eventReminderRepo: new EventReminderRepository(db),
    // Лена was resolved through the address book earlier in this conversation.
    verifiedRecipientIds: new Set([LENA]),
    sharing: {
      invitationRepo,
      sharingSettingsRepo,
      privacyService,
      invitationService: new InvitationService(invitationRepo, eventRepo, sharingSettingsRepo),
      sharedEventRepo: new SharedEventRepository(db),
      editProposalRepo: new EditProposalRepository(db),
      sharingService: new SharingService(
        (id, start, end) => eventService.getEventsInRange(id, start, end),
        privacyService,
      ),
    },
  };
  const sender: TelegramSender = {
    sendMessage: mock(() => Promise.resolve({ message_id: 42 })),
    editMessageText: mock(() => Promise.resolve()),
    sendInvitation: mock(() => Promise.resolve({ message_id: 55 })),
  };
  return { ctx, db, sender };
}

function systemPromptOf(opts: StreamRoundOptions): string {
  const first = opts.messages[0];
  return first?.role === 'system' && typeof first.content === 'string' ? first.content : '';
}

function toolMessages(opts: StreamRoundOptions): string[] {
  return opts.messages.flatMap((m) => (m.role === 'tool' && typeof m.content === 'string' ? [m.content] : []));
}

/**
 * A scripted model. Validator calls get REJECT, so an answer the pipeline chose to verify would be
 * replaced by the unverified notice; the answers below make no completeness claim and are never
 * verified. Grounding is shown by deriving each turn from what the model was given.
 */
function scriptedModel(turns: ((opts: StreamRoundOptions) => Turn)[]) {
  let round = 0;
  const impl = async (opts: StreamRoundOptions, callbacks: StreamCallbacks = {}): Promise<StreamRoundResult> => {
    if (systemPromptOf(opts).includes('strict QA validator')) {
      const reject: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: 'REJECT: not grounded' };
      return {
        text: 'REJECT: not grounded',
        toolCalls: [],
        finishReason: 'stop',
        assistantMessage: reject,
        providerUsed: 'validator',
      };
    }
    const next = turns[round++];
    if (!next) throw new Error(`scripted model ran out of turns at round ${round}`);
    const turn = next(opts);
    if ('text' in turn) {
      callbacks.onTextDelta?.(turn.text);
      return {
        text: turn.text,
        toolCalls: [],
        finishReason: 'stop',
        assistantMessage: { role: 'assistant', content: turn.text },
        providerUsed: 'scripted',
      };
    }
    callbacks.onToolCallStart?.(turn.tool);
    const id = `call-${round}`;
    const args = JSON.stringify(turn.input);
    return {
      text: '',
      toolCalls: [{ id, name: turn.tool, arguments: args }],
      finishReason: 'tool_calls',
      assistantMessage: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id, type: 'function', function: { name: turn.tool, arguments: args } }],
      },
      providerUsed: 'scripted',
    };
  };
  return { impl };
}

/** The create_event call the rendered prompt demonstrates, decoded by the tool's real input schema. */
function promptedCreateCall(opts: StreamRoundOptions): { [key: string]: unknown } {
  const raw = systemPromptOf(opts).match(/create_event\((\{[^\n]*?\})\)/)?.[1];
  if (!raw) throw new Error('the rendered system prompt has no create_event example');
  const parsed = jsonCodec(toolSchemas.create_event).safeParse(raw);
  if (!parsed.success || !parsed.data || typeof parsed.data !== 'object') {
    throw new Error(`the prompt's create_event example does not satisfy the schema: ${raw}`);
  }
  return { ...parsed.data };
}

function storedEvents(db: Database): StoredEvent[] {
  return db
    .query<StoredEvent, [number]>('SELECT id, start_at, end_at, description FROM events WHERE user_id = ?')
    .all(OWNER);
}

afterEach(() => {
  setSystemTime();
});

describe('creating an event with people: the prompt example, executed', () => {
  const cases: { name: string; timezone: string; now?: string; mode: 'full' | 'lazy' }[] = [
    { name: 'real time, Europe/Belgrade, full schemas', timezone: 'Europe/Belgrade', mode: 'full' },
    { name: 'real time, UTC, lazy schemas', timezone: 'UTC', mode: 'lazy' },
    { name: 'real time, Asia/Kolkata, lazy schemas', timezone: 'Asia/Kolkata', mode: 'lazy' },
    // "Tomorrow" is after the spring-forward / fall-back: today's offset is not tomorrow's.
    { name: 'DST eve, Europe/Belgrade', timezone: 'Europe/Belgrade', now: '2026-03-28T12:00:00Z', mode: 'full' },
    { name: 'DST eve, America/New_York', timezone: 'America/New_York', now: '2026-03-07T17:00:00Z', mode: 'lazy' },
    { name: 'fall-back eve, Europe/Belgrade', timezone: 'Europe/Belgrade', now: '2026-10-24T12:00:00Z', mode: 'full' },
    // "Tomorrow" is in the next month / the next year.
    { name: 'month end, America/New_York', timezone: 'America/New_York', now: '2026-01-31T20:00:00Z', mode: 'full' },
    { name: 'year end, Pacific/Kiritimati', timezone: 'Pacific/Kiritimati', now: '2026-12-31T09:00:00Z', mode: 'lazy' },
  ];

  for (const { name, timezone, now, mode } of cases) {
    test(`${name}: tomorrow 15:00 with the default duration, no description, the organizer not invited`, async () => {
      // Real-time cases are pinned to the moment the test starts so local midnight cannot fall
      // between rendering the prompt and computing the expected date.
      setSystemTime(now ? new Date(now) : new Date());
      const { ctx, db, sender } = makeHarness(timezone);
      const discover: ((opts: StreamRoundOptions) => Turn)[] =
        mode === 'lazy'
          ? [() => ({ tool: 'discover_tools', input: { tools: ['create_event', 'send_invitation'] } })]
          : [];
      const model = scriptedModel([
        ...discover,
        (opts) => ({ tool: 'create_event', input: promptedCreateCall(opts) }),
        () => ({ tool: 'send_invitation', input: { event_id: storedEvents(db)[0]?.id, invitee_id: LENA } }),
        () => ({ text: 'Встреча создана, приглашение Лене создано и отправляется.' }),
      ]);

      const result = await new CalendarBotAgent({ toolSchemaMode: mode }, sender, { streamImpl: model.impl }).run(ctx);

      expect(result.toolResults.map((r) => r.success)).toEqual([true, true]);
      const events = storedEvents(db);
      expect(events).toHaveLength(1);
      const [event] = events;
      if (!event) throw new Error('unreachable');
      expect(event.description).toBeNull();

      // "завтра в 15:00" in the user's zone, converted the way the prompt's time rules demand.
      const today = new TZDate(Date.now(), timezone);
      const tomorrow = new TZDate(today.getFullYear(), today.getMonth(), today.getDate() + 1, timezone);
      const localDate = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
      const utc = await executeTool(ctx, 'calculate', { expression: `${localDate} 15:00 ${timezone} to UTC` });
      expect(Date.parse(event.start_at)).toBe(Date.parse(utc.output ?? ''));
      expect(Date.parse(event.end_at ?? '') - Date.parse(event.start_at)).toBe(DURATION_MINUTES * 60_000);

      // The whole flow leaves exactly the one invitation; creating the event adds none for the organizer.
      const invitees = db
        .query<{ invitee_id: number }, [number]>('SELECT invitee_id FROM invitations WHERE event_id = ?')
        .all(event.id)
        .map((row) => row.invitee_id);
      expect(invitees).toEqual([LENA]);
    });
  }

  test('the rendered prompt keeps attendees and the organizer out of the description', () => {
    const prompt = buildSystemPrompt(makeHarness('Europe/Belgrade').ctx);
    expect(prompt).toContain('never list them in description');
    expect(prompt).toContain('The user ("мной"/"me") is the organizer: never invite, pick or list them');
    expect(prompt).toContain('attendance only from get_invitation_status');
  });
});

// Rendered with an id that cannot occur in the template text, so what precedes it is the line prefix.
const SENTINEL_ID = 918_273_645;
const INVITEE_PREFIX = t('ru').aiTools.sharing.rsvpInviteeLine(SENTINEL_ID, '', '').split(String(SENTINEL_ID))[0] ?? '';

/** Invitee ids in a get_invitation_status result. */
function invitedIds(status: string): number[] {
  return status.split('\n').flatMap((line) => {
    const at = line.indexOf(INVITEE_PREFIX);
    const id = at < 0 ? Number.NaN : Number.parseInt(line.slice(at + INVITEE_PREFIX.length), 10);
    return Number.isNaN(id) ? [] : [id];
  });
}

describe('who takes part: answered from invitations, not from the description', () => {
  test('"добавь меня тоже" over a description naming the organizer: the answer rests on invitations', async () => {
    const { ctx, sender } = makeHarness('Europe/Belgrade');
    const event = ctx.eventService.createEvent({
      user_id: OWNER,
      title: 'Встреча',
      start_at: new Date(Date.now() + 26 * 3_600_000).toISOString(),
      timezone: 'Europe/Belgrade',
      description: 'Лена, Алекс, Виталий',
    });
    const invited = ctx.sharing?.invitationService.sendInvitation(event.id, OWNER, LENA);
    expect(invited?.success).toBe(true);
    ctx.messageText = 'добавь меня тоже на встречу';
    let statusSeen = '';
    const model = scriptedModel([
      () => ({ tool: 'get_invitation_status', input: { event_id: event.id } }),
      // A model following the attendance rule: the answer is built only from the invitation data it got.
      (opts) => {
        statusSeen = toolMessages(opts).join('\n');
        const ids = invitedIds(statusSeen);
        if (ids.includes(OWNER)) return { text: 'Ты уже участвуешь в этой встрече.' };
        const names = ids.map((id) => ctx.userRepo.findByTelegramId(id)?.first_name ?? String(id));
        return { text: `Ты организатор этой встречи — приглашать тебя не нужно. Приглашены: ${names.join(', ')}.` };
      },
    ]);

    const result = await new CalendarBotAgent({}, sender, { streamImpl: model.impl }).run(ctx);

    expect(result.toolResults.map((r) => r.success)).toEqual([true]);
    // The description names three people; the participation data names one pending invitee.
    expect(invitedIds(statusSeen)).toEqual([LENA]);
    expect(statusSeen).toContain(t('ru').aiTools.sharing.rsvpAttending(0));
    expect(statusSeen).not.toContain('Алекс');
    expect(result.responseText).toContain('Ты организатор этой встречи — приглашать тебя не нужно. Приглашены: Лена.');
  });
});
