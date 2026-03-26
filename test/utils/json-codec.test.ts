import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { jsonCodec } from '../../src/utils/json-codec.ts';

describe('jsonCodec', () => {
  const NumberArrayCodec = jsonCodec(z.array(z.number()));

  test('parse decodes valid JSON string to typed value', () => {
    expect(NumberArrayCodec.parse('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  test('parse throws ZodError on invalid JSON', () => {
    expect(() => NumberArrayCodec.parse('not json')).toThrow();
  });

  test('parse throws ZodError when JSON is valid but schema mismatches', () => {
    expect(() => NumberArrayCodec.parse('{"a": 1}')).toThrow();
  });

  test('safeParse returns success for valid input', () => {
    const result = NumberArrayCodec.safeParse('[10, 20]');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual([10, 20]);
    }
  });

  test('safeParse returns error for invalid JSON', () => {
    const result = NumberArrayCodec.safeParse('}{');
    expect(result.success).toBe(false);
  });

  test('safeParse returns error for schema mismatch', () => {
    const result = NumberArrayCodec.safeParse('["a", "b"]');
    expect(result.success).toBe(false);
  });

  test('works with object schemas', () => {
    const codec = jsonCodec(z.object({ id: z.number(), name: z.string() }));
    const data = codec.parse('{"id": 42, "name": "test"}');
    expect(data).toEqual({ id: 42, name: 'test' });
  });

  test('works with nested schemas', () => {
    const codec = jsonCodec(z.object({ items: z.array(z.object({ v: z.number() })) }));
    const data = codec.parse('{"items": [{"v": 1}, {"v": 2}]}');
    expect(data).toEqual({ items: [{ v: 1 }, { v: 2 }] });
  });

  test('empty string is invalid JSON', () => {
    const result = NumberArrayCodec.safeParse('');
    expect(result.success).toBe(false);
  });

  test('empty array is valid', () => {
    expect(NumberArrayCodec.parse('[]')).toEqual([]);
  });
});
