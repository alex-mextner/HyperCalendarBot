import { describe, expect, test } from 'bun:test';
import { estimateTokens } from '../../../src/services/ai/token-estimate.ts';

describe('estimateTokens', () => {
  test('empty string costs nothing', () => {
    expect(estimateTokens('')).toBe(0);
  });

  test('ASCII prose lands near the calibrated 3.5 chars-per-token rate', () => {
    const text = 'a'.repeat(3500);
    expect(estimateTokens(text)).toBeGreaterThanOrEqual(900);
    expect(estimateTokens(text)).toBeLessThanOrEqual(1100);
  });

  test('Cyrillic costs more tokens per character than ASCII', () => {
    const cyrillic = 'событие'.repeat(100);
    const ascii = 'a'.repeat(cyrillic.length);
    expect(estimateTokens(cyrillic)).toBeGreaterThan(estimateTokens(ascii));
  });

  test('emoji cost more tokens per character than Cyrillic', () => {
    // Compared per code point — an emoji occupies two UTF-16 units but is one character.
    const emoji = '📍'.repeat(50);
    const cyrillic = 'я'.repeat(50);
    expect(estimateTokens(emoji)).toBeGreaterThan(estimateTokens(cyrillic));
  });

  test('concatenation is additive within one token of rounding', () => {
    const a = 'the quick brown fox jumps over the lazy dog';
    const b = 'ленивая рыжая лиса перепрыгнула через собаку';
    const joined = estimateTokens(a + b);
    const parts = estimateTokens(a) + estimateTokens(b);
    expect(Math.abs(joined - parts)).toBeLessThanOrEqual(2);
  });

  test('estimates the live tool payload close to what Groq reported for it', () => {
    // Groq's own TPM accounting reported ~7 750 tokens for the 41 759-char tool
    // catalog. Harmony renders tool schemas more compactly than raw JSON, so the
    // estimate is expected to sit above that but in the same order of magnitude.
    const estimate = estimateTokens('x'.repeat(41_759));
    expect(estimate).toBeGreaterThan(7_000);
    expect(estimate).toBeLessThan(14_000);
  });
});
