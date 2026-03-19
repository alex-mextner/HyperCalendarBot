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
          default_reminder_intervals TEXT NOT NULL DEFAULT '[30, 0]',
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
  {
    name: '008_create_sharing_tables',
    up(db) {
      db.exec(`
        CREATE TABLE invitations (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id        INTEGER NOT NULL,
          inviter_id      INTEGER NOT NULL,
          invitee_id      INTEGER NOT NULL,
          status          TEXT NOT NULL DEFAULT 'pending',
          message_id      INTEGER,
          chat_id         INTEGER,
          deep_link_code  TEXT,
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
          responded_at    TEXT,
          UNIQUE(event_id, invitee_id, created_at),
          FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_invitations_invitee ON invitations(invitee_id, status);
        CREATE INDEX idx_invitations_event ON invitations(event_id);
        CREATE INDEX idx_invitations_status ON invitations(status)
          WHERE status IN ('pending', 'maybe');

        CREATE TABLE shared_events (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id        INTEGER NOT NULL,
          shared_by       INTEGER NOT NULL,
          shared_to_type  TEXT NOT NULL,
          shared_to_id    INTEGER NOT NULL,
          share_type      TEXT NOT NULL,
          message_id      INTEGER,
          deep_link_code  TEXT,
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_shared_events_event ON shared_events(event_id);
        CREATE INDEX idx_shared_events_target ON shared_events(shared_to_type, shared_to_id);

        CREATE TABLE sharing_settings (
          user_id              INTEGER PRIMARY KEY,
          default_visibility   TEXT NOT NULL DEFAULT 'full',
          inline_mode_enabled  INTEGER NOT NULL DEFAULT 1,
          allow_invitations    INTEGER NOT NULL DEFAULT 1,
          share_location       INTEGER NOT NULL DEFAULT 0,
          share_description    INTEGER NOT NULL DEFAULT 0,
          updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
        );

        CREATE TABLE event_visibility (
          event_id    INTEGER PRIMARY KEY,
          visibility  TEXT NOT NULL,
          updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
        );

        CREATE TABLE group_chats (
          chat_id     INTEGER PRIMARY KEY,
          title       TEXT,
          added_by    INTEGER NOT NULL,
          added_at    TEXT NOT NULL DEFAULT (datetime('now')),
          is_active   INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE group_shared_events (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id     INTEGER NOT NULL,
          event_id    INTEGER NOT NULL,
          shared_by   INTEGER NOT NULL,
          message_id  INTEGER,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(chat_id, event_id),
          FOREIGN KEY (chat_id) REFERENCES group_chats(chat_id),
          FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_group_shared_chat ON group_shared_events(chat_id);

        CREATE TABLE deep_links (
          code       TEXT PRIMARY KEY,
          type       TEXT NOT NULL,
          payload    TEXT NOT NULL,
          created_by INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT,
          used_count INTEGER NOT NULL DEFAULT 0
        );
      `);
    },
  },
  {
    name: '009_create_voice_call_tables',
    up(db) {
      db.exec(`
        CREATE TABLE user_call_settings (
          user_id              INTEGER PRIMARY KEY,
          enabled              INTEGER NOT NULL DEFAULT 0,
          quiet_hours_start    TEXT,
          quiet_hours_end      TEXT,
          max_daily_calls      INTEGER NOT NULL DEFAULT 5,
          language             TEXT NOT NULL DEFAULT 'en',
          important_only       INTEGER NOT NULL DEFAULT 0,
          updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
        );

        CREATE TABLE call_log (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id       INTEGER NOT NULL,
          event_id      INTEGER,
          status        TEXT NOT NULL DEFAULT 'queued',
          duration_sec  INTEGER,
          tts_text      TEXT,
          error         TEXT,
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at  TEXT,
          FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
        );
        CREATE INDEX idx_call_log_user ON call_log(user_id, created_at);
        CREATE INDEX idx_call_log_status ON call_log(status) WHERE status IN ('queued', 'ringing');
      `);
    },
  },
  {
    name: '010_create_contacts',
    up: (db) => {
      db.exec(`
        CREATE TABLE contacts (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id    INTEGER NOT NULL,
          name       TEXT NOT NULL,
          username   TEXT,
          telegram_id INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX idx_contacts_user_name ON contacts(user_id, LOWER(name));
        CREATE INDEX idx_contacts_user ON contacts(user_id);
      `);
    },
  },
  {
    name: '011_contacts_preferred_name',
    up: (db) => {
      db.exec(`ALTER TABLE contacts ADD COLUMN preferred_name TEXT`);
    },
  },
  {
    name: '012_invitation_invitee_username',
    up: (db) => {
      db.exec(`ALTER TABLE invitations ADD COLUMN invitee_username TEXT`);
    },
  },
  {
    name: '013_timezone_updated_at',
    up: (db) => {
      db.exec(`ALTER TABLE users ADD COLUMN timezone_updated_at TEXT`);
    },
  },
  {
    name: '014_event_participants',
    up: (db) => {
      db.exec(`
        CREATE TABLE event_participants (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id   INTEGER NOT NULL,
          user_id    INTEGER NOT NULL,
          status     TEXT NOT NULL DEFAULT 'pending',
          role       TEXT NOT NULL DEFAULT 'attendee',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(event_id, user_id),
          FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_participants_user_status ON event_participants(user_id, status);
        CREATE INDEX idx_participants_event ON event_participants(event_id);
      `);
    },
  },
  {
    name: '015_edit_proposals',
    up: (db) => {
      db.exec(`
        CREATE TABLE edit_proposals (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id    INTEGER NOT NULL,
          proposer_id INTEGER NOT NULL,
          changes     TEXT NOT NULL,
          reason      TEXT,
          status      TEXT NOT NULL DEFAULT 'pending',
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_edit_proposals_event ON edit_proposals(event_id);
        CREATE INDEX idx_edit_proposals_status ON edit_proposals(status) WHERE status = 'pending';
      `);
    },
  },
  {
    name: '016_voice_response_enabled',
    up: (db) => {
      db.exec(`
        ALTER TABLE users ADD COLUMN voice_response_enabled INTEGER DEFAULT NULL
      `);
    },
  },
  {
    name: '017_intents',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS intents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          canonical_name TEXT UNIQUE NOT NULL,
          phrases TEXT NOT NULL DEFAULT '[]',
          trigger_words TEXT DEFAULT '[]',
          pattern TEXT,
          workflow TEXT NOT NULL,
          format TEXT NOT NULL DEFAULT 'text',
          status TEXT NOT NULL DEFAULT 'pending',
          source_message TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_intents_status ON intents(status);
      `);
    },
  },
  {
    name: '018_feedback',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS feedback_threads (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          type TEXT NOT NULL,
          subject TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          closed_at TEXT
        );
        CREATE INDEX idx_feedback_threads_user_status ON feedback_threads(user_id, status);

        CREATE TABLE IF NOT EXISTS feedback_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id INTEGER NOT NULL,
          sender TEXT NOT NULL,
          text TEXT NOT NULL,
          telegram_message_id INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (thread_id) REFERENCES feedback_threads(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_feedback_messages_thread ON feedback_messages(thread_id);
      `);
    },
  },
  {
    name: '019_pin_hint_shown',
    up: (db) => {
      db.exec(`
        ALTER TABLE group_chats ADD COLUMN pin_hint_shown INTEGER NOT NULL DEFAULT 0
      `);
    },
  },
  {
    name: '020_feedback_threads_fk',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS feedback_threads_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          type TEXT NOT NULL,
          subject TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          closed_at TEXT,
          FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
        );
        INSERT INTO feedback_threads_new SELECT * FROM feedback_threads;
        DROP TABLE feedback_threads;
        ALTER TABLE feedback_threads_new RENAME TO feedback_threads;
        CREATE INDEX idx_feedback_threads_user_status ON feedback_threads(user_id, status);
      `);
    },
  },
  {
    name: '021_group_calendar',
    up: (db) => {
      db.exec(`ALTER TABLE events ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'user'`);
      db.exec(`ALTER TABLE events ADD COLUMN group_id INTEGER`);
      db.exec(`ALTER TABLE events ADD COLUMN created_by INTEGER`);
      db.exec(`
        CREATE INDEX idx_events_group ON events (group_id, start_at)
          WHERE owner_type = 'group'
      `);
      db.exec(`ALTER TABLE chat_history ADD COLUMN chat_id INTEGER`);
      db.exec(`CREATE INDEX idx_chat_history_chat ON chat_history(chat_id, created_at)`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS group_members (
          chat_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (chat_id, user_id)
        )
      `);
    },
  },
  {
    name: '022_calendar_secretaries',
    up(db) {
      db.exec(`
        CREATE TABLE calendar_secretaries (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          owner_id       INTEGER NOT NULL,
          secretary_id   INTEGER NOT NULL,
          permission     TEXT NOT NULL DEFAULT 'read',
          status         TEXT NOT NULL DEFAULT 'pending',
          dm_message_id  INTEGER,
          created_at     TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(owner_id, secretary_id),
          FOREIGN KEY (owner_id)     REFERENCES users(telegram_id) ON DELETE CASCADE,
          FOREIGN KEY (secretary_id) REFERENCES users(telegram_id) ON DELETE CASCADE
        );
        CREATE INDEX idx_secretaries_owner     ON calendar_secretaries(owner_id);
        CREATE INDEX idx_secretaries_secretary ON calendar_secretaries(secretary_id, status);
      `);
    },
  },
  {
    name: '023_calendar_proposals',
    up(db) {
      db.exec(`
        CREATE TABLE calendar_proposals (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          group_chat_id      INTEGER NOT NULL,
          group_chat_title   TEXT,
          proposer_id        INTEGER NOT NULL,
          target_id          INTEGER NOT NULL,
          action             TEXT NOT NULL,
          payload            TEXT NOT NULL,
          summary            TEXT NOT NULL,
          status             TEXT NOT NULL DEFAULT 'pending',
          group_message_id   INTEGER,
          dm_message_id      INTEGER,
          expires_at         TEXT NOT NULL,
          created_at         TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (proposer_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
          FOREIGN KEY (target_id)   REFERENCES users(telegram_id) ON DELETE CASCADE
        );
        CREATE INDEX idx_proposals_target  ON calendar_proposals(target_id, status);
        CREATE INDEX idx_proposals_expires ON calendar_proposals(expires_at, status);
      `);
    },
  },
  {
    name: '024_default_reminder_intervals',
    up: (db) => {
      db.exec(
        `UPDATE notification_preferences SET default_reminder_intervals = '[30, 0]' WHERE default_reminder_intervals = '[15]'`,
      );
    },
  },
  {
    name: '025_invite_proposed_time',
    up: (db) => {
      db.exec('ALTER TABLE invitations ADD COLUMN proposed_time TEXT');
    },
  },
  {
    name: '026_group_chats_timezone_country',
    up: (db) => {
      db.exec('ALTER TABLE group_chats ADD COLUMN timezone TEXT');
      db.exec('ALTER TABLE group_chats ADD COLUMN country TEXT');
    },
  },
  {
    name: '027_default_event_duration',
    up: (db) => {
      db.exec(`ALTER TABLE users ADD COLUMN default_event_duration_minutes INTEGER NOT NULL DEFAULT 60`);
    },
  },
  {
    name: '028_group_chats_invite_link',
    up: (db) => {
      db.exec('ALTER TABLE group_chats ADD COLUMN invite_link TEXT');
    },
  },
  {
    name: '029_drop_notification_utc_columns',
    up: (db) => {
      db.exec('ALTER TABLE notification_preferences DROP COLUMN morning_agenda_utc');
      db.exec('ALTER TABLE notification_preferences DROP COLUMN evening_review_utc');
    },
  },
];
