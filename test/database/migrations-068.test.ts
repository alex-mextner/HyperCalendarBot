// Migration 068 adds response-speed and estimated prompt-size columns to the AI usage ledger. Nullable
// integers on a table the image before it only INSERTs by column name, so the previous image keeps working
// on the migrated database.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import { runMigrations } from '../../src/database/schema.ts';

const MIGRATION = '068_ai_usage_speed_prompt_size';
const NEW_COLUMNS = [
  'first_token_ms',
  'generation_ms',
  'system_prompt_tokens',
  'tool_catalog_tokens',
  'history_tokens',
  'user_tokens',
  'tool_count',
  'message_count',
];

test('is the last migration, appended after 067', () => {
  expect(migrations.at(-1)?.name).toBe(MIGRATION);
  expect(migrations.at(-2)?.name).toBe('067_ai_usage_role_preset_cost');
});

test('adds the speed and prompt-size columns, all nullable integers, once; rows written before it read back NULL', () => {
  const db = new Database(':memory:');
  runMigrations(db, migrations.slice(0, -1));
  db.exec(
    "INSERT INTO ai_usage_events (at, provider, model, chain, purpose, outcome, duration_ms) VALUES (1, 'claude', 'm', 'smart', 'agent', 'ok', 900)",
  );
  runMigrations(db, migrations);
  runMigrations(db, migrations);

  const columns = db
    .query<{ name: string; notnull: number; type: string }, []>(
      `SELECT name, "notnull", type FROM pragma_table_info('ai_usage_events') WHERE name IN (${NEW_COLUMNS.map((c) => `'${c}'`).join(', ')}) ORDER BY name`,
    )
    .all();
  expect(columns).toEqual([...NEW_COLUMNS].sort().map((name) => ({ name, notnull: 0, type: 'INTEGER' })));
  const row = db.query(`SELECT ${NEW_COLUMNS.join(', ')} FROM ai_usage_events`).get();
  expect(row).toEqual(Object.fromEntries(NEW_COLUMNS.map((name) => [name, null])));
  expect(db.query('SELECT count(*) AS n FROM migrations WHERE name = ?').get(MIGRATION)).toEqual({ n: 1 });
});

test('refuses a negative value: unknown is NULL, never a sentinel; a measured zero is allowed', () => {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  for (const column of NEW_COLUMNS) {
    expect(() =>
      db.exec(
        `INSERT INTO ai_usage_events (at, provider, model, chain, purpose, outcome, ${column}) VALUES (1, 'zai', 'm', 'smart', 'agent', 'ok', -1)`,
      ),
    ).toThrow();
    db.exec(
      `INSERT INTO ai_usage_events (at, provider, model, chain, purpose, outcome, ${column}) VALUES (1, 'zai', 'm', 'smart', 'agent', 'ok', 0)`,
    );
  }
});

test('the image before this migration, which does not name the new columns, still inserts into the migrated table', () => {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  db.exec(`INSERT INTO ai_usage_events
    (at, provider, model, chain, purpose, outcome, error_class, http_status, skip_reason, duration_ms,
     prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens, request_id, role, preset, cost_micro_usd)
    VALUES (1, 'zai', 'm', 'smart', 'agent', 'ok', NULL, NULL, NULL, 10, 1, 2, NULL, NULL, 'r', NULL, NULL, NULL)`);
  expect(db.query('SELECT count(*) AS n FROM ai_usage_events').get()).toEqual({ n: 1 });
});

test('the rollback SQL in the migration doc runs on the migrated database and leaves the 067 schema', () => {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  db.exec(`BEGIN IMMEDIATE;
    ${NEW_COLUMNS.map((column) => `ALTER TABLE ai_usage_events DROP COLUMN ${column};`).join('\n    ')}
    DELETE FROM migrations WHERE name = '${MIGRATION}';
    COMMIT;`);

  const columns = db
    .query<{ name: string }, []>("SELECT name FROM pragma_table_info('ai_usage_events')")
    .all()
    .map((column) => column.name);
  expect(columns).not.toContain('generation_ms');
  expect(columns).not.toContain('message_count');
  expect(columns).toContain('cost_micro_usd');
});
