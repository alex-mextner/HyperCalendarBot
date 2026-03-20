import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import { runMigrations } from '../../src/database/schema.ts';

test('migration adds assistant_enabled column', () => {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  const cols = db.query('PRAGMA table_info(users)').all() as { name: string }[];
  expect(cols.some((c) => c.name === 'assistant_enabled')).toBe(true);
});
