import { expect, test } from 'bun:test';
import { AgentDispatcher } from '../../src/agent/dispatcher.ts';
import { issueAgentJwt } from '../../src/agent/pairing.ts';
import { AgentRegistry } from '../../src/agent/registry.ts';
import { createAgentWsHandler, upgradeAgentWs } from '../../src/agent/ws-server.ts';

function setup() {
  const registry = new AgentRegistry();
  const dispatcher = new AgentDispatcher(registry);
  const handler = createAgentWsHandler(registry, dispatcher);
  return { registry, dispatcher, handler };
}

function ws(userId: number | null, sent: string[] = []) {
  return { data: { userId, _token: null }, send: (m: string) => sent.push(m) } as unknown as Parameters<
    ReturnType<typeof createAgentWsHandler>['open']
  >[0];
}

test('open with userId=null does not register', async () => {
  const { registry, handler } = setup();
  await handler.open(ws(null));
  expect(registry.isConnected(1)).toBe(false);
});

test('close unregisters', () => {
  const { registry, handler } = setup();
  const w = ws(42);
  registry.register(42, w as unknown as Parameters<typeof registry.register>[1]);
  handler.close(w);
  expect(registry.isConnected(42)).toBe(false);
});

test('ping → pong', () => {
  const { registry, handler } = setup();
  const sent: string[] = [];
  const w = { data: { userId: 42, _token: null }, send: (m: string) => sent.push(m) } as unknown as Parameters<
    ReturnType<typeof createAgentWsHandler>['open']
  >[0];
  registry.register(42, w as unknown as Parameters<typeof registry.register>[1]);
  handler.message(w, JSON.stringify({ type: 'ping' }));
  expect(JSON.parse(sent[0]!)).toEqual({ type: 'pong' });
});

test('pair message calls registerPendingConnection (not completePairing)', () => {
  const { registry, handler } = setup();
  const w = ws(null);
  handler.message(w, JSON.stringify({ type: 'pair', code: 'test-1234' }));
  expect(w.data.userId).toBeNull();
  expect(registry.isConnected(0)).toBe(false);
});

test('upgradeAgentWs passes Bearer token as _token', () => {
  const upgradeCalls: { data: { userId: null; _token: string | null } }[] = [];
  const mockServer = {
    upgrade: (_req: Request, opts: { data: { userId: null; _token: string | null } }) => {
      upgradeCalls.push(opts);
      return true;
    },
  };
  const req = new Request('http://localhost/ws/agent', {
    headers: { Authorization: 'Bearer mytoken123' },
  });
  const result = upgradeAgentWs(req, mockServer);
  expect(result).toBe(true);
  expect(upgradeCalls[0]!.data._token).toBe('mytoken123');
  expect(upgradeCalls[0]!.data.userId).toBeNull();
});

test('upgradeAgentWs sets _token=null when no Authorization header', () => {
  const upgradeCalls: { data: { userId: null; _token: string | null } }[] = [];
  const mockServer = {
    upgrade: (_req: Request, opts: { data: { userId: null; _token: string | null } }) => {
      upgradeCalls.push(opts);
      return true;
    },
  };
  const req = new Request('http://localhost/ws/agent');
  upgradeAgentWs(req, mockServer);
  expect(upgradeCalls[0]!.data._token).toBeNull();
});

test('open with valid JWT registers connection', async () => {
  process.env.AGENT_JWT_SECRET = 'test-secret-at-least-32-characters!!';
  const { registry, handler } = setup();
  const jwt = await issueAgentJwt(99);
  const sent: string[] = [];
  const w = {
    data: { userId: null as number | null, _token: jwt },
    send: (m: string) => sent.push(m),
    close: () => {},
  } as unknown as Parameters<ReturnType<typeof createAgentWsHandler>['open']>[0];
  await handler.open(w);
  expect(registry.isConnected(99)).toBe(true);
  expect(w.data.userId).toBe(99);
});

test('open with invalid JWT closes connection with 4001', async () => {
  process.env.AGENT_JWT_SECRET = 'test-secret-at-least-32-characters!!';
  const { registry, handler } = setup();
  const closeCalls: { code: number; reason: string }[] = [];
  const w = {
    data: { userId: null as number | null, _token: 'not.a.real.jwt' },
    send: () => {},
    close: (code: number, reason: string) => closeCalls.push({ code, reason }),
  } as unknown as Parameters<ReturnType<typeof createAgentWsHandler>['open']>[0];
  await handler.open(w);
  expect(registry.isConnected(99)).toBe(false);
  expect(closeCalls[0]!.code).toBe(4001);
});
