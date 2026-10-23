// Migration 066 adds the append-only AI usage ledger. It only creates a new table and its indexes,
// so no existing table changes and the image before it ignores the table.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import { runMigrations } from '../../src/database/schema.ts';

const MIGRATION = '066_ai_usage_events';

test('is the last migration, appended after 064 which was appended after 065', () => {
  expect(migrations.at(-1)?.name).toBe(MIGRATION);
  expect(migrations.slice(-3).map((migration) => migration.name)).toEqual([
    '065_intent_revisions',
    '064_event_participant_source_group',
    MIGRATION,
  ]);
});

test('creates the ledger with nullable usage columns and both read indexes, once', () => {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  runMigrations(db, migrations);

  const columns = db
    .query<{ name: string; notnull: number }, []>('SELECT name, "notnull" FROM pragma_table_info(\'ai_usage_events\')')
    .all();
  const nullable = Object.fromEntries(columns.map((column) => [column.name, column.notnull === 0]));
  expect(nullable).toEqual({
    id: true,
    at: false,
    provider: false,
    model: false,
    chain: false,
    purpose: false,
    outcome: false,
    error_class: true,
    http_status: true,
    skip_reason: true,
    duration_ms: true,
    prompt_tokens: true,
    completion_tokens: true,
    reasoning_tokens: true,
    cached_tokens: true,
    request_id: true,
  });

  const indexes = db
    .query<{ name: string }, []>("SELECT name FROM pragma_index_list('ai_usage_events') ORDER BY name")
    .all()
    .map((row) => row.name);
  expect(indexes).toEqual(['idx_ai_usage_events_at', 'idx_ai_usage_events_provider_at']);
  expect(db.query('SELECT count(*) AS n FROM migrations WHERE name = ?').get(MIGRATION)).toEqual({ n: 1 });
});

test('refuses an outcome the report does not know', () => {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  expect(() =>
    db.exec(
      "INSERT INTO ai_usage_events (at, provider, model, chain, purpose, outcome) VALUES (1, 'groq', 'm', 'smart', 'agent', 'maybe')",
    ),
  ).toThrow();
});
