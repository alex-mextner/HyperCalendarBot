// src/database/index.ts
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dbLogger } from '../utils/logger.ts';
import { migrations } from './migrations.ts';
import { ChatHistoryRepository } from './repositories/chat-history.repository.ts';
import { EventRepository } from './repositories/event.repository.ts';
import { EventReminderRepository } from './repositories/event-reminder.repository.ts';
import { GoogleCalendarRepository } from './repositories/google-calendar.repository.ts';
import { GoogleSyncRepository } from './repositories/google-sync.repository.ts';
import { HolidayRepository } from './repositories/holiday.repository.ts';
import { NotificationLogRepository } from './repositories/notification-log.repository.ts';
import { NotificationPreferencesRepository } from './repositories/notification-preferences.repository.ts';
import { ReminderRepository } from './repositories/reminder.repository.ts';
import { UserRepository } from './repositories/user.repository.ts';
import { runMigrations } from './schema.ts';

export class DatabaseService {
  readonly db: Database;
  readonly users: UserRepository;
  readonly events: EventRepository;
  readonly reminders: ReminderRepository;
  readonly holidays: HolidayRepository;
  readonly chatHistory: ChatHistoryRepository;
  readonly notificationPreferences: NotificationPreferencesRepository;
  readonly eventReminders: EventReminderRepository;
  readonly notificationLog: NotificationLogRepository;
  readonly googleSync: GoogleSyncRepository;
  readonly googleCalendars: GoogleCalendarRepository;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');

    dbLogger.info({ path: dbPath }, 'Database opened');

    runMigrations(this.db, migrations);

    this.users = new UserRepository(this.db);
    this.events = new EventRepository(this.db);
    this.reminders = new ReminderRepository(this.db);
    this.holidays = new HolidayRepository(this.db);
    this.chatHistory = new ChatHistoryRepository(this.db);
    this.notificationPreferences = new NotificationPreferencesRepository(this.db);
    this.eventReminders = new EventReminderRepository(this.db);
    this.notificationLog = new NotificationLogRepository(this.db);
    this.googleSync = new GoogleSyncRepository(this.db);
    this.googleCalendars = new GoogleCalendarRepository(this.db);
  }

  close(): void {
    this.db.close();
    dbLogger.info('Database closed');
  }
}

export function createDatabase(dbPath: string): DatabaseService {
  return new DatabaseService(dbPath);
}
