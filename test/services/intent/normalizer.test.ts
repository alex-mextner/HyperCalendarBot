import { describe, expect, test } from 'bun:test';
import { normalize, normalizeWithOffsets, tokenize } from '../../../src/services/intent/normalizer.ts';

describe('normalize', () => {
  test('lowercases and trims', () => {
    expect(normalize('  Hello World  ')).toBe('hello world');
  });

  test('strips punctuation', () => {
    expect(normalize('Что Сегодня?!')).toBe('что сегодня');
    expect(normalize('Hello, World.')).toBe('hello world');
    expect(normalize('«привет»')).toBe('привет');
  });

  test('collapses whitespace', () => {
    expect(normalize('hello   world')).toBe('hello world');
  });

  test('handles empty string', () => {
    expect(normalize('')).toBe('');
  });
});

describe('tokenize', () => {
  test('splits normalized text into word set', () => {
    const result = tokenize('найди встречу с доктором');
    expect(result).toEqual(new Set(['найди', 'встречу', 'с', 'доктором']));
  });

  test('returns empty set for empty string', () => {
    expect(tokenize('')).toEqual(new Set());
  });
});

test('offset normalization stays equivalent for contextual lowercase and Unicode spans', () => {
  for (const text of ['ΟΣ', 'ΟΣ ΣΟΣ', 'İstanbul 19:30', '  🔔 Node.js — завтра\nв 10:00  ', '«ПЛАН»', 'А\t\tБ']) {
    const mapped = normalizeWithOffsets(text);
    expect(mapped.text).toBe(normalize(text));
    expect(mapped.spans.length).toBe(mapped.text.length);
    for (const span of mapped.spans) {
      expect(span.start).toBeGreaterThanOrEqual(0);
      expect(span.end).toBeLessThanOrEqual(text.length);
      expect(span.end).toBeGreaterThan(span.start);
    }
  }
});
