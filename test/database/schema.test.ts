// test/database/schema.test.ts

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
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
});
