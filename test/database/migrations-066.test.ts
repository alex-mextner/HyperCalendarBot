// Migration 066 adds the nullable per-event color Google sync fills from colorId (#29). It only adds a
// column: every existing event keeps its values with no color, and the event INSERT of the image
// before it keeps working on the migrated table.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrations } from '../../src/database/migrations.ts';
import { EventRepository } from '../../src/database/repositories/event.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';

const MIGRATION = '066_events_color';
const before = migrations.slice(
  0,
  migrations.findIndex((migration) => migration.name === MIGRATION),
);

function rows(db: Database) {
  return db.query('SELECT id, user_id, title, start_at, timezone, updated_at FROM events ORDER BY id').all();
}

test('runs once after the shipped entries and leaves every existing event without a color', () => {
  const db = new Database(':memory:');
  runMigrations(db, before);
  const events = new EventRepository(db);
  const id = events.create({ user_id: 100, title: 'Dinner', start_at: '2031-01-01T10:00:00.000Z', timezone: 'UTC' }).id;
  const rowsBefore = rows(db);

  runMigrations(db, migrations);
  runMigrations(db, migrations);

  const ledger = db.query<{ name: string }, [string]>('SELECT name FROM migrations WHERE name = ?').all(MIGRATION);
  expect(ledger).toEqual([{ name: MIGRATION }]);
  expect(rows(db)).toEqual(rowsBefore);
  expect(events.findById(id, 100)?.color).toBeNull();
});

test('the image before 066 can still insert an event, which gets no color', () => {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  // The pre-066 image's EventRepository.create statement, column list unchanged
  const { lastInsertRowid } = db
    .prepare(
      'INSERT INTO events (user_id, title, description, category, start_at, end_at, all_day, timezone, location, recurrence_rule, recurrence_end_at, owner_type, group_id, created_by, event_type, reminder_overrides) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      100,
      'Lunch',
      null,
      null,
      '2031-01-01T12:00:00.000Z',
      null,
      0,
      'UTC',
      null,
      null,
      null,
      'user',
      null,
      100,
      'event',
      null,
    );

  expect(new EventRepository(db).findById(Number(lastInsertRowid), 100)?.color).toBeNull();
});

test('ships the schema-gate doc with automatic-activation front matter', () => {
  const doc = join(import.meta.dir, '../../docs/reference/migrations', `${MIGRATION}.md`);
  expect(existsSync(doc)).toBe(true);
  expect(readFileSync(doc, 'utf8')).toStartWith(
    `---\nmigration: ${MIGRATION}\nrollback-compatible: yes\ndata-deletion: no\n---\n`,
  );
});
