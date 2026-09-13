import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { migrations } from '../../src/database/migrations.ts';
import { runMigrations } from '../../src/database/schema.ts';
import { toolSchemas } from '../../src/services/ai/tool-schemas.ts';

test('retired desktop commands cannot be parsed as tools', () => {
  for (const name of [
    'bash_execute',
    'applescript_run',
    'playwright_action',
    'claude_chat',
    'claude_new_chat',
    'claude_artifact',
  ]) {
    expect(Object.keys(toolSchemas)).not.toContain(name);
  }
});
test('the executable desktop agent and server transport are removed', () => {
  for (const path of ['packages/agent-macos', 'src/agent', 'src/bot/commands/connect.command.ts']) {
    expect(existsSync(new URL(`../../${path}`, import.meta.url))).toBe(false);
  }
});
test('retirement migration removes the obsolete capability flag without deleting users', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db, migrations);
    const columns = db.query<{ name: string }, []>('PRAGMA table_info(users)').all();
    expect(columns.some((c) => c.name === 'assistant_enabled')).toBe(false);
    expect(columns.some((c) => c.name === 'telegram_id')).toBe(true);
  } finally {
    db.close();
  }
});
