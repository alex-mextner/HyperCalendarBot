// src/database/migrations.ts
import type { Migration } from './schema.ts';

export const migrations: Migration[] = [
  {
    name: '001_create_users',
    up: (db) => {
      db.exec(`
        CREATE TABLE users (
          telegram_id INTEGER PRIMARY KEY,
          username TEXT,
          first_name TEXT,
          language TEXT NOT NULL DEFAULT 'en',
          timezone TEXT NOT NULL DEFAULT 'UTC',
          country_code TEXT,
          google_refresh_token_enc TEXT,
          google_calendar_id TEXT,
          onboarding_completed INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
    },
  },
  {
    name: '002_create_events',
    up: (db) => {
      db.exec(`
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          category TEXT,
          start_at TEXT NOT NULL,
          end_at TEXT,
          all_day INTEGER NOT NULL DEFAULT 0,
          timezone TEXT NOT NULL,
          location TEXT,
          recurrence_rule TEXT,
          recurrence_end_at TEXT,
          parent_event_id INTEGER,
          original_start_at TEXT,
          is_cancelled INTEGER NOT NULL DEFAULT 0,
          reminder_overrides TEXT,
          google_event_id TEXT,
          google_calendar_id TEXT,
          last_synced_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
          FOREIGN KEY (parent_event_id) REFERENCES events(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_events_user_id ON events(user_id);
        CREATE INDEX idx_events_start_at ON events(start_at);
        CREATE INDEX idx_events_user_start ON events(user_id, start_at);
        CREATE INDEX idx_events_parent_id ON events(parent_event_id);
        CREATE INDEX idx_events_google_id ON events(google_event_id);
        CREATE INDEX idx_events_recurrence ON events(user_id, recurrence_rule)
          WHERE recurrence_rule IS NOT NULL;
      `);
    },
  },
  {
    name: '003_create_reminders',
    up: (db) => {
      db.exec(`
        CREATE TABLE reminders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id INTEGER NOT NULL,
          minutes_before INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_reminders_event_id ON reminders(event_id);
      `);
    },
  },
  {
    name: '004_create_holiday_tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE holiday_countries (
          code TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          region TEXT NOT NULL
        );

        CREATE TABLE holidays (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          country_code TEXT NOT NULL,
          date TEXT NOT NULL,
          name TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'public',
          year INTEGER NOT NULL,
          FOREIGN KEY (country_code) REFERENCES holiday_countries(code) ON DELETE CASCADE
        );
        CREATE INDEX idx_holidays_country_date ON holidays(country_code, date);
        CREATE INDEX idx_holidays_date ON holidays(date);
        CREATE UNIQUE INDEX idx_holidays_unique ON holidays(country_code, date, name);

        CREATE TABLE holiday_subscriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          country_code TEXT NOT NULL,
          is_primary INTEGER NOT NULL DEFAULT 0,
          notify INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
          FOREIGN KEY (country_code) REFERENCES holiday_countries(code) ON DELETE CASCADE,
          UNIQUE(user_id, country_code)
        );
        CREATE INDEX idx_holiday_subs_user ON holiday_subscriptions(user_id);

        CREATE TABLE holiday_overrides (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          date TEXT NOT NULL,
          is_day_off INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
          UNIQUE(user_id, date)
        );
        CREATE INDEX idx_holiday_overrides_user_date ON holiday_overrides(user_id, date);
      `);
    },
  },
];
