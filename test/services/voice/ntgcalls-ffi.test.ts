import { describe, expect, test } from 'bun:test';
import {
  NtgCalls,
  getNtgCallsLoadError,
  isNtgCallsAvailable,
} from '../../../src/services/voice/ntgcalls-ffi';

describe('NtgCalls FFI', () => {
  test('isNtgCallsAvailable returns boolean', () => {
    const available = isNtgCallsAvailable();
    expect(typeof available).toBe('boolean');
  });

  test('calling isNtgCallsAvailable twice returns same result', () => {
    const first = isNtgCallsAvailable();
    const second = isNtgCallsAvailable();
    expect(first).toBe(second);
  });

  test('getNtgCallsLoadError returns string or null', () => {
    const error = getNtgCallsLoadError();
    if (error !== null) {
      expect(typeof error).toBe('string');
      expect(error.length).toBeGreaterThan(0);
    }
  });

  test('when library is missing, isNtgCallsAvailable returns false gracefully', () => {
    // If the library is not downloaded, this must not throw
    const available = isNtgCallsAvailable();
    if (!available) {
      const error = getNtgCallsLoadError();
      expect(error).not.toBeNull();
      expect(error).toContain('ntgcalls');
    }
  });

  test('NtgCalls constructor throws when library unavailable', () => {
    if (isNtgCallsAvailable()) return; // skip when lib is present
    expect(() => new NtgCalls()).toThrow('ntgcalls');
  });

  // Only run lifecycle tests when the binary is present
  const describeIfAvailable = isNtgCallsAvailable() ? describe : describe.skip;

  describeIfAvailable('with library loaded', () => {
    test('init creates instance', () => {
      const ntg = new NtgCalls();
      expect(ntg).toBeDefined();
      expect(ntg.isDestroyed()).toBe(false);
      expect(ntg.getHandle()).toBeTruthy();
      ntg.destroy();
    });

    test('destroy marks instance as destroyed', () => {
      const ntg = new NtgCalls();
      expect(ntg.isDestroyed()).toBe(false);
      ntg.destroy();
      expect(ntg.isDestroyed()).toBe(true);
    });

    test('double destroy is safe', () => {
      const ntg = new NtgCalls();
      ntg.destroy();
      expect(() => ntg.destroy()).not.toThrow();
    });

    test('getHandle throws after destroy', () => {
      const ntg = new NtgCalls();
      ntg.destroy();
      expect(() => ntg.getHandle()).toThrow('already destroyed');
    });

    test('multiple instances are independent', () => {
      const a = new NtgCalls();
      const b = new NtgCalls();
      expect(a.getHandle()).not.toBe(b.getHandle());
      a.destroy();
      expect(b.isDestroyed()).toBe(false);
      b.destroy();
    });
  });
});
