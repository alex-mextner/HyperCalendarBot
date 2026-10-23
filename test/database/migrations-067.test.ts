// Migration 067 adds role, preset and cost to the AI usage ledger. Three nullable columns on a table
// the image before it only INSERTs by column name, so the previous image keeps working on the migrated database.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import { runMigrations } from '../../src/database/schema.ts';

const MIGRATION = '067_ai_usage_role_preset_cost';

test('is the last migration, appended after 066', () => {
  expect(migrations.at(-1)?.name).toBe(MIGRATION);
  expect(migrations.at(-2)?.name).toBe('066_ai_usage_events');
});

test('adds role, preset and cost_micro_usd, all nullable, once; rows written before it read back NULL', () => {
  const db = new Database(':memory:');
  runMigrations(db, migrations.slice(0, -1));
  db.exec(
    "INSERT INTO ai_usage_events (at, provider, model, chain, purpose, outcome) VALUES (1, 'zai', 'm', 'smart', 'agent', 'ok')",
  );
  runMigrations(db, migrations);
  runMigrations(db, migrations);

  const columns = db
    .query<{ name: string; notnull: number; type: string }, []>(
      "SELECT name, \"notnull\", type FROM pragma_table_info('ai_usage_events') WHERE name IN ('role', 'preset', 'cost_micro_usd') ORDER BY name",
    )
    .all();
  expect(columns).toEqual([
    { name: 'cost_micro_usd', notnull: 0, type: 'INTEGER' },
    { name: 'preset', notnull: 0, type: 'TEXT' },
    { name: 'role', notnull: 0, type: 'TEXT' },
  ]);
  expect(db.query('SELECT role, preset, cost_micro_usd FROM ai_usage_events').get()).toEqual({
    role: null,
    preset: null,
    cost_micro_usd: null,
  });
  expect(db.query('SELECT count(*) AS n FROM migrations WHERE name = ?').get(MIGRATION)).toEqual({ n: 1 });
});

test('refuses a negative cost: unknown is NULL, never a sentinel', () => {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  expect(() =>
    db.exec(
      "INSERT INTO ai_usage_events (at, provider, model, chain, purpose, outcome, cost_micro_usd) VALUES (1, 'zai', 'm', 'smart', 'agent', 'ok', -1)",
    ),
  ).toThrow();
  db.exec(
    "INSERT INTO ai_usage_events (at, provider, model, chain, purpose, outcome, cost_micro_usd) VALUES (1, 'zai', 'm', 'smart', 'agent', 'ok', 0)",
  );
});

test('the image before this migration, which does not name the new columns, still inserts into the migrated table', () => {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  db.exec(`INSERT INTO ai_usage_events
    (at, provider, model, chain, purpose, outcome, error_class, http_status, skip_reason, duration_ms,
     prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens, request_id)
    VALUES (1, 'zai', 'm', 'smart', 'agent', 'ok', NULL, NULL, NULL, 10, 1, 2, NULL, NULL, 'r')`);
  expect(db.query('SELECT count(*) AS n FROM ai_usage_events').get()).toEqual({ n: 1 });
});

test('the rollback SQL in the migration doc runs on the migrated database and leaves the 066 schema', () => {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE ai_usage_events DROP COLUMN role;
    ALTER TABLE ai_usage_events DROP COLUMN preset;
    ALTER TABLE ai_usage_events DROP COLUMN cost_micro_usd;
    DELETE FROM migrations WHERE name = '${MIGRATION}';
    COMMIT;`);

  const columns = db
    .query<{ name: string }, []>("SELECT name FROM pragma_table_info('ai_usage_events')")
    .all()
    .map((column) => column.name);
  expect(columns).not.toContain('cost_micro_usd');
  expect(columns).toContain('request_id');
});
