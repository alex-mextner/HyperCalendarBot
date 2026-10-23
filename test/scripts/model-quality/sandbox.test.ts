import { expect, test } from 'bun:test';
import type { Args } from '../../../scripts/model-quality/core.ts';
import { BASE_EVENT, fixtures } from '../../../scripts/model-quality/fixtures.ts';
import { createSandbox, promptFor, tools } from '../../../scripts/model-quality/sandbox.ts';

const sample = fixtures.find((f) => f.id === 'terse-create')!;
test('real calculator returns actual timezone conversion', () => {
  const s = createSandbox(sample);
  const r = s.execute('calculate', { expression: '2026-11-05 13:00 Europe/Belgrade to UTC' });
  expect(r.result).toMatchObject({ success: true, output: '2026-11-05T12:00:00.000Z' });
});
test('unknown tool cannot fake successful execution', () =>
  expect(createSandbox(sample).execute('invented_tool', {}).call.success).toBe(false));
test('real schema refuses missing event timestamp', () =>
  expect(createSandbox(sample).execute('create_event', { title: 'Test' }).call.success).toBe(false));
test('business state is private per fixture', () => {
  const a = createSandbox({ ...sample, events: [BASE_EVENT] });
  a.execute('create_event', { title: 'New', start_at: '2026-09-28T10:00:00Z' });
  expect(a.events.length).toBe(2);
  expect(createSandbox({ ...sample, events: [BASE_EVENT] }).events.length).toBe(1);
});
test('all expected tools exist in actual production catalog', () => {
  const names = tools.flatMap((t) => (t.type === 'function' ? [t.function.name] : []));
  for (const f of fixtures) for (const r of f.required) expect(names.includes(r.name)).toBe(true);
});
test('production prompt clock is replaced exactly once', () => {
  const p = promptFor(sample);
  expect(p.match(/Current local time:/g)?.length).toBe(1);
  expect(p).toContain('2026-09-27 Sun 10:00');
});
test('fixture does not send original secret-bearing corpus', () => {
  expect(JSON.stringify(fixtures)).not.toMatch(/https?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\+\d{10,}/i);
});
test('sandbox uses the real schema-normalized numeric ID', () => {
  const f = fixtures.find((x) => x.id === 'delete-confirmed')!;
  const result = createSandbox(f).execute('delete_event', { event_id: '101' });
  expect(result.call.success).toBe(true);
  expect(result.call.args.event_id).toBe(101);
});
test('mutation classification covers all current production tools', async () => {
  const { isMutationTool } = await import('../../../src/services/ai/tool-executor.ts');
  const { isWrite } = await import('../../../scripts/model-quality/core.ts');
  for (const tool of tools) {
    if (tool.type !== 'function') continue;
    const inputs: Args[] = [{}, { action: 'get' }, { action: 'update' }];
    for (const args of inputs)
      expect(isWrite({ name: tool.function.name, args })).toBe(isMutationTool(tool.function.name, args));
  }
});
