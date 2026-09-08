import { describe, expect, test } from 'bun:test';
import { clampTimeoutMs, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from '../../packages/agent-macos/src/timeout-clamp.ts';

// dispatcher.test.ts calls mock.module() on bash.ts and applescript.ts, which replaces
// them in bun's process-global module registry for every test file loaded afterward
// (see the identical caution in test/services/ai/streaming-failover.test.ts). A plain
// static import here would silently receive dispatcher.test.ts's mocked stdout/exitCode
// instead of spawning a real process, defeating this regression test. A uniquely
// queried dynamic import bypasses that poisoned registry entry and loads the real module.
const { bashExecute } = await import('../../packages/agent-macos/src/actions/bash.ts?timeout-clamp-real');
const { applescriptRun } = await import('../../packages/agent-macos/src/actions/applescript.ts?timeout-clamp-real');

describe('clampTimeoutMs', () => {
  test('passes an in-range value through unchanged', () => {
    expect(clampTimeoutMs(15_000, 60_000)).toBe(15_000);
  });

  test('returns the fallback for undefined', () => {
    expect(clampTimeoutMs(undefined, 60_000)).toBe(60_000);
  });

  test('returns the fallback for NaN', () => {
    expect(clampTimeoutMs(Number.NaN, 60_000)).toBe(60_000);
  });

  test('returns the fallback for Infinity', () => {
    expect(clampTimeoutMs(Number.POSITIVE_INFINITY, 60_000)).toBe(60_000);
  });

  test('clamps a value below MIN_TIMEOUT_MS up to MIN_TIMEOUT_MS', () => {
    expect(clampTimeoutMs(-5, 60_000)).toBe(MIN_TIMEOUT_MS);
  });

  test('clamps a value above MAX_TIMEOUT_MS down to MAX_TIMEOUT_MS', () => {
    expect(clampTimeoutMs(Number.MAX_SAFE_INTEGER, 60_000)).toBe(MAX_TIMEOUT_MS);
  });
});

describe('bashExecute timeout clamp regression', () => {
  test('an oversized timeout_ms does not kill a short-lived process early', async () => {
    const result = await bashExecute('sleep 0.05 && echo done', Number.MAX_SAFE_INTEGER);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('done');
  });
});

const hasOsascript = Bun.which('osascript') !== null;

describe('applescriptRun timeout clamp regression', () => {
  test.skipIf(!hasOsascript)('an oversized timeout_ms does not kill a short-lived script early', async () => {
    const result = await applescriptRun('delay 0.05', Number.MAX_SAFE_INTEGER);
    expect(result.exitCode).toBe(0);
  });
});
