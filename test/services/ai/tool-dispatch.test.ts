import { describe, expect, test } from 'bun:test';
import { dispatchTool } from '../../../src/services/ai/tool-dispatch.ts';
import type { ToolInputMap, ToolName } from '../../../src/services/ai/tool-executor.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';

// Handlers are never reached by these cases, so a bare context is enough.
const ctx = { chatId: 1, user: { telegram_id: 1, language: 'en' } } as unknown as AgentContext;

function dispatch(name: string, input: object = {}) {
  return dispatchTool(ctx, name as ToolName, input as ToolInputMap[ToolName]);
}

describe('dispatchTool', () => {
  test('supplement_skip stops the loop', async () => {
    expect(await dispatch('supplement_skip')).toEqual({ success: true, stopLoop: true });
  });

  test('unknown tool names are reported verbatim', async () => {
    expect(await dispatch('no_such_tool')).toEqual({ success: false, error: 'Unknown tool: no_such_tool' });
  });

  test.each([
    'constructor',
    'toString',
    '__proto__',
    'hasOwnProperty',
  ])('inherited object property %s is not a tool', async (name) => {
    expect(await dispatch(name)).toEqual({ success: false, error: `Unknown tool: ${name}` });
  });

  test('delete_contact without a numeric contact_id asks for one', async () => {
    expect(await dispatch('delete_contact', { contact_id: 'abc' })).toEqual({
      success: false,
      error: 'A contact_id from your address book is required.',
    });
  });

  test.each(['resume_scene', 'cancel_scene'])('%s without a scene pause service is unavailable', async (name) => {
    expect(await dispatch(name)).toEqual({ success: false, error: 'Scene pause not available' });
  });

  test('a synchronous handler throw becomes a failed result', async () => {
    const result = await dispatch('make_call', { text: 123 });
    expect(result.success).toBe(false);
    expect(result.error).toStartWith('Tool execution failed: ');
  });
});
