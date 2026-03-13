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
  {
    name: '005_create_chat_history',
    up: (db) => {
      db.exec(`
        CREATE TABLE chat_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
        );
        CREATE INDEX idx_chat_history_user ON chat_history(user_id, created_at);
      `);
    },
  },
  {
    name: '006_create_notification_tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS notification_preferences (
          user_id                    INTEGER PRIMARY KEY,
          morning_agenda_enabled     INTEGER NOT NULL DEFAULT 1,
          morning_agenda_time        TEXT NOT NULL DEFAULT '08:00',
          morning_agenda_utc         TEXT,
          morning_agenda_format      TEXT NOT NULL DEFAULT 'text',
          default_reminder_intervals TEXT NOT NULL DEFAULT '[15]',
          evening_review_enabled     INTEGER NOT NULL DEFAULT 0,
          evening_review_time        TEXT NOT NULL DEFAULT '21:00',
          evening_review_utc         TEXT,
          evening_review_format      TEXT NOT NULL DEFAULT 'text',
          quiet_hours_enabled        INTEGER NOT NULL DEFAULT 0,
          quiet_hours_start          TEXT,
          quiet_hours_end            TEXT,
          updated_at                 TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS event_reminders (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id          INTEGER NOT NULL,
          user_id           INTEGER NOT NULL,
          remind_at_utc     TEXT NOT NULL,
          interval_minutes  INTEGER NOT NULL,
          interval_label    TEXT NOT NULL,
          sent              INTEGER NOT NULL DEFAULT 0,
          created_at        TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_event_reminders_due
          ON event_reminders(remind_at_utc, sent) WHERE sent = 0;
        CREATE INDEX IF NOT EXISTS idx_event_reminders_event
          ON event_reminders(event_id);

        CREATE TABLE IF NOT EXISTS notification_log (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id         INTEGER NOT NULL,
          type            TEXT NOT NULL,
          reference_key   TEXT NOT NULL,
          status          TEXT NOT NULL DEFAULT 'queued',
          channel         TEXT NOT NULL DEFAULT 'telegram_text',
          payload         TEXT,
          error           TEXT,
          attempts        INTEGER NOT NULL DEFAULT 0,
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          sent_at         TEXT,
          FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_log_dedup
          ON notification_log(reference_key);
        CREATE INDEX IF NOT EXISTS idx_notification_log_status
          ON notification_log(status, created_at);
      `);
    },
  },
  {
    name: '007_google_sync',
    up: (db) => {
      db.exec(`
        CREATE TABLE google_sync_state (
          user_id INTEGER PRIMARY KEY,
          access_token TEXT,
          expires_at TEXT,
          scopes TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'revoked', 'expired')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
        );

        CREATE TABLE google_calendars (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          google_calendar_id TEXT NOT NULL,
          calendar_name TEXT NOT NULL,
          color TEXT,
          is_primary INTEGER NOT NULL DEFAULT 0,
          sync_enabled INTEGER NOT NULL DEFAULT 1,
          access_role TEXT NOT NULL DEFAULT 'owner'
            CHECK (access_role IN ('owner', 'writer', 'reader', 'freeBusyReader')),
          sync_token TEXT,
          last_synced_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
          UNIQUE (user_id, google_calendar_id)
        );
        CREATE INDEX idx_google_calendars_user_id ON google_calendars(user_id);

        CREATE TABLE google_watch_channels (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          google_calendar_row_id INTEGER NOT NULL,
          channel_id TEXT NOT NULL UNIQUE,
          resource_id TEXT NOT NULL,
          expiration TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (google_calendar_row_id) REFERENCES google_calendars(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_watch_channels_expiration ON google_watch_channels(expiration);

        CREATE TABLE sync_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          event_id INTEGER,
          google_event_id TEXT,
          direction TEXT NOT NULL CHECK (direction IN ('push', 'pull')),
          action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'conflict_resolve')),
          details TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
        );
        CREATE INDEX idx_sync_log_user_created ON sync_log(user_id, created_at);
      `);

      db.exec('ALTER TABLE events ADD COLUMN google_etag TEXT');
      db.exec(`ALTER TABLE events ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'local_only'
        CHECK (sync_status IN ('local_only', 'synced', 'pending_push', 'pending_pull', 'conflict', 'push_failed'))`);
      db.exec('ALTER TABLE events ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0');

      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_events_google_cal_event
        ON events(google_calendar_id, google_event_id)
        WHERE google_event_id IS NOT NULL`);
    },
  },
];
