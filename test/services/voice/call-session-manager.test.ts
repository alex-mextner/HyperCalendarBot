import { expect, mock, test } from 'bun:test';
import { CallSessionManager } from '../../../src/services/voice/call-session-manager.ts';

function makeFakeSession() {
  return {
    handleMessage: mock(async (_data: string) => {}),
    handleBinaryMessage: mock((_data: Buffer) => {}),
    isEnded: mock(() => false),
    forceEnd: mock(() => {}),
  };
}

test('creates a session and retrieves it by sessionId', () => {
  const manager = new CallSessionManager({ createSession: (_id, _ws) => makeFakeSession() as never });
  const ws = { send: mock(() => {}), close: mock(() => {}) };
  manager.onWebSocketOpen('abc123', ws as never);
  expect(manager.getSession('abc123')).toBeDefined();
});

test('routes text message to session.handleMessage', async () => {
  const session = makeFakeSession();
  const manager = new CallSessionManager({ createSession: () => session as never });
  const ws = { send: mock(() => {}), close: mock(() => {}) };
  manager.onWebSocketOpen('sess1', ws as never);
  await manager.onWebSocketMessage('sess1', '{"type":"VAD_START"}', false);
  expect(session.handleMessage).toHaveBeenCalledWith('{"type":"VAD_START"}');
});

test('routes binary message to session.handleBinaryMessage', async () => {
  const session = makeFakeSession();
  const manager = new CallSessionManager({ createSession: () => session as never });
  const ws = { send: mock(() => {}), close: mock(() => {}) };
  manager.onWebSocketOpen('sess2', ws as never);
  const buf = Buffer.from([0, 1, 2, 3]);
  await manager.onWebSocketMessage('sess2', buf, true);
  expect(session.handleBinaryMessage).toHaveBeenCalledWith(buf);
});

test('removes session on close', () => {
  const manager = new CallSessionManager({ createSession: () => makeFakeSession() as never });
  const ws = { send: mock(() => {}), close: mock(() => {}) };
  manager.onWebSocketOpen('s3', ws as never);
  manager.onWebSocketClose('s3');
  expect(manager.getSession('s3')).toBeUndefined();
});

test('enforces 30-minute timeout', async () => {
  const ended = { value: false };
  const session = {
    handleMessage: mock(async () => {}),
    handleBinaryMessage: mock(() => {}),
    isEnded: () => ended.value,
    forceEnd: mock(() => {
      ended.value = true;
    }),
  };
  const manager = new CallSessionManager({
    createSession: () => session as never,
    timeoutMs: 50,
  });
  const ws = { send: mock(() => {}), close: mock(() => {}) };
  manager.onWebSocketOpen('s4', ws as never);
  await new Promise((r) => setTimeout(r, 80));
  expect(session.forceEnd).toHaveBeenCalled();
});
