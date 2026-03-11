// test/database/schema.test.ts
import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../src/database/schema.ts';
import type { Migration } from '../../src/database/schema.ts';

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

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const tableNames = tables.map(t => t.name);

    expect(tableNames).toContain('migrations');
    expect(tableNames).toContain('test_table');
  });

  test('skips already applied migrations', () => {
    let callCount = 0;
    const migrations: Migration[] = [
      {
        name: '001_test',
        up: () => { callCount++; },
      },
    ];

    runMigrations(db, migrations);
    runMigrations(db, migrations);

    expect(callCount).toBe(1);
  });

  test('applies migrations in order', () => {
    const order: string[] = [];
    const migrations: Migration[] = [
      { name: '001_first', up: () => { order.push('first'); } },
      { name: '002_second', up: () => { order.push('second'); } },
    ];

    runMigrations(db, migrations);

    expect(order).toEqual(['first', 'second']);
  });
});
