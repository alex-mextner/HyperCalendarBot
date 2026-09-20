import { expect, test } from 'bun:test';
import { createToolExposure } from '../../../src/services/ai/tool-exposure.ts';
import { getToolDefinitions } from '../../../src/services/ai/tools.ts';

const allowed = getToolDefinitions('text');
test('new schemas do not authorize another call in the same model batch', () => {
  const s = createToolExposure(allowed);
  const original = s.snapshot();
  expect(s.intercept('discover_tools', { groups: ['calendar.write'], tools: [] }, original)?.success).toBe(true);
  expect(s.intercept('update_event', { event_id: 1 }, original)?.success).toBe(false);
  expect(s.intercept('update_event', { event_id: 1 }, s.snapshot())).toBeUndefined();
});
test('schema and index fidelity survive caller mutations', () => {
  const original = structuredClone(allowed);
  const s = createToolExposure(original);
  const before = s.prompt;
  original.length = 0;
  s.intercept('discover_tools', { groups: [], tools: ['calculate'] }, s.snapshot());
  const schemas = s.schemas();
  const canonical = allowed.find((t) => t.type === 'function' && t.function.name === 'calculate');
  expect(schemas[1]).toEqual(canonical);
  schemas.length = 0;
  expect(s.schemas()).toHaveLength(2);
  expect(s.prompt).toBe(before);
  expect(s.prompt).toContain('delete_event:');
  expect(s.prompt).toContain('calculate:');
});
test('unknown tool cannot become executable', () => {
  const s = createToolExposure(allowed);
  const result = s.intercept('discover_tools', { groups: [], tools: ['not_a_tool'] }, s.snapshot());
  expect(result?.output).toContain('not_a_tool');
  expect(s.intercept('not_a_tool', {}, s.snapshot())?.success).toBe(false);
});
test('discovery returns names, not a second copy of full parameter schemas', () => {
  const s = createToolExposure(allowed);
  const r = s.intercept('discover_tools', { groups: ['calendar.read'], tools: ['calculate'] }, s.snapshot());
  expect(r?.success).toBe(true);
  expect(r?.output).toContain('get_events');
  expect(r?.output).not.toContain('properties');
  expect(r?.output).not.toContain('description');
});
test('bounded discovery never evicts already disclosed schemas', () => {
  const s = createToolExposure(allowed);
  for (let i = 0; i < 6; i++)
    expect(s.intercept('discover_tools', { groups: [], tools: ['calculate'] }, s.snapshot())?.success).toBe(true);
  expect(s.intercept('discover_tools', { groups: [], tools: ['get_event'] }, s.snapshot())?.success).toBe(false);
  expect(s.intercept('calculate', {}, s.snapshot())).toBeUndefined();
});
test('mode-specific tools are not advertised or activated', () => {
  const voice = createToolExposure(getToolDefinitions('live_call'));
  expect(voice.prompt).not.toContain('render_day_image:');
  expect(voice.intercept('render_day_image', {}, voice.snapshot())?.success).toBe(false);
  const supplement = createToolExposure(getToolDefinitions('text', true));
  expect(supplement.prompt).toContain('supplement_skip:');
  expect(supplement.prompt).not.toContain('end_conversation:');
});
test('invalid discovery input does not activate anything', () => {
  const s = createToolExposure(allowed);
  for (const input of [
    null,
    { groups: 'calendar.read' },
    { tools: [], extra: true },
    { tools: Array(25).fill('get_event') },
  ])
    expect(s.intercept('discover_tools', input, s.snapshot())?.success).toBe(false);
  expect(s.schemas()).toHaveLength(1);
});

test('discovery accepts groups alone, defaulting tools to empty (reproduces GH-285 incident payload)', () => {
  const s = createToolExposure(allowed);
  const result = s.intercept('discover_tools', { groups: ['contacts'] }, s.snapshot());
  expect(result?.success).toBe(true);
  expect(result?.output).toContain('find_user');
  expect(s.intercept('find_user', { username: 'ghost_handle' }, s.snapshot())?.success).toBeUndefined();
});

test('discovery accepts tools alone, defaulting groups to empty (reproduces GH-285 incident payload)', () => {
  const s = createToolExposure(allowed);
  const result = s.intercept('discover_tools', { tools: ['find_user'] }, s.snapshot());
  expect(result?.success).toBe(true);
  expect(result?.output).toContain('find_user');
});

test('discovery with neither array present is a harmless no-op, not a schema-compliant trap', () => {
  const s = createToolExposure(allowed);
  const result = s.intercept('discover_tools', {}, s.snapshot());
  expect(result?.success).toBe(true);
  expect(result?.output).toContain('"activated":[]');
  expect(s.schemas()).toHaveLength(1);
});
