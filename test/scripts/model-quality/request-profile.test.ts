import { expect, test } from 'bun:test';
import { createRequestCatalog } from '../../../scripts/model-quality/request-profile.ts';
import { tools } from '../../../scripts/model-quality/sandbox.ts';

test('lazy catalog keeps all names and starts with real calculator', () => {
  const catalog = createRequestCatalog('lazy', tools);
  expect(catalog.prompt).toContain('send_invitation');
  expect(catalog.prompt).toContain('get_events');
  expect(catalog.schemas().some((t) => t.type === 'function' && t.function.name === 'calculate')).toBe(true);
  expect(catalog.schemas().some((t) => t.type === 'function' && t.function.name === 'create_event')).toBe(false);
});
test('full mode has no oracle-specific hidden tool filtering', () =>
  expect(createRequestCatalog('full', tools).schemas()).toEqual(tools));
