import { expect, test } from 'bun:test';
import { IntentExecutor } from '../../src/services/intent/intent-executor.ts';
import { WorkflowSchema } from '../../src/services/intent/workflow-schema.ts';

test.each([
  'confirmed',
  'uncertain',
] as const)('suspended workflow retains %s write evidence on a later failure', async (mutationState) => {
  const workflow = WorkflowSchema.parse({
    version: 2,
    steps: [
      { call: 'create_event', input: { title: 'Synthetic evidence fixture', start_at: '2035-01-01T12:00:00Z' } },
      { call: 'ask_user', input: { question: 'Continue?', options: ['yes', 'no'] }, as: 'choice' },
      { call: 'get_events', input: { start_date: '2035-01-01', end_date: '2035-01-02' } },
    ],
  });
  const ctx = { telegramId: 1001, timezone: 'UTC', language: 'en' as const, user: null };
  let writes = 0;
  const tool = async (name: string) => {
    if (name === 'create_event') {
      writes++;
      return { success: true, output: 'Recorded', mutationState };
    }
    return { success: false, error: 'Synthetic read failed', mutationState: 'not_applied' as const };
  };
  const first = await new IntentExecutor().run(workflow, {}, ctx, tool);
  expect(first.suspended).toBe(true);
  const second = await new IntentExecutor().run(workflow, {}, ctx, tool, {
    stepIndex: first.suspendedAt!,
    stepResults: first.stepResults!,
    userAnswer: 'yes',
  });
  expect(second.success).toBe(false);
  expect(second.mutationEvidence).toBe(mutationState === 'confirmed' ? 'applied' : 'unknown');
  expect(writes).toBe(1);
});
