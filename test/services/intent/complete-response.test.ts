import { expect, test } from 'bun:test';
import type { ToolResult } from '../../../src/services/ai/types.ts';
import { IntentExecutor } from '../../../src/services/intent/intent-executor.ts';

const ctx = { timezone: 'UTC', language: 'en' };
const complete = (): ToolResult => ({ success: true, output: 'Complete roster', completeResponse: true });
const roster = { call: 'get_invitation_status', input: { event_id: '1' } };

test('the last complete tool response is carried through both workflow levels', async () => {
  const executor = new IntentExecutor();
  const l1 = await executor.run({ tools: [{ name: roster.call, input: roster.input }] }, {}, ctx, complete);
  const l2 = await executor.run({ steps: [roster] }, {}, ctx, complete);
  expect(l1.completeResponse).toBe(true);
  expect(l2.completeResponse).toBe(true);
});

test('a later ordinary tool clears response completeness', async () => {
  const result = await new IntentExecutor().run(
    { steps: [roster, { call: 'get_contacts', input: {} }] },
    {},
    ctx,
    (name) => (name === roster.call ? complete() : { success: true, output: 'More information' }),
  );
  expect(result.response).toBe('More information');
  expect(result.completeResponse).not.toBe(true);
});

test('an explicit workflow response does not inherit a prior tool completeness claim', async () => {
  const result = await new IntentExecutor().run(
    { steps: [roster, { respond: 'Different response' }] },
    {},
    ctx,
    complete,
  );
  expect(result.response).toBe('Different response');
  expect(result.completeResponse).not.toBe(true);
});

test('a failed step after a complete read remains a failure', async () => {
  const result = await new IntentExecutor().run(
    { steps: [roster, { call: 'get_contacts', input: {} }] },
    {},
    ctx,
    (name) => (name === roster.call ? complete() : { success: false, error: 'Read unavailable' }),
  );
  expect(result.success).toBe(false);
  expect(result.completeResponse).not.toBe(true);
});

test('a suspended question and a tool handoff are not complete answers', async () => {
  const executor = new IntentExecutor();
  const suspended = await executor.run(
    { steps: [roster, { call: 'ask_user', input: { question: 'Continue?' } }] },
    {},
    ctx,
    complete,
  );
  expect(suspended.suspended).toBe(true);
  expect(suspended.completeResponse).not.toBe(true);
  const handoff = await executor.run({ steps: [roster] }, {}, ctx, () => ({ ...complete(), stopLoop: true }));
  expect(handoff.completeResponse).not.toBe(true);
});

test('a write followed by a complete roster read is not a complete read-only answer', async () => {
  const result = await new IntentExecutor().run(
    { steps: [{ call: 'create_event', input: {} }, roster] },
    {},
    ctx,
    (name) => (name === roster.call ? complete() : { success: true, output: 'Created', mutationState: 'confirmed' }),
  );
  expect(result.completeResponse).not.toBe(true);
});
