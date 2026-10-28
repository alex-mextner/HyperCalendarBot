// Row and context builders for AI tool-handler tests that run without a database. Every row carries
// the full set of required columns with realistic values, so a test overrides only the columns it
// is about; the AgentContext builder fills the core services a handler under test must not reach with
// stubs that throw on use, so a path that does reach one fails loudly.
import type { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import type { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import type { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import type { CalendarSecretary, User } from '../../../src/database/types.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import type { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import type { EventService } from '../../../src/services/event/event-service.ts';
import type { HolidayService } from '../../../src/services/holiday/holiday-service.ts';
import { partialOf } from './partial-stubs.ts';

/** The `updated_at`/`created_at` value of every row built here. */
export const STORED_AT = '2026-01-01 00:00:00';

export function userRow(overrides: Partial<User> = {}): User {
  return {
    telegram_id: 1,
    username: null,
    first_name: null,
    language: 'en',
    timezone: 'UTC',
    country_code: null,
    google_refresh_token_enc: null,
    google_calendar_id: null,
    onboarding_completed: 1,
    timezone_updated_at: null,
    voice_response_enabled: null,
    default_event_duration_minutes: 60,
    city: null,
    connect_telegram_dismissed_at: null,
    created_at: STORED_AT,
    updated_at: STORED_AT,
    ...overrides,
  };
}

export function secretaryRow(overrides: Partial<CalendarSecretary> = {}): CalendarSecretary {
  return {
    id: 1,
    owner_id: 1,
    secretary_id: 2,
    permission: 'read',
    status: 'active',
    dm_message_id: null,
    created_at: STORED_AT,
    updated_at: STORED_AT,
    ...overrides,
  };
}

/** A private-chat AgentContext whose core services throw if the handler under test touches them. */
export function agentContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    user: userRow(),
    chatId: 1,
    messageText: '',
    isGroup: false,
    eventService: partialOf<EventService>('eventService'),
    holidayService: partialOf<HolidayService>('holidayService'),
    chatHistory: partialOf<ChatHistoryRepository>('chatHistory'),
    conversationLogger: partialOf<ConversationLogger>('conversationLogger'),
    userRepo: partialOf<UserRepository>('userRepo'),
    eventReminderRepo: partialOf<EventReminderRepository>('eventReminderRepo'),
    ...overrides,
  };
}
