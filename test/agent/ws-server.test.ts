import { expect, test } from 'bun:test';
import { AgentDispatcher } from '../../src/agent/dispatcher.ts';
import { AgentRegistry } from '../../src/agent/registry.ts';
import { createAgentWsHandler } from '../../src/agent/ws-server.ts';

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
