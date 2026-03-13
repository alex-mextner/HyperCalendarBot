// src/database/types.ts

// ── Row types (match SQLite columns exactly) ──

export interface User {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  language: 'en' | 'ru';
  timezone: string;
  country_code: string | null;
  google_refresh_token_enc: string | null;
  google_calendar_id: string | null;
  onboarding_completed: number; // 0 | 1
  created_at: string;
  updated_at: string;
}

export interface CalendarEvent {
  id: number;
  user_id: number;
  title: string;
  description: string | null;
  category: string | null;
  start_at: string;
  end_at: string | null;
  all_day: number; // 0 | 1
  timezone: string;
  location: string | null;
  recurrence_rule: string | null;
  recurrence_end_at: string | null;
  parent_event_id: number | null;
  original_start_at: string | null;
  is_cancelled: number; // 0 | 1
  reminder_overrides: string | null; // JSON array "[5, 30]"
  google_event_id: string | null;
  google_calendar_id: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Reminder {
  id: number;
  event_id: number;
  minutes_before: number;
  created_at: string;
}

// ── Input types ──

export interface CreateUserData {
  telegram_id: number;
  username?: string;
  first_name?: string;
  language?: 'en' | 'ru';
  timezone?: string;
  country_code?: string;
}

export interface UpdateUserData {
  username?: string;
  first_name?: string;
  language?: 'en' | 'ru';
  timezone?: string;
  country_code?: string;
  onboarding_completed?: number;
}

export interface CreateEventData {
  user_id: number;
  title: string;
  description?: string;
  category?: string;
  start_at: string; // ISO 8601 UTC
  end_at?: string;
  all_day?: boolean;
  timezone: string;
  location?: string;
  recurrence_rule?: string;
  recurrence_end_at?: string;
  reminder_minutes?: number[];
}

export interface UpdateEventData {
  title?: string;
  description?: string | null;
  category?: string | null;
  start_at?: string;
  end_at?: string | null;
  all_day?: boolean;
  timezone?: string;
  location?: string | null;
  recurrence_rule?: string | null;
  recurrence_end_at?: string | null;
  reminder_overrides?: string | null;
}

export interface ChatHistoryMessage {
  id: number;
  user_id: number;
  role: 'user' | 'assistant' | 'tool';
  content: string; // plain text for user, JSON content blocks for assistant/tool
  created_at: string;
}

// ── Computed types ──

export interface EventOccurrence {
  event: CalendarEvent;
  occurrence_start: string;
  occurrence_end: string | null;
  is_exception: boolean;
}
