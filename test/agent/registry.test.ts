import { beforeEach, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import type { WsData } from '../../src/agent/pairing.ts';
import { AgentRegistry } from '../../src/agent/registry.ts';

const mockWs = () => ({ data: { userId: null }, send: () => {} }) as unknown as ServerWebSocket<WsData>;

let registry: AgentRegistry;
beforeEach(() => {
  registry = new AgentRegistry();
});

test('isConnected false for unknown user', () => {
  expect(registry.isConnected(999)).toBe(false);
});

test('register → isConnected true', () => {
  registry.register(1, mockWs());
  expect(registry.isConnected(1)).toBe(true);
});

test('unregister removes connection', () => {
  registry.register(1, mockWs());
  registry.unregister(1);
  expect(registry.isConnected(1)).toBe(false);
});

test('get returns registered ws', () => {
  const ws = mockWs();
  registry.register(1, ws);
  expect(registry.get(1)?.ws).toBe(ws);
});

test('register overwrites previous', () => {
  const ws1 = mockWs();
  const ws2 = mockWs();
  registry.register(1, ws1);
  registry.register(1, ws2);
  expect(registry.get(1)?.ws).toBe(ws2);
});
