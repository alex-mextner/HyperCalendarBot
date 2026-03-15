import { describe, expect, test } from 'bun:test';
import { getTemplate } from '../../../src/worker/templates/index.ts';
import type { ImageType } from '../../../src/worker/templates/types.ts';

describe('getTemplate', () => {
  test('returns daily-agenda template', () => {
    const t = getTemplate('daily-agenda');
    expect(typeof t.render).toBe('function');
  });

  test('returns weekly-overview template', () => {
    const t = getTemplate('weekly-overview');
    expect(typeof t.render).toBe('function');
  });

  test('returns event-card template', () => {
    const t = getTemplate('event-card');
    expect(typeof t.render).toBe('function');
  });

  test('throws on unknown type', () => {
    expect(() => getTemplate('unknown' as unknown as ImageType)).toThrow();
  });
});
