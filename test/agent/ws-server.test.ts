import { expect, jest, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { AgentDispatcher } from '../../src/agent/dispatcher.ts';
import { initPairingSecret, issueAgentJwt, verifyAgentJwt, type WsData } from '../../src/agent/pairing.ts';
import { AgentRegistry } from '../../src/agent/registry.ts';
import { createAgentWsHandler, upgradeAgentWs } from '../../src/agent/ws-server.ts';

const TEST_SECRET = 'test-secret-at-least-32-characters!!';
initPairingSecret(TEST_SECRET);

type MockWs = ServerWebSocket<WsData>;

function mockWs(
  userId: number | null,
  opts: { sent?: string[]; closeCalls?: { code: number; reason: string }[]; token?: string | null } = {},
): MockWs {
  const sent = opts.sent ?? [];
  const closeCalls = opts.closeCalls ?? [];
  return {
    data: { userId, _token: opts.token ?? null },
    send: (m: string) => sent.push(m),
    close: (code: number, reason: string) => closeCalls.push({ code, reason }),
  } as Partial<ServerWebSocket<WsData>> as MockWs;
}

function setup() {
  const registry = new AgentRegistry();
  const dispatcher = new AgentDispatcher(registry);
  const handler = createAgentWsHandler(registry, dispatcher);
  return { registry, dispatcher, handler };
}

test('open with userId=null does not register', async () => {
  const { registry, handler } = setup();
  await handler.open(mockWs(null));
  expect(registry.isConnected(1)).toBe(false);
});

test('close unregisters', () => {
  const { registry, handler } = setup();
  const w = mockWs(42);
  registry.register(42, w);
  handler.close(w);
  expect(registry.isConnected(42)).toBe(false);
});

test('close rejects in-flight commands for that user', async () => {
  const { registry, dispatcher, handler } = setup();
  const w = mockWs(42);
  registry.register(42, w);
  const promise = dispatcher.send(42, 'bash_execute', { command: 'sleep 99' });
  handler.close(w);
  await expect(promise).rejects.toThrow('Agent disconnected');
});

test('ping → pong', () => {
  const { registry, handler } = setup();
  const sent: string[] = [];
  const w = mockWs(42, { sent });
  registry.register(42, w);
  handler.message(w, JSON.stringify({ type: 'ping' }));
  expect(JSON.parse(sent[0]!)).toEqual({ type: 'pong' });
});

test('pair message calls registerPendingConnection (not completePairing)', () => {
  const { registry, handler } = setup();
  const w = mockWs(null);
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
  const { registry, handler } = setup();
  const jwt = await issueAgentJwt(99);
  const sent: string[] = [];
  const w = mockWs(null, { sent, token: jwt });
  await handler.open(w);
  expect(registry.isConnected(99)).toBe(true);
  expect(w.data.userId).toBe(99);
});

test('open with fresh JWT does NOT push token_refreshed', async () => {
  const { handler } = setup();
  const jwt = await issueAgentJwt(77);
  const sent: string[] = [];
  const w = mockWs(null, { sent, token: jwt });
  await handler.open(w);
  expect(sent.filter((m) => JSON.parse(m).type === 'token_refreshed')).toHaveLength(0);
});

test('open with near-expiry JWT pushes token_refreshed with valid new JWT', async () => {
  const { handler } = setup();
  const { SignJWT } = await import('jose');
  const secret = new TextEncoder().encode(TEST_SECRET);
  const shortJwt = await new SignJWT({ sub: '88' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('3d')
    .sign(secret);
  const sent: string[] = [];
  const w = mockWs(null, { sent, token: shortJwt });
  await handler.open(w);
  const refreshMsgs = sent.filter((m) => JSON.parse(m).type === 'token_refreshed');
  expect(refreshMsgs).toHaveLength(1);
  const newJwt = JSON.parse(refreshMsgs[0]!).jwt;
  expect(await verifyAgentJwt(newJwt)).toBe(88);
});

test('open without token closes connection after 30s if still unauthenticated', async () => {
  jest.useFakeTimers();
  const { handler } = setup();
  const closeCalls: { code: number; reason: string }[] = [];
  const w = mockWs(null, { closeCalls });
  await handler.open(w);
  expect(closeCalls).toHaveLength(0);
  jest.advanceTimersByTime(30_000);
  expect(closeCalls[0]!.code).toBe(4002);
  jest.useRealTimers();
});

test('open without token does NOT close if authenticated before timeout', async () => {
  jest.useFakeTimers();
  const { registry, handler } = setup();
  const closeCalls: { code: number; reason: string }[] = [];
  const w = mockWs(null, { closeCalls });
  await handler.open(w);
  // Simulate pairing completing (userId set before timeout fires)
  w.data.userId = 55;
  registry.register(55, w);
  jest.advanceTimersByTime(30_000);
  expect(closeCalls).toHaveLength(0);
  jest.useRealTimers();
});

test('message: invalid JSON is silently ignored', () => {
  const { handler } = setup();
  const w = mockWs(42);
  expect(() => handler.message(w, 'not-json')).not.toThrow();
});

test('message: chunk/done/error are forwarded to dispatcher', async () => {
  const { registry, dispatcher, handler } = setup();
  const w = mockWs(42);
  registry.register(42, w);
  const promise = dispatcher.send(42, 'bash_execute', { command: 'echo hi' });
  // Get the command id from the pending map by intercepting the sent message
  const sent: string[] = [];
  const wWithSpy = mockWs(42, { sent });
  registry.register(42, wWithSpy);
  const promise2 = dispatcher.send(42, 'bash_execute', { command: 'echo hi' });
  const cmd = JSON.parse(sent[0]!);
  handler.message(wWithSpy, JSON.stringify({ id: cmd.id, type: 'chunk', text: 'partial' }));
  handler.message(wWithSpy, JSON.stringify({ id: cmd.id, type: 'done', data: 'result' }));
  await expect(promise2).resolves.toEqual({ data: 'result', exitCode: undefined });
  // First promise was never resolved — reject it to avoid leaks
  dispatcher.rejectPendingForUser(42, new Error('cleanup'));
  await expect(promise).rejects.toThrow('cleanup');
});

test('open with invalid JWT closes connection with 4001', async () => {
  const { registry, handler } = setup();
  const closeCalls: { code: number; reason: string }[] = [];
  const w = mockWs(null, { closeCalls, token: 'not.a.real.jwt' });
  await handler.open(w);
  expect(registry.isConnected(99)).toBe(false);
  expect(closeCalls[0]!.code).toBe(4001);
});
