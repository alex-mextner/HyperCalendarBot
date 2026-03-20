import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  completePairing,
  generatePairingCode,
  issueAgentJwt,
  registerPendingConnection,
  verifyAgentJwt,
} from '../../src/agent/pairing.ts';
import { AgentRegistry } from '../../src/agent/registry.ts';
import { migrations } from '../../src/database/migrations.ts';
import { runMigrations } from '../../src/database/schema.ts';

test('migration adds assistant_enabled column', () => {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  const cols = db.query('PRAGMA table_info(users)').all() as { name: string }[];
  expect(cols.some((c) => c.name === 'assistant_enabled')).toBe(true);
});

test('generatePairingCode returns unique codes', () => {
  const codes = new Set(Array.from({ length: 100 }, generatePairingCode));
  expect(codes.size).toBe(100);
});

test('generatePairingCode matches format xxxx-xxxx', () => {
  expect(generatePairingCode()).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}$/);
});

test('issueAgentJwt + verifyAgentJwt roundtrip', async () => {
  process.env.AGENT_JWT_SECRET = 'test-secret-at-least-32-characters!!';
  const jwt = await issueAgentJwt(123456);
  const userId = await verifyAgentJwt(jwt);
  expect(userId).toBe(123456);
});

test('verifyAgentJwt returns null for garbage', async () => {
  process.env.AGENT_JWT_SECRET = 'test-secret-at-least-32-characters!!';
  expect(await verifyAgentJwt('not.a.jwt')).toBeNull();
});

test('completePairing returns false for unknown code', async () => {
  const registry = new AgentRegistry();
  expect(await completePairing('no-such', 1, registry)).toBe(false);
});

test('completePairing success path: sends jwt and registers', async () => {
  process.env.AGENT_JWT_SECRET = 'test-secret-at-least-32-characters!!';
  const registry = new AgentRegistry();
  const sent: string[] = [];
  const ws = { data: { userId: null }, send: (m: string) => sent.push(m) } as unknown as Parameters<
    typeof registerPendingConnection
  >[1];
  registerPendingConnection('abc-1234', ws);
  const ok = await completePairing('abc-1234', 42, registry);
  expect(ok).toBe(true);
  expect(registry.isConnected(42)).toBe(true);
  expect(sent).toHaveLength(1);
  const msg = JSON.parse(sent[0]!);
  expect(msg.type).toBe('paired');
  expect(typeof msg.jwt).toBe('string');
});
