import { describe, expect, test } from 'bun:test';
import { toolCallKey } from '../../../src/services/ai/agent.ts';

describe('toolCallKey', () => {
  test('same params in different order produce same key', () => {
    const key1 = toolCallKey('search_events', { query: 'вечерняя прогулка', scope: 'group' });
    const key2 = toolCallKey('search_events', { scope: 'group', query: 'вечерняя прогулка' });
    expect(key1).toBe(key2);
  });

  test('null/undefined params are stripped (same as absent)', () => {
    const key1 = toolCallKey('search_events', { query: 'test', scope: 'group' });
    const key2 = toolCallKey('search_events', { query: 'test', scope: 'group', start_date: null });
    const key3 = toolCallKey('search_events', { query: 'test', scope: 'group', start_date: undefined });
    expect(key1).toBe(key2);
    expect(key1).toBe(key3);
  });

  test('different values produce different keys', () => {
    const key1 = toolCallKey('search_events', { query: 'утренняя' });
    const key2 = toolCallKey('search_events', { query: 'вечерняя' });
    expect(key1).not.toBe(key2);
  });

  test('different tool names produce different keys', () => {
    const key1 = toolCallKey('get_events', { start_date: '2026-01-01' });
    const key2 = toolCallKey('search_events', { start_date: '2026-01-01' });
    expect(key1).not.toBe(key2);
  });

  test('extra keys not in schema are stripped', () => {
    // _nonce or other injected keys should not break dedup
    const key1 = toolCallKey('search_events', { query: 'test' });
    const key2 = toolCallKey('search_events', { query: 'test', _nonce: 12345 });
    expect(key1).toBe(key2);
  });

  test('nested objects are sorted recursively', () => {
    const key1 = toolCallKey('create_event', { title: 'X', start_at: '2026-01-01T10:00:00Z' });
    const key2 = toolCallKey('create_event', { start_at: '2026-01-01T10:00:00Z', title: 'X' });
    expect(key1).toBe(key2);
  });
});

test('canonical numeric ID strings share the numeric dedup key', () => {
  expect(toolCallKey('delete_event', { event_id: '123' })).toBe(toolCallKey('delete_event', { event_id: 123 }));
  expect(toolCallKey('send_invitation', { event_id: '123', invitee_id: '456' })).toBe(
    toolCallKey('send_invitation', { event_id: 123, invitee_id: 456 }),
  );
});
