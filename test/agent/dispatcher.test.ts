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

test('rejectPendingForUser rejects all pending commands for that user', async () => {
  const { dispatcher } = makeSetup();
  const p1 = dispatcher.send(1, 'bash_execute', { command: 'sleep 99' });
  const p2 = dispatcher.send(1, 'bash_execute', { command: 'sleep 99' });
  dispatcher.rejectPendingForUser(1, new Error('Agent disconnected'));
  await expect(p1).rejects.toThrow('Agent disconnected');
  await expect(p2).rejects.toThrow('Agent disconnected');
});

test('rejectPendingForUser does not affect other users', async () => {
  const registry = new AgentRegistry();
  const sent2: string[] = [];
  const sent3: string[] = [];
  const ws2 = { data: { userId: 2 }, send: (m: string) => sent2.push(m) } as unknown as Parameters<
    typeof registry.register
  >[1];
  const ws3 = { data: { userId: 3 }, send: (m: string) => sent3.push(m) } as unknown as Parameters<
    typeof registry.register
  >[1];
  registry.register(2, ws2);
  registry.register(3, ws3);
  const dispatcher = new AgentDispatcher(registry);

  const p2 = dispatcher.send(2, 'bash_execute', {});
  const p3 = dispatcher.send(3, 'bash_execute', {});

  dispatcher.rejectPendingForUser(2, new Error('disconnected'));

  await expect(p2).rejects.toThrow('disconnected');

  // p3 still pending — resolve it
  const { id: id3 } = JSON.parse(sent3[0]!) as { id: string };
  dispatcher.handleResponse({ id: id3, type: 'done', data: 'ok' });
  const result3 = await p3;
  expect(result3.data).toBe('ok');
});
