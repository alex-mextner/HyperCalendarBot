// Proposal and secretary DMs reach a person only through the Bot API; when that fails the initiator
// is told instead. A shared service account never sends them (#753), even if a sender still carries
// such a method.
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import { CalendarProposalRepository } from '../../src/database/repositories/calendar-proposal.repository.ts';
import { ChatHistoryRepository } from '../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../src/database/repositories/event-reminder.repository.ts';
import { GroupChatRepository } from '../../src/database/repositories/group-chat.repository.ts';
import { GroupMemberRepository } from '../../src/database/repositories/group-member.repository.ts';
import { HolidayRepository } from '../../src/database/repositories/holiday.repository.ts';
import { SecretaryRepository } from '../../src/database/repositories/secretary.repository.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import { handleProposeCalendarChange } from '../../src/services/ai/tool-handlers/proposals.ts';
import { handleManageSecretaries } from '../../src/services/ai/tool-handlers/secretary.ts';
import type { AgentContext, TelegramSender } from '../../src/services/ai/types.ts';
import { ConversationLogger } from '../../src/services/conversation-logger.ts';
import { EventService } from '../../src/services/event/event-service.ts';
import { GroupMemberService } from '../../src/services/group/member-service.ts';
import { HolidayService } from '../../src/services/holiday/holiday-service.ts';

const INITIATOR = 5000000010;
const PERSON = 5000000011;
const GROUP_CHAT = -1005000000012;

let db: Database;
let users: UserRepository;
let attempts: string[];

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  users = new UserRepository(db);
  users.create({ telegram_id: INITIATOR, timezone: 'UTC', language: 'en', username: 'initiator_x', first_name: 'Ini' });
  users.create({ telegram_id: PERSON, timezone: 'UTC', language: 'en', username: 'person_x', first_name: 'Per' });
  attempts = [];
});
afterEach(() => db.close());

/** Bot API refuses every DM to PERSON; the sender also carries a legacy service-account send. */
function refusingSender(): TelegramSender {
  return Object.assign(
    {
      sendMessage: async (chatId: number) => {
        if (chatId === PERSON) {
          attempts.push(`bot-api:${chatId}`);
          throw new Error("Forbidden: bot can't initiate conversation with a user");
        }
        attempts.push(`to-initiator:${chatId}`);
        return { message_id: 1 };
      },
      editMessageText: async () => {},
    },
    {
      sendAsUser: async (userId: number) => {
        attempts.push(`service-account:${userId}`);
        return true;
      },
    },
  );
}

function context(overrides: Partial<AgentContext>): AgentContext {
  const history = new ChatHistoryRepository(db);
  const groupMemberRepo = new GroupMemberRepository(db);
  return {
    user: users.findByTelegramId(INITIATOR)!,
    chatId: INITIATOR,
    messageText: '',
    isGroup: false,
    eventService: new EventService({ eventRepo: new EventRepository(db) }),
    holidayService: new HolidayService(new HolidayRepository(db)),
    chatHistory: history,
    conversationLogger: new ConversationLogger(history),
    userRepo: users,
    eventReminderRepo: new EventReminderRepository(db),
    secretary: {
      secretaryRepo: new SecretaryRepository(db),
      secretaryForLine: undefined,
      calendarProposalRepo: new CalendarProposalRepository(db),
    },
    group: {
      checkGroupMembership: async () => true,
      groupChatRepo: new GroupChatRepository(db),
      groupMemberRepo,
      groupMemberService: new GroupMemberService(groupMemberRepo, users, {
        enabled: false,
        reason: 'service_user_id_unset',
      }),
    },
    sender: refusingSender(),
    ...overrides,
  };
}

test('a calendar-change proposal DM falls back to the proposer, never to a service account', async () => {
  const ctx = context({ isGroup: true, chatId: GROUP_CHAT, groupTitle: 'Synthetic Team' });
  const result = await handleProposeCalendarChange(ctx, {
    target_telegram_id: PERSON,
    action: 'create',
    summary: 'add Retro',
    event: { title: 'Retro', start_at: '2099-03-20T13:00:00Z', end_at: '2099-03-20T14:00:00Z', timezone: 'UTC' },
  });
  expect(result.success).toBe(true);
  expect(attempts).toEqual([`bot-api:${PERSON}`, `to-initiator:${INITIATOR}`]);
});

test('a secretary invitation DM falls back to the owner, never to a service account', async () => {
  const result = await handleManageSecretaries(context({}), {
    action: 'invite',
    secretary_telegram_id: PERSON,
    permission: 'read',
  });
  expect(result.success).toBe(true);
  expect(attempts).toEqual([`bot-api:${PERSON}`, `to-initiator:${INITIATOR}`]);
});

test('a secretary revocation notice falls back to the owner, never to a service account', async () => {
  const record = new SecretaryRepository(db).upsert({ owner_id: INITIATOR, secretary_id: PERSON, permission: 'read' });
  const result = await handleManageSecretaries(context({}), { action: 'revoke', secretary_access_id: record.id });
  expect(result.success).toBe(true);
  expect(attempts).toEqual([`bot-api:${PERSON}`, `to-initiator:${INITIATOR}`]);
});
