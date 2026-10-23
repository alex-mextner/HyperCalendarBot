// Migration 066 adds the append-only AI usage ledger. It only creates a new table and its indexes,
// so no existing table changes and the image before it ignores the table.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import { runMigrations } from '../../src/database/schema.ts';

const MIGRATION = '066_ai_usage_events';
/** The schema as migration 066 left it; 067 (role, preset, cost) is covered by migrations-067.test.ts. */
const UP_TO_066 = migrations.slice(0, migrations.findIndex((migration) => migration.name === MIGRATION) + 1);

test('was appended after 064 which was appended after 065, and later migrations only follow it', () => {
  const names = migrations.map((migration) => migration.name);
  expect(names.slice(names.indexOf('065_intent_revisions'), names.indexOf(MIGRATION) + 1)).toEqual([
    '065_intent_revisions',
    '064_event_participant_source_group',
    MIGRATION,
  ]);
});

test('creates the ledger with nullable usage columns and both read indexes, once', () => {
  const db = new Database(':memory:');
  runMigrations(db, UP_TO_066);
  runMigrations(db, UP_TO_066);

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
      "INSERT INTO ai_usage_events (at, provider, model, chain, purpose, outcome) VALUES (1, 'zai', 'm', 'smart', 'agent', 'maybe')",
    ),
  ).toThrow();
});
