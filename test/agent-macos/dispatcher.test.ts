import { describe, expect, mock, test } from 'bun:test';

const mockBashExecute = mock(async () => ({ stdout: 'hello', stderr: '', exitCode: 0 }));
const mockApplescriptRun = mock(async () => ({ output: 'ok', exitCode: 0 }));
const mockClaudeChat = mock(async () => ({ response: 'answer', conversationId: 'conv-1' }));
const mockGetOrgId = mock(async () => 'org-uuid');
const mockListChats = mock(async () => [{ id: 'c1', name: 'Chat 1' }]);
const mockListProjects = mock(async () => [{ id: 'p1', name: 'Project 1' }]);
const mockGetArtifact = mock(async () => ({ content: 'artifact body', type: 'text/plain' }));
const mockPlaywrightAction = mock(async () => ({ url: 'https://example.com' }));

mock.module('../../packages/agent-macos/src/actions/bash.ts', () => ({
  bashExecute: mockBashExecute,
}));
mock.module('../../packages/agent-macos/src/actions/applescript.ts', () => ({
  applescriptRun: mockApplescriptRun,
}));
mock.module('../../packages/agent-macos/src/actions/claude-bridge.ts', () => ({
  claudeChat: mockClaudeChat,
  getOrgId: mockGetOrgId,
  listChats: mockListChats,
  listProjects: mockListProjects,
  getArtifact: mockGetArtifact,
  loadCookies: mock(() => 'session=x'),
}));
mock.module('../../packages/agent-macos/src/actions/playwright.ts', () => ({
  playwrightAction: mockPlaywrightAction,
}));

const { dispatch } = await import('../../packages/agent-macos/src/dispatcher.ts');

describe('dispatch', () => {
  test('bash_execute routes to bashExecute', async () => {
    const responses: unknown[] = [];
    await dispatch({ id: '1', type: 'bash_execute', payload: { command: 'echo hi' } }, (r) => responses.push(r));
    expect(mockBashExecute).toHaveBeenCalledWith('echo hi', 60_000);
    expect(responses).toHaveLength(1);
    expect((responses[0] as { type: string }).type).toBe('done');
    expect((responses[0] as { data: { stdout: string } }).data.stdout).toBe('hello');
  });

  test('applescript_run routes to applescriptRun', async () => {
    const responses: unknown[] = [];
    await dispatch({ id: '2', type: 'applescript_run', payload: { script: 'tell app "Finder"' } }, (r) =>
      responses.push(r),
    );
    expect(mockApplescriptRun).toHaveBeenCalled();
    expect((responses[0] as { type: string }).type).toBe('done');
  });

  test('claude_list_chats returns chat list', async () => {
    const responses: unknown[] = [];
    await dispatch({ id: '3', type: 'claude_list_chats', payload: {} }, (r) => responses.push(r));
    expect(mockGetOrgId).toHaveBeenCalled();
    expect(mockListChats).toHaveBeenCalledWith('org-uuid');
    expect((responses[0] as { data: unknown[] }).data).toHaveLength(1);
  });

  test('claude_list_projects returns project list', async () => {
    const responses: unknown[] = [];
    await dispatch({ id: '4', type: 'claude_list_projects', payload: {} }, (r) => responses.push(r));
    expect(mockListProjects).toHaveBeenCalledWith('org-uuid');
    expect((responses[0] as { data: unknown[] }).data).toHaveLength(1);
  });

  test('claude_artifact calls getArtifact', async () => {
    const responses: unknown[] = [];
    await dispatch({ id: '5', type: 'claude_artifact', payload: { artifact_id: 'art-abc' } }, (r) => responses.push(r));
    expect(mockGetArtifact).toHaveBeenCalledWith('art-abc');
    const done = responses[0] as { type: string; data: { content: string; type: string } };
    expect(done.type).toBe('done');
    expect(done.data.content).toBe('artifact body');
  });

  test('playwright_action routes to playwrightAction', async () => {
    const responses: unknown[] = [];
    await dispatch(
      {
        id: '6',
        type: 'playwright_action',
        payload: { action: 'navigate', url: 'https://example.com' },
      },
      (r) => responses.push(r),
    );
    expect(mockPlaywrightAction).toHaveBeenCalled();
    expect((responses[responses.length - 1] as { type: string }).type).toBe('done');
  });

  test('unknown command returns error response', async () => {
    const responses: unknown[] = [];
    await dispatch(
      { id: '7', type: 'bash_execute' as 'bash_execute', payload: {} } as Parameters<typeof dispatch>[0],
      (r) => responses.push(r),
    );
    // bash_execute with no command — mockBashExecute is called, still goes through
    // Let's test truly unknown via a cast
    const responses2: unknown[] = [];
    await dispatch(
      // @ts-expect-error testing unknown type
      { id: '8', type: 'unknown_command', payload: {} },
      (r) => responses2.push(r),
    );
    expect((responses2[0] as { type: string }).type).toBe('error');
  });
});
