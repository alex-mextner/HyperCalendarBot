// Small typed fixtures for Telegram-facing handler tests: real GramIO value objects and full database rows,
// so a test states only what it cares about and every other required field has a realistic value.
import { type AnyBot, Chat, type MessageContext, User as TelegramUser } from 'gramio';
import type { User } from '../../src/database/types.ts';
import { stub } from './partial-stub.ts';

/** A persisted user row; override only the columns the case is about. */
export function makeUserRow(overrides: Partial<User> = {}): User {
  return {
    telegram_id: 100,
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
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

/** A Telegram chat of the given type. */
export function telegramChat(type: 'private' | 'group' | 'supergroup', id: number): Chat {
  return new Chat({ id, type });
}

/** A Telegram user as the Bot API reports it; `fields` override the defaults. */
export function telegramUser(fields: {
  id: number;
  first_name?: string;
  username?: string;
  language_code?: string;
}): TelegramUser {
  return new TelegramUser({ is_bot: false, first_name: 'Alex', ...fields });
}

/** The message a `send`/`reply` call resolves to; handlers under test only await it, any read of it throws. */
export function sentMessage(): MessageContext<AnyBot> {
  return stub<MessageContext<AnyBot>>({});
}
