// test/database/schema.test.ts

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import type { Migration } from '../../src/database/schema.ts';
import { runMigrations } from '../../src/database/schema.ts';

describe('runMigrations', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  test('creates migrations table and applies migrations', () => {
    const migrations: Migration[] = [
      {
        name: '001_test',
        up: (db) => {
          db.exec('CREATE TABLE test_table (id INTEGER PRIMARY KEY)');
        },
      },
    ];

    runMigrations(db, migrations);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('migrations');
    expect(tableNames).toContain('test_table');
  });

  test('skips already applied migrations', () => {
    let callCount = 0;
    const migrations: Migration[] = [
      {
        name: '001_test',
        up: () => {
          callCount++;
        },
      },
    ];

    runMigrations(db, migrations);
    runMigrations(db, migrations);

    expect(callCount).toBe(1);
  });

  test('applies migrations in order', () => {
    const order: string[] = [];
    const migrations: Migration[] = [
      {
        name: '001_first',
        up: () => {
          order.push('first');
        },
      },
      {
        name: '002_second',
        up: () => {
          order.push('second');
        },
      },
    ];

    runMigrations(db, migrations);

    expect(order).toEqual(['first', 'second']);
  });
});

describe('production migrations', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
  });

  test('migration 005 creates chat_history table', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_history'").all() as {
      name: string;
    }[];
    expect(tables.length).toBe(1);

    const columns = db.prepare('PRAGMA table_info(chat_history)').all() as { name: string }[];
    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('user_id');
    expect(colNames).toContain('role');
    expect(colNames).toContain('content');
    expect(colNames).toContain('created_at');
  });

  test('migration 006 creates notification tables', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('notification_preferences');
    expect(names).toContain('event_reminders');
    expect(names).toContain('notification_log');
  });

  test('migration 007 creates google sync tables', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('google_sync_state');
    expect(names).toContain('google_calendars');
    expect(names).toContain('google_watch_channels');
    expect(names).toContain('sync_log');
  });

  test('migration 007 adds sync fields to events table', () => {
    const columns = db.prepare('PRAGMA table_info(events)').all() as { name: string }[];
    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain('google_etag');
    expect(colNames).toContain('sync_status');
    expect(colNames).toContain('sync_version');
  });

  test('migration 008 creates sharing tables', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('invitations');
    expect(names).toContain('shared_events');
    expect(names).toContain('sharing_settings');
    expect(names).toContain('event_visibility');
    expect(names).toContain('group_chats');
    expect(names).toContain('group_shared_events');
    expect(names).toContain('deep_links');
  });

  test('migration 009 creates voice call tables', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('user_call_settings');
    expect(names).toContain('call_log');
  });

  test('invitations foreign key cascades on event delete', () => {
    const userRepo = new UserRepository(db);
    userRepo.create({ telegram_id: 100 });
    db.prepare(
      "INSERT INTO events (user_id, title, start_at, timezone) VALUES (100, 'Test', '2026-03-15T10:00:00Z', 'UTC')",
    ).run();
    const eventId = db.prepare('SELECT last_insert_rowid() as id').get() as { id: number };
    db.prepare('INSERT INTO invitations (event_id, inviter_id, invitee_id) VALUES (?, 100, 200)').run(eventId.id);
    db.prepare('DELETE FROM events WHERE id = ?').run(eventId.id);
    const inv = db.prepare('SELECT * FROM invitations WHERE event_id = ?').all(eventId.id);
    expect(inv).toHaveLength(0);
  });
});
