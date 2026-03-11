// src/database/index.ts
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runMigrations } from './schema.ts';
import { migrations } from './migrations.ts';
import { UserRepository } from './repositories/user.repository.ts';
import { EventRepository } from './repositories/event.repository.ts';
import { ReminderRepository } from './repositories/reminder.repository.ts';
import { dbLogger } from '../utils/logger.ts';

export class DatabaseService {
  readonly db: Database;
  readonly users: UserRepository;
  readonly events: EventRepository;
  readonly reminders: ReminderRepository;

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
  }

  close(): void {
    this.db.close();
    dbLogger.info('Database closed');
  }
}

export function createDatabase(dbPath: string): DatabaseService {
  return new DatabaseService(dbPath);
}
