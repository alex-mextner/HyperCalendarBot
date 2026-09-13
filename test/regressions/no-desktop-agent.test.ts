import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { t } from '../../src/config/constants.ts';
import { migrations } from '../../src/database/migrations.ts';
import { runMigrations } from '../../src/database/schema.ts';
import { toolSchemas } from '../../src/services/ai/tool-schemas.ts';
import { getToolDefinitions } from '../../src/services/ai/tools.ts';

// Keep the retired catalog complete across schema parsing and every offered mode.
const RETIRED_TOOLS = [
  'bash_execute',
  'applescript_run',
  'playwright_action',
  'claude_chat',
  'claude_new_chat',
  'claude_list_chats',
  'claude_open_chat',
  'claude_list_projects',
  'claude_artifact',
];

test('retired desktop commands cannot be parsed as tools', () => {
  for (const name of RETIRED_TOOLS) expect(Object.keys(toolSchemas)).not.toContain(name);
});
for (const mode of [undefined, 'text', 'live_call', 'voice_message']) {
  for (const supplement of [false, true]) {
    test(`retired tools are absent in ${mode ?? 'default'}, supplement=${supplement}`, () => {
      const names = getToolDefinitions(mode, supplement)
        .filter((tool) => tool.type === 'function')
        .map((tool) => tool.function.name);
      for (const name of RETIRED_TOOLS) expect(names).not.toContain(name);
      expect(names).toContain('get_events');
      if (mode !== 'live_call') expect(names).toContain('render_day_image');
      if (supplement) expect(names).toContain('supplement_skip');
    });
  }
}

test('Caddy cannot serve previously published desktop installers', () => {
  const caddy = readFileSync(new URL('../../Caddyfile', import.meta.url), 'utf8');
  expect(caddy).not.toMatch(/handle\s+\/downloads\/\*/);
  expect(caddy).not.toContain('file_server');
  expect(caddy).toContain('reverse_proxy localhost:3001');
});

test('retired pairing instructions are absent in both languages', () => {
  for (const language of ['en', 'ru'] as const) expect(t(language).aiTools).not.toHaveProperty('agent');
});

test('the executable desktop agent and server transport are removed', () => {
  for (const path of ['packages/agent-macos', 'src/agent', 'src/bot/commands/connect.command.ts']) {
    expect(existsSync(new URL(`../../${path}`, import.meta.url))).toBe(false);
  }
});
function legacyDatabase(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(
    db,
    migrations.filter((migration) => migration.name < '062'),
  );
  db.exec(`
    INSERT INTO users (telegram_id, username, first_name, language, timezone, onboarding_completed, assistant_enabled)
    VALUES (101, 'first', 'Alice', 'en', 'Europe/Belgrade', 1, 0),
           (102, 'second', 'Boris', 'ru', 'Europe/Moscow', 1, 1);
    INSERT INTO events (id, user_id, title, start_at, timezone)
    VALUES (201, 102, 'Keep meeting', '2026-09-15T10:00:00Z', 'Europe/Moscow');
  `);
  return db;
}

test('retirement preserves populated users, related events and migration tracking', () => {
  const db = legacyDatabase();
  try {
    const retainedColumns = db
      .query<{ name: string }, []>('PRAGMA table_info(users)')
      .all()
      .map((column) => column.name)
      .filter((name) => name !== 'assistant_enabled');
    const users = () => db.query(`SELECT ${retainedColumns.join(', ')} FROM users ORDER BY telegram_id`).all();
    const beforeUsers = users();
    const beforeEvents = db.query('SELECT * FROM events').all();
    runMigrations(db, migrations);
    expect(
      db
        .query<{ name: string }, []>('PRAGMA table_info(users)')
        .all()
        .map((column) => column.name),
    ).toEqual(retainedColumns);
    expect(users()).toEqual(beforeUsers);
    expect(db.query('SELECT * FROM events').all()).toEqual(beforeEvents);
    const applied = db.query('SELECT * FROM migrations').all();
    expect(applied).toHaveLength(migrations.length);
    runMigrations(db, migrations);
    expect(db.query('SELECT * FROM migrations').all()).toEqual(applied);
    expect(users()).toEqual(beforeUsers);
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  } finally {
    db.close();
  }
});

test('documented rollback supports legacy user reads and writes, then re-upgrade', () => {
  const db = legacyDatabase();
  try {
    runMigrations(db, migrations);
    db.exec("UPDATE users SET first_name = 'After retirement' WHERE telegram_id = 101");
    const beforeUsers = db.query('SELECT * FROM users ORDER BY telegram_id').all();
    const beforeEvents = db.query('SELECT * FROM events').all();
    const guide = readFileSync(new URL('../../CLAUDE.md', import.meta.url), 'utf8');
    const sql = guide.match(/<!-- desktop-retirement-rollback -->\s*```sql\n([\s\S]*?)```/)?.[1];
    if (sql) db.exec(sql);
    expect(() => db.query('SELECT assistant_enabled FROM users').all()).not.toThrow();
    expect(db.query('SELECT assistant_enabled FROM users').all()).toEqual([
      { assistant_enabled: 0 },
      { assistant_enabled: 0 },
    ]);
    db.exec('UPDATE users SET assistant_enabled = 1 WHERE telegram_id = 102');
    runMigrations(
      db,
      migrations.filter((migration) => migration.name < '062'),
    );
    runMigrations(db, migrations);
    expect(db.query('SELECT * FROM users ORDER BY telegram_id').all()).toEqual(beforeUsers);
    expect(db.query('SELECT * FROM events').all()).toEqual(beforeEvents);
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  } finally {
    db.close();
  }
});
