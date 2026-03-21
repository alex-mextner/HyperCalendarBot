import { describe, expect, test } from 'bun:test';
import { generatePairingCode } from '../../packages/agent-macos/src/pairing.ts';

describe('generatePairingCode', () => {
  test('returns 8 hex characters', () => {
    const code = generatePairingCode();
    expect(code).toMatch(/^[0-9a-f]{8}$/);
  });

  test('returns unique codes', () => {
    const codes = new Set(Array.from({ length: 100 }, generatePairingCode));
    expect(codes.size).toBe(100);
  });
});
