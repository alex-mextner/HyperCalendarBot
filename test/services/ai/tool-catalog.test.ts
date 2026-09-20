import { describe, expect, test } from 'bun:test';
import { createToolCatalog } from '../../../src/services/ai/tool-catalog.ts';
import { getToolDefinitions } from '../../../src/services/ai/tools.ts';

const names = (tools: ReturnType<typeof getToolDefinitions>) =>
  tools.flatMap((t) => (t.type === 'function' ? [t.function.name] : []));

describe('capability-scoped batched tool discovery', () => {
  test('calculate is exposed under explicit calculator group, not interaction', () => {
    const index = createToolCatalog(getToolDefinitions('text')).index();
    const calculator = index.split('[calculator]\n')[1]?.split('\n[')[0] ?? '';
    const interaction = index.split('[interaction]\n')[1]?.split('\n[')[0] ?? '';
    expect(calculator).toContain('calculate:');
    expect(interaction).not.toContain('calculate:');
  });

  test('compact index contains names and short descriptions, not parameter schemas', () => {
    const catalog = createToolCatalog(getToolDefinitions('text'));
    const index = catalog.index();
    expect(index).toContain('calendar.read');
    expect(index).toContain('get_events');
    expect(index).not.toContain('input_schema');
    expect(index).not.toContain('properties');
    expect(index.length).toBeLessThan(9000);
  });
  test('loads a union of multiple groups and explicit names without duplicates', () => {
    const catalog = createToolCatalog(getToolDefinitions('text'));
    const result = catalog.describe({
      groups: ['calendar.read', 'contacts'],
      tools: ['get_events', 'calculate', 'calculate'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(names(result.tools)).toContain('get_events');
    expect(names(result.tools)).toContain('get_contacts');
    expect(names(result.tools)).toContain('calculate');
    expect(names(result.tools).filter((n) => n === 'get_events')).toHaveLength(1);
    expect(names(result.tools)).not.toContain('delete_event');
    expect(result.deferred).toEqual([]);
  });
  test('returns the canonical full schema without losing required arguments', () => {
    const tools = getToolDefinitions('text');
    const result = createToolCatalog(tools).describe({ tools: ['get_events'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tools[0]).toEqual(tools.find((t) => t.type === 'function' && t.function.name === 'get_events'));
  });
  test('does not expose unavailable assistant or live-call capabilities', () => {
    const catalog = createToolCatalog(getToolDefinitions('live_call'));
    expect(catalog.index()).not.toContain('bash_execute');
    expect(catalog.index()).not.toContain('render_day_image');
    const result = catalog.describe({
      groups: ['assistant'],
      tools: ['bash_execute', 'render_day_image', 'made_up_tool'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tools).toEqual([]);
    expect(result.unavailable).toHaveLength(4);
  });
  test('preserves supplement exclusions and newly added allowed tools', () => {
    const catalog = createToolCatalog(getToolDefinitions('text', true));
    expect(catalog.index()).toContain('supplement_skip');
    expect(catalog.index()).not.toContain('end_conversation');
  });
  test.each([
    null,
    { tools: 'get_events' },
    { tools: [''] },
    { groups: ['calendar.read'], execute: true },
    { tools: Array(25).fill('get_events') },
  ])('rejects malformed or unbounded requests: %j', (request) => {
    expect(createToolCatalog(getToolDefinitions()).describe(request).ok).toBe(false);
  });
  test('accepts an empty selector as a legal no-op reveal', () => {
    const result = createToolCatalog(getToolDefinitions()).describe({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tools).toEqual([]);
  });
  test('bounds expansion, gives explicit names priority and reports deferred schemas', () => {
    const catalog = createToolCatalog(getToolDefinitions(), { maxTools: 2, maxSchemaChars: 16000 });
    const result = catalog.describe({ groups: ['calendar.read'], tools: ['calculate'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tools).toHaveLength(2);
    expect(names(result.tools)[0]).toBe('calculate');
    expect(result.deferred.length).toBeGreaterThan(0);
    expect(result.schemaChars).toBeLessThanOrEqual(16000);
  });
  test('oversized schema does not prevent smaller requested schemas from fitting', () => {
    const catalog = createToolCatalog(getToolDefinitions(), { maxTools: 10, maxSchemaChars: 600 });
    const result = catalog.describe({ tools: ['create_event', 'get_bot_info'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deferred).toContain('create_event');
    expect(names(result.tools)).toContain('get_bot_info');
    expect(JSON.stringify(result.tools).length).toBe(result.schemaChars);
  });
  test('returned data cannot poison canonical schemas or the next request', () => {
    const source = getToolDefinitions();
    const before = JSON.stringify(source);
    const catalog = createToolCatalog(source);
    const first = catalog.describe({ tools: ['get_events'] });
    if (!first.ok || first.tools[0]?.type !== 'function') throw new Error('fixture');
    first.tools[0].function.name = 'poison';
    first.tools[0].function.parameters = {};
    const second = catalog.describe({ tools: ['get_events'] });
    expect(second.ok && names(second.tools)).toEqual(['get_events']);
    expect(JSON.stringify(source)).toBe(before);
  });
  test('rejects duplicate or blank catalog names and invalid constructor budgets', () => {
    const tools = getToolDefinitions();
    expect(() => createToolCatalog([tools[0]!, tools[0]!])).toThrow();
    expect(() => createToolCatalog([{ type: 'function', function: { name: ' ', parameters: {} } }])).toThrow();
    for (const maxTools of [0, -1, NaN, Infinity, 1.5, 10000])
      expect(() => createToolCatalog(tools, { maxTools })).toThrow();
  });
  test('rejects oversized raw arrays before reading their elements', () => {
    let reads = 0;
    const tools = Array(1000).fill('get_events');
    Object.defineProperty(tools, 999, {
      get() {
        reads++;
        return 'get_events';
      },
    });
    expect(createToolCatalog(getToolDefinitions()).describe({ tools }).ok).toBe(false);
    expect(reads).toBe(0);
  });
  test('rejects whitespace-padded raw names before trimming', () => {
    expect(createToolCatalog(getToolDefinitions()).describe({ tools: [`${' '.repeat(100000)}get_events`] }).ok).toBe(
      false,
    );
  });
  test('round-trips every canonical schema across mode variants', () => {
    for (const mode of ['text', 'live_call'] as const)
      for (const supplement of [false, true]) {
        const tools = getToolDefinitions(mode, supplement);
        const catalog = createToolCatalog(tools);
        expect(catalog.index()).not.toContain('[other]');
        for (const tool of tools) {
          if (tool.type !== 'function') throw new Error('fixture');
          const result = catalog.describe({ tools: [tool.function.name] });
          expect(result.ok && result.tools).toEqual([tool]);
        }
      }
  });
  test('interleaved catalogs never share mutable nested input', () => {
    const tools = getToolDefinitions('text');
    const firstCatalog = createToolCatalog(tools);
    const secondCatalog = createToolCatalog(getToolDefinitions('live_call'));
    const before = firstCatalog.describe({ tools: ['get_events'] });
    const first = tools[0]!;
    if (first.type !== 'function') throw new Error('fixture');
    first.function.parameters = { injected: true };
    const returned = firstCatalog.describe({ tools: ['get_events'] });
    if (!returned.ok || returned.tools[0]?.type !== 'function') throw new Error('fixture');
    returned.tools[0].function.parameters!.required = ['injected'];
    expect(firstCatalog.describe({ tools: ['get_events'] })).toEqual(before);
    expect(secondCatalog.index()).not.toContain('render_day_image');
    const denied = secondCatalog.describe({ tools: ['render_day_image'] });
    expect(denied.ok && denied.tools).toEqual([]);
  });
  test('a newly authorized unknown tool is discoverable under other without granting anything else', () => {
    const future = {
      type: 'function' as const,
      function: {
        name: 'future_allowed_tool',
        description: 'Synthetic future capability.',
        parameters: { type: 'object', properties: {} },
      },
    };
    const catalog = createToolCatalog([future]);
    expect(catalog.index()).toContain('[other]');
    const result = catalog.describe({ groups: ['other'] });
    expect(result.ok && result.tools).toEqual([future]);
    expect(catalog.index()).not.toContain('get_events');
  });
});
