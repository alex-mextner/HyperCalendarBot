import { expect, test } from 'bun:test';
import { registerPendingConnection } from '../../../src/agent/pairing.ts';
import { AgentRegistry } from '../../../src/agent/registry.ts';
import type { ConnectCtx } from '../../../src/bot/commands/connect.command.ts';
import {
  createActivateCommand,
  createConnectCommand,
  createDisconnectCommand,
} from '../../../src/bot/commands/connect.command.ts';

interface MockCtx extends ConnectCtx {
  _sent: string[];
}

function mockCtx(args = ''): MockCtx {
  const sent: string[] = [];
  return {
    user: { telegram_id: 42, language: 'ru' },
    args,
    send: async (text: string) => {
      sent.push(text);
    },
    _sent: sent,
  };
}

test('/connect sends download link', async () => {
  const connectCommand = createConnectCommand('https://example.com/agent.pkg');
  const ctx = mockCtx();
  await connectCommand(ctx);
  expect(ctx._sent[0]).toContain('https://example.com/agent.pkg');
});

test('/activate with unknown code sends error', async () => {
  const registry = new AgentRegistry();
  const activate = createActivateCommand(registry);
  const ctx = mockCtx('unknown-code');
  await activate(ctx);
  expect(ctx._sent[0]).toContain('❌');
});

test('/activate with valid code sends success and registers', async () => {
  process.env.AGENT_JWT_SECRET = 'test-secret-at-least-32-characters!!';
  const registry = new AgentRegistry();
  const activate = createActivateCommand(registry);

  const sent: string[] = [];
  const ws = { data: { userId: null }, send: (m: string) => sent.push(m) } as never;
  registerPendingConnection('good-code', ws);

  const ctx = mockCtx('good-code');
  await activate(ctx);

  expect(ctx._sent[0]).toContain('✅');
  expect(registry.isConnected(42)).toBe(true);
});

test('/activate with no code argument sends usage hint', async () => {
  const registry = new AgentRegistry();
  const activate = createActivateCommand(registry);
  const ctx = mockCtx('');
  await activate(ctx);
  expect(ctx._sent[0]).toBeTruthy();
  expect(ctx._sent[0]).not.toContain('✅');
});

test('/disconnect when agent connected: closes WS and disables assistant', async () => {
  const registry = new AgentRegistry();
  const closeCalls: { code: number; reason: string }[] = [];
  const ws = {
    data: { userId: 42, _token: null },
    send: () => {},
    close: (code: number, reason: string) => closeCalls.push({ code, reason }),
  } as never;
  registry.register(42, ws);

  const captured: { enabled: boolean }[] = [];
  const userRepo = {
    updateAssistantEnabled: (_id: number, enabled: boolean) => captured.push({ enabled }),
  } as never;

  const disconnect = createDisconnectCommand(registry, userRepo);
  const ctx = mockCtx();
  await disconnect(ctx);

  expect(closeCalls[0]!.code).toBe(4003);
  expect(captured[0]!.enabled).toBe(false);
  expect(ctx._sent[0]).toContain('✅');
});

test('/disconnect when agent not connected: disables assistant and sends not-connected message', async () => {
  const registry = new AgentRegistry();
  const captured: { enabled: boolean }[] = [];
  const userRepo = {
    updateAssistantEnabled: (_id: number, enabled: boolean) => captured.push({ enabled }),
  } as never;

  const disconnect = createDisconnectCommand(registry, userRepo);
  const ctx = mockCtx();
  await disconnect(ctx);

  expect(captured[0]!.enabled).toBe(false);
  expect(ctx._sent[0]).not.toContain('✅');
});
