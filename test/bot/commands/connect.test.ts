import { expect, test } from 'bun:test';
import { registerPendingConnection } from '../../../src/agent/pairing.ts';
import { AgentRegistry } from '../../../src/agent/registry.ts';
import type { ConnectCtx } from '../../../src/bot/commands/connect.command.ts';
import { createActivateCommand, createConnectCommand } from '../../../src/bot/commands/connect.command.ts';

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
