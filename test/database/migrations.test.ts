import Database from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import { runMigrations } from '../../src/database/schema.ts';

test('birthday migrations create expected tables and columns', () => {
  const db = new Database(':memory:');
  runMigrations(db, migrations);

  const cols = db.prepare('PRAGMA table_info(events)').all() as { name: string }[];
  expect(cols.some((c) => c.name === 'event_type')).toBe(true);

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  expect(tables.some((t) => t.name === 'birth_event_metadata')).toBe(true);
  expect(tables.some((t) => t.name === 'birthday_sync_state')).toBe(true);

  const metaCols = db.prepare('PRAGMA table_info(birth_event_metadata)').all() as { name: string }[];
  const names = metaCols.map((c) => c.name);
  expect(names).toContain('event_id');
  expect(names).toContain('celebrant_id');
  expect(names).toContain('birth_year');
  expect(names).toContain('auto_created');
});
