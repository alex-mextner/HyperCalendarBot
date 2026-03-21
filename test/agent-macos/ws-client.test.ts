import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Mock the ws module before importing WsClient
const mockSend = mock(() => {});
const mockClose = mock(() => {});

const MockWebSocket = class {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 3; // CLOSED
  handlers: Record<string, ((...args: unknown[]) => void)[]> = {};

  on(event: string, handler: (...args: unknown[]) => void) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event]!.push(handler);
  }

  send = mockSend;
  close = mockClose;

  emit(event: string, ...args: unknown[]) {
    for (const h of this.handlers[event] ?? []) h(...args);
  }
};

mock.module('ws', () => ({ default: MockWebSocket }));

// Import after mocking
const { WsClient } = await import('../../packages/agent-macos/src/ws-client.ts');

describe('WsClient', () => {
  beforeEach(() => {
    mockSend.mockClear();
    mockClose.mockClear();
  });

  test('isConnected() returns false when not connected', () => {
    const client = new WsClient('wss://example.com', null);
    expect(client.isConnected()).toBe(false);
  });

  test('pair() does nothing when not connected', () => {
    const client = new WsClient('wss://example.com', null);
    expect(() => client.pair('abc123')).not.toThrow();
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('sendResponse() does nothing when not connected', () => {
    const client = new WsClient('wss://example.com', null);
    expect(() => client.sendResponse({ id: '1', type: 'done', data: {} })).not.toThrow();
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('close() sets closed state so subsequent connect() is a no-op', () => {
    const client = new WsClient('wss://example.com', 'jwt-token');
    client.close();
    // After close, connect should not create a new WS (closed flag prevents it)
    // We can verify by checking isConnected stays false
    client.connect();
    expect(client.isConnected()).toBe(false);
  });
});
