import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { AiDebugLogger } from '../../../src/services/ai/debug-logger.ts';

describe('AiDebugLogger', () => {
  test('createRunContext returns null when disabled', () => {
    const logger = new AiDebugLogger(false, '/tmp');
    const ctx = logger.createRunContext(1, 100, 'user', 'First', null, false, 'hello');
    expect(ctx).toBeNull();
  });

  test('createRunContext returns context when enabled', () => {
    const logger = new AiDebugLogger(true, '/tmp');
    const ctx = logger.createRunContext(1, 100, 'user', 'First', null, false, 'hello');
    expect(ctx).not.toBeNull();
  });

  test('same session file returned for subsequent calls within timeout', () => {
    const dir = mkdtempSync(`${tmpdir()}/dbg-`);
    try {
      const logger = new AiDebugLogger(true, dir);
      const ctx1 = logger.createRunContext(1, 400, 'u', 'U', null, false, 'msg1');
      const ctx2 = logger.createRunContext(1, 400, 'u', 'U', null, false, 'msg2');
      // Flush both — they should land in the same file
      ctx1?.flush();
      ctx2?.flush();
      // Both had the same session → same file → two separator blocks in one file
      const files = readdirSync(`${dir}/chats/400`);
      expect(files.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('endSession removes the session so the next createRunContext starts a fresh session', () => {
    const dir = mkdtempSync(`${tmpdir()}/dbg-`);
    try {
      const logger = new AiDebugLogger(true, dir);
      const ctx1 = logger.createRunContext(1, 200, 'u', 'U', null, false, 'msg1');
      ctx1?.flush();
      // endSession clears the entry — must not throw
      expect(() => logger.endSession(200)).not.toThrow();
      // After endSession, a new createRunContext must still succeed (fresh session starts)
      const ctx2 = logger.createRunContext(1, 200, 'u', 'U', null, false, 'msg2');
      expect(ctx2).not.toBeNull();
      expect(() => ctx2?.flush()).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('flush writes content to file including header fields', () => {
    const dir = mkdtempSync(`${tmpdir()}/dbg-`);
    try {
      const logger = new AiDebugLogger(true, dir);
      const ctx = logger.createRunContext(42, 500, 'alice', 'Alice', 'My Group', false, 'test message');
      ctx?.logSystemPrompt('System: be helpful');
      ctx?.logRound(0);
      ctx?.logToolCall('get_events', { start_date: '2026-01-01' });
      ctx?.logToolResult('get_events', true, 'No events');
      ctx?.logAiText('You have no events.');
      ctx?.logFinal('You have no events.', 1);
      ctx?.flush();

      const files = readdirSync(`${dir}/chats/500`);
      expect(files.length).toBe(1);
      const content = readFileSync(`${dir}/chats/500/${files[0]}`, 'utf8');
      expect(content).toContain('uid:42');
      expect(content).toContain('@alice');
      expect(content).toContain('My Group');
      expect(content).toContain('test message');
      expect(content).toContain('System: be helpful');
      expect(content).toContain('TOOL CALL: get_events');
      expect(content).toContain('TOOL RESULT: get_events → OK');
      expect(content).toContain('You have no events.');
      expect(content).toContain('Tools called: 1');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('supplement auto-response is shown in header when supplementMode=true', () => {
    const dir = mkdtempSync(`${tmpdir()}/dbg-`);
    try {
      const logger = new AiDebugLogger(true, dir);
      const ctx = logger.createRunContext(1, 600, 'u', 'U', null, true, 'ok', 'Auto: Event created!');
      ctx?.logFinal('', 0);
      ctx?.flush();

      const files = readdirSync(`${dir}/chats/600`);
      const content = readFileSync(`${dir}/chats/600/${files[0]}`, 'utf8');
      expect(content).toContain('AUTO-RESPONSE');
      expect(content).toContain('Auto: Event created!');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('flush does not throw when log directory does not exist', () => {
    const logger = new AiDebugLogger(true, '/nonexistent/path/that/does/not/exist');
    const ctx = logger.createRunContext(1, 300, 'u', 'U', null, false, 'test');
    expect(() => ctx?.flush()).not.toThrow();
  });
});
