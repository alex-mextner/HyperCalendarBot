import { expect, test } from 'bun:test';
import { AgentDispatcher } from '../../../../src/agent/dispatcher.ts';
import { AgentRegistry } from '../../../../src/agent/registry.ts';
import { handleAssistantTool } from '../../../../src/services/ai/tool-handlers/assistant.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';

type TestCtx = AgentContext & { _sent: string[] };

function makeCtx(connected: boolean): TestCtx | AgentContext {
  const registry = new AgentRegistry();
  const dispatcher = new AgentDispatcher(registry);
  if (connected) {
    const sent: string[] = [];
    const ws = {
      data: { userId: 1 },
      send: (m: string) => sent.push(m),
    } as unknown as import('bun').ServerWebSocket<{ userId: number }>;
    registry.register(1, ws as never);
    return {
      user: { telegram_id: 1, language: 'ru' },
      agents: { agentRegistry: registry, agentDispatcher: dispatcher, onAgentChunk: undefined },
      _sent: sent,
    } as unknown as TestCtx;
  }
  return {
    user: { telegram_id: 1, language: 'ru' },
    agents: { agentRegistry: registry, agentDispatcher: dispatcher, onAgentChunk: undefined },
  } as unknown as AgentContext;
}

test('returns error + /connect link when not connected', async () => {
  const result = await handleAssistantTool(makeCtx(false) as AgentContext, 'bash_execute', { command: 'ls' });
  expect(result.success).toBe(false);
  expect(result.output).toContain('/connect');
});

test('dispatches bash_execute and returns output', async () => {
  const c = makeCtx(true) as TestCtx;
  const promise = handleAssistantTool(c, 'bash_execute', { command: 'echo hi' });
  const raw = c._sent[0];
  if (!raw) throw new Error('No message sent');
  const cmd = JSON.parse(raw) as { id: string };
  c.agents!.agentDispatcher.handleResponse({ id: cmd.id, type: 'done', exitCode: 0, data: 'hi\n' });
  const result = await promise;
  expect(result.success).toBe(true);
  expect(result.output).toContain('hi');
});

test('non-zero exitCode marks success=false', async () => {
  const c = makeCtx(true) as TestCtx;
  const promise = handleAssistantTool(c, 'bash_execute', { command: 'false' });
  const raw = c._sent[0];
  if (!raw) throw new Error('No message sent');
  const cmd = JSON.parse(raw) as { id: string };
  c.agents!.agentDispatcher.handleResponse({ id: cmd.id, type: 'done', exitCode: 1, data: '' });
  const result = await promise;
  expect(result.success).toBe(false);
});

test('error response returns success=false with message', async () => {
  const c = makeCtx(true) as TestCtx;
  const promise = handleAssistantTool(c, 'bash_execute', { command: 'fail' });
  const raw = c._sent[0];
  if (!raw) throw new Error('No message sent');
  const cmd = JSON.parse(raw) as { id: string };
  c.agents!.agentDispatcher.handleResponse({ id: cmd.id, type: 'error', error: 'Permission denied' });
  const result = await promise;
  expect(result.success).toBe(false);
  expect(result.output).toContain('Permission denied');
});

test('chunk text is concatenated into output', async () => {
  const c = makeCtx(true) as TestCtx;
  const promise = handleAssistantTool(c, 'claude_chat', { message: 'hi' });
  const raw = c._sent[0];
  if (!raw) throw new Error('No message sent');
  const cmd = JSON.parse(raw) as { id: string };
  c.agents!.agentDispatcher.handleResponse({ id: cmd.id, type: 'chunk', text: 'Hello' });
  c.agents!.agentDispatcher.handleResponse({ id: cmd.id, type: 'chunk', text: ' world' });
  c.agents!.agentDispatcher.handleResponse({ id: cmd.id, type: 'done' });
  const result = await promise;
  expect(result.output).toContain('Hello world');
});
