import { expect, test } from 'bun:test';
import { AgentDispatcher } from '../../src/agent/dispatcher.ts';
import { AgentRegistry } from '../../src/agent/registry.ts';

function makeSetup() {
  const registry = new AgentRegistry();
  const sent: string[] = [];
  const ws = { data: { userId: 1 }, send: (m: string) => sent.push(m) } as unknown as Parameters<
    typeof registry.register
  >[1];
  registry.register(1, ws);
  const dispatcher = new AgentDispatcher(registry);
  return { registry, dispatcher, sent };
}

test('send throws when agent not connected', async () => {
  const registry = new AgentRegistry();
  const dispatcher = new AgentDispatcher(registry);
  await expect(dispatcher.send(99, 'bash_execute', {})).rejects.toThrow('not connected');
});

test('send → done resolves with data', async () => {
  const { dispatcher, sent } = makeSetup();
  const promise = dispatcher.send(1, 'bash_execute', { command: 'echo hi' });
  const { id } = JSON.parse(sent[0]!) as { id: string };
  dispatcher.handleResponse({ id, type: 'done', exitCode: 0, data: 'hi\n' });
  const result = await promise;
  expect(result.exitCode).toBe(0);
  expect(result.data).toBe('hi\n');
});

test('chunks accumulate before done', async () => {
  const { dispatcher, sent } = makeSetup();
  const chunks: string[] = [];
  const promise = dispatcher.send(1, 'claude_chat', {}, (t) => chunks.push(t));
  const { id } = JSON.parse(sent[0]!) as { id: string };
  dispatcher.handleResponse({ id, type: 'chunk', text: 'Hello' });
  dispatcher.handleResponse({ id, type: 'chunk', text: ' world' });
  dispatcher.handleResponse({ id, type: 'done' });
  await promise;
  expect(chunks).toEqual(['Hello', ' world']);
});

test('error response rejects promise', async () => {
  const { dispatcher, sent } = makeSetup();
  const promise = dispatcher.send(1, 'bash_execute', {});
  const { id } = JSON.parse(sent[0]!) as { id: string };
  dispatcher.handleResponse({ id, type: 'error', error: 'Permission denied' });
  await expect(promise).rejects.toThrow('Permission denied');
});
