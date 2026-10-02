import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import { runMigrations } from '../../src/database/schema.ts';
import { getToolDefinitions } from '../../src/services/ai/tools.ts';
import { toolSchemas } from '../../src/services/ai/tool-schemas.ts';
import { startWebServer, type WebServerDeps } from '../../src/web/server.ts';
const retired = ['claude_chat', 'claude_new_chat', 'claude_list_chats', 'claude_open_chat',
  'claude_list_projects', 'claude_artifact', 'bash_execute', 'playwright_action', 'applescript_run'];
function deps(): WebServerDeps {
  return { config: { OAUTH_SERVER_PORT: 0 }, userRepo: {}, aiChainDown: () => false,
    aiChainVerified: () => true } as unknown as WebServerDeps;
}
test('no model-facing or executable schema can authorize retired desktop commands', () => {
  const names = getToolDefinitions('text').flatMap(t => t.type === 'function' ? [t.function.name] : []);
  for (const name of retired) {
    expect(names).not.toContain(name);
    expect(Object.hasOwn(toolSchemas, name)).toBe(false);
  }
  expect(names).toContain('connect_telegram_status');
  expect(names).toContain('get_google_calendar_status');
});
test('retired websocket URL does not upgrade while health and calendar webhooks remain routed', async () => {
  const server = startWebServer(deps());
  try {
    expect((await fetch(`http://localhost:${server.port}/ws/agent`, {headers: { Upgrade: 'websocket' }})).status).toBe(404);
    expect((await fetch(`http://localhost:${server.port}/health`)).status).toBe(200);
  } finally { server.stop(); }
});
test('retirement migration removes only the unused preference, preserving calendar and Telegram session data', () => {
  const db = new Database(':memory:');
  try {
    const retirement = migrations.find(m => m.name.endsWith('_retire_mac_assistant'));
    expect(retirement).toBeDefined();
    runMigrations(db, migrations.filter(m => m !== retirement));
    db.run("INSERT INTO users(telegram_id, timezone, language, assistant_enabled) VALUES(5000000001,'UTC','en',1)");
    db.run("INSERT INTO user_telegram_sessions(user_id, encrypted_session, phone_masked, phone_hash) VALUES(5000000001,?, 'masked', 'synthetic')", [Buffer.from('synthetic-session')]);
    runMigrations(db, migrations);
    const columns = db.query<{name:string}, []>('PRAGMA table_info(users)').all().map(c => c.name);
    expect(columns).not.toContain('assistant_enabled');
    expect(db.query<{timezone:string}, []>('SELECT timezone FROM users WHERE telegram_id=5000000001').get()?.timezone).toBe('UTC');
    expect(db.query<{status:string}, []>('SELECT status FROM user_telegram_sessions WHERE user_id=5000000001').get()?.status).toBe('active');
    runMigrations(db, migrations);
    expect(db.query<{n:number}, []>('SELECT COUNT(*) n FROM users').get()?.n).toBe(1);
  } finally { db.close(); }
});
